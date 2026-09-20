'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');

const EXPORT_DIR = path.join(__dirname, 'export');
const CHATS_DIR = path.join(EXPORT_DIR, 'chats');
const GROUPS_CSV = path.join(EXPORT_DIR, 'groups.csv');
const GROUPS_MD = path.join(EXPORT_DIR, 'groups.md');
const GROUPS_TXT = path.join(EXPORT_DIR, 'groups.txt');
const CONTACTS_CSV = path.join(EXPORT_DIR, 'contacts.csv');
const CHAT_SUMMARY_CSV = path.join(EXPORT_DIR, 'chat_summary.csv');
const PROGRESS_JSON = path.join(EXPORT_DIR, 'progress.json');

const UTF8_BOM = '\uFEFF';
const FETCH_LIMIT = 60;
const FETCH_KEEP = 50;
const FETCH_TIMEOUT_MS = 20_000;
const TIMEOUT_COOLDOWN_MS = 10_000;
const SHORT_CHAT_THRESHOLD = 20;

const DROP_TYPES = new Set([
  'notification',
  'gp2',
  'group_notification',
  'e2e_notification',
  'protocol',
  'ciphertext',
  'revoked',
  'call_log',
  'debug',
]);

const GROUP_CSV_HEADERS = [
  'group_name',
  'group_id',
  'description',
  'created_utc',
  'member_count',
  'participants_loaded',
  'group_kind',
  'self_status',
  'admin_count',
  'admins',
  'invite_link',
  'invite_note',
  'last_activity_utc',
  'error',
];

const CONTACT_CSV_HEADERS = [
  'display_name',
  'push_name',
  'phone',
  'contact_id',
];

const SUMMARY_CSV_HEADERS = [
  'chat_id',
  'name',
  'type',
  'last_activity_utc',
  'messages_exported',
  'participants_loaded',
  'self_status',
  'seen_this_run',
  'error',
];

const CACHE_WARMING_CHECKLIST = `Before we export, load your chats into this browser window.
Do all of this in the Chrome window this script just opened:

  1. Keep the phone unlocked, on Wi-Fi, WhatsApp in the foreground,
     for the first few minutes so the linked session finishes syncing.
  2. Scroll the left-hand chat list all the way down. Slowly. Then again.
  3. Open Archived and scroll that list too. Archived groups are the ones
     most likely to be missing.
  4. Open Communities and click into each community and subgroup.
  5. Search for any group you remember that still isn't listed
     (try "school", "football", a friend's name). Opening a result loads it.
  6. Click into every group you want to rejoin, even briefly. This is the
     important one: admin lists are usually empty until the group is opened.
  7. Only for chats whose history really matters: open and scroll up a few times.

Not worth doing: leaving the window idle, using a second WhatsApp Web tab,
or looking for a "download all history" button — Web has none.`;

const ADD_ME_BACK_MESSAGE =
  'Hi, I have had to set up a new WhatsApp account on the same number. Please could you add me back to this group? Thank you.';

class TimeoutError extends Error {
  constructor(ms) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
  }
}

const SYSTEM_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let shuttingDown = false;
let stopReason = null;
let exitCode = 0;

function resolvePuppeteerOptions() {
  const puppeteerOpts = { headless: false };
  let bundledOk = false;
  try {
    const bundled = require('puppeteer').executablePath();
    const frameworksDir = path.join(path.dirname(bundled), '..', 'Frameworks');
    bundledOk =
      fs.existsSync(bundled) &&
      (process.platform !== 'darwin' || fs.existsSync(frameworksDir));
  } catch (_) {
    bundledOk = false;
  }
  if (!bundledOk && fs.existsSync(SYSTEM_CHROME)) {
    console.log(
      'Bundled Chromium is missing or incomplete; using system Chrome instead.',
    );
    puppeteerOpts.executablePath = SYSTEM_CHROME;
  }
  return puppeteerOpts;
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: resolvePuppeteerOptions(),
});

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(fields) {
  return fields.map(csvEscape).join(',');
}

function parseCsv(content) {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    if (c === '\r') continue;
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ''));
}

function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeCsvFile(filePath, headers, rows) {
  const lines = [csvRow(headers), ...rows.map((r) => csvRow(r))];
  writeFileAtomic(filePath, UTF8_BOM + lines.join('\n') + '\n');
}

function writeJsonAtomic(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + '\n');
}

function sanitiseName(name) {
  let s = String(name || '');
  s = s.replace(/[/\\:*?"<>|]/g, '');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[.\s]+$/g, '');
  if (s.length > 50) s = s.slice(0, 50).replace(/[.\s]+$/g, '');
  return s || 'unnamed';
}

function chatFilename(chat) {
  const prefix = chat.isGroup ? 'GROUP_' : 'DIRECT_';
  return `${prefix}${sanitiseName(chat.name)}_${chat.id.user}.txt`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredSleep(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function prompt(question) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return String(answer || '').trim();
  } finally {
    rl.close();
  }
}

function throwIfStopped() {
  if (!stopReason) return;
  const err = new Error(stopReason);
  err.exitCode = exitCode;
  throw err;
}

function isNewsletter(chat) {
  return Boolean(chat && chat.id && chat.id.server === 'newsletter');
}

function unixToIso(ts) {
  if (ts == null || ts === '') return '';
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

function createdAtIso(chat) {
  const created = chat.createdAt;
  return Number.isFinite(created?.getTime()) ? created.toISOString() : '';
}

function serialisedPnToPhone(pn) {
  if (!pn) return '';
  const user = String(pn).split('@')[0].trim();
  if (!user) return '';
  return user.startsWith('+') ? user : `+${user}`;
}

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function phase2Estimate(chatCount) {
  const minutes = Math.round((chatCount * 4) / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes === 1) return 'about 1 minute';
  return `about ${minutes} minutes`;
}

function ensureExportDirs() {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
}

function loadContactsMap() {
  const map = new Map();
  if (!fs.existsSync(CONTACTS_CSV)) return map;
  const rows = parseCsv(fs.readFileSync(CONTACTS_CSV, 'utf8'));
  if (rows.length < 2) return map;
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const row of rows.slice(1)) {
    const contactId = row[idx.contact_id] || '';
    if (!contactId) continue;
    map.set(contactId, {
      display_name: row[idx.display_name] || '',
      push_name: row[idx.push_name] || '',
      phone: row[idx.phone] || '',
      contact_id: contactId,
    });
  }
  return map;
}

function writeContactsCsv(contactMap) {
  const rows = [...contactMap.values()]
    .sort((a, b) => {
      const nameCmp = String(a.display_name).localeCompare(String(b.display_name));
      return nameCmp !== 0 ? nameCmp : String(a.contact_id).localeCompare(String(b.contact_id));
    })
    .map((c) => [c.display_name, c.push_name, c.phone, c.contact_id]);
  writeCsvFile(CONTACTS_CSV, CONTACT_CSV_HEADERS, rows);
}

function loadSummaryMap() {
  const map = new Map();
  if (!fs.existsSync(CHAT_SUMMARY_CSV)) return map;
  const rows = parseCsv(fs.readFileSync(CHAT_SUMMARY_CSV, 'utf8'));
  if (rows.length < 2) return map;
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const row of rows.slice(1)) {
    const chatId = row[idx.chat_id] || '';
    if (!chatId) continue;
    map.set(chatId, {
      chat_id: chatId,
      name: row[idx.name] || '',
      type: row[idx.type] || '',
      last_activity_utc: row[idx.last_activity_utc] || '',
      messages_exported: row[idx.messages_exported] || '0',
      participants_loaded: row[idx.participants_loaded] || '',
      self_status: row[idx.self_status] || '',
      seen_this_run: 'no',
      error: row[idx.error] || '',
    });
  }
  return map;
}

function writeSummaryCsv(summaryMap) {
  const rows = [...summaryMap.values()].map((r) => [
    r.chat_id,
    r.name,
    r.type,
    r.last_activity_utc,
    r.messages_exported,
    r.participants_loaded,
    r.self_status,
    r.seen_this_run,
    r.error,
  ]);
  writeCsvFile(CHAT_SUMMARY_CSV, SUMMARY_CSV_HEADERS, rows);
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_JSON)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(PROGRESS_JSON, 'utf8'));
    const ids = Array.isArray(raw) ? raw : raw.completed || [];
    return new Set(ids.filter(Boolean));
  } catch (err) {
    console.warn(
      `Could not read progress.json (${errorText(err)}). Phase 2 will re-export chats.`,
    );
    return new Set();
  }
}

function writeProgress(completed) {
  writeJsonAtomic(PROGRESS_JSON, { completed: [...completed] });
}

function formatPerson(entry) {
  const name = (entry && entry.display_name) || 'unknown';
  if (entry && entry.phone) return `${name} <${entry.phone}>`;
  return name;
}

function classifyGroup(chat, participants) {
  const meta = chat.groupMetadata;
  const isAnnouncement = meta?.announce === true;
  const isSubgroup = Boolean(meta?.parentGroupId);
  let groupKind = 'normal';
  if (isAnnouncement) groupKind = 'announcement';
  else if (isSubgroup) groupKind = 'community-subgroup';

  let participantsLoaded;
  if (isAnnouncement || isSubgroup) {
    participantsLoaded = participants.length > 0 ? 'yes' : 'restricted';
  } else {
    participantsLoaded = participants.length > 0 ? 'yes' : 'no';
  }
  return { groupKind, participantsLoaded };
}

function computeSelfStatus(participants, selfUser, participantsLoaded) {
  if (participantsLoaded !== 'yes') return 'unknown';
  const self = participants.find((p) => p.id && p.id.user === selfUser);
  if (!self) return 'self-not-found';
  const admins = participants.filter((p) => p.isAdmin || p.isSuperAdmin);
  const selfIsAdmin = self.isAdmin || self.isSuperAdmin;
  if (!selfIsAdmin) return 'member';
  return admins.length === 1 ? 'sole-admin' : 'admin';
}

async function resolveContacts(client, ids, contactMap) {
  const unique = [];
  const seen = new Set();
  for (const id of ids) {
    if (!id) continue;
    const serialized = typeof id === 'string' ? id : id._serialized;
    if (!serialized || contactMap.has(serialized) || seen.has(serialized)) continue;
    seen.add(serialized);
    unique.push(
      typeof id === 'string'
        ? { _serialized: id, user: id.split('@')[0] }
        : id,
    );
  }
  if (!unique.length) return false;

  let pairs = [];
  try {
    pairs = (await client.getContactLidAndPhone(unique.map((id) => id._serialized))) || [];
  } catch (err) {
    console.warn(`  Contact phone lookup failed: ${errorText(err)}`);
    pairs = [];
  }

  const pnBySerialized = new Map();
  unique.forEach((id, i) => {
    const pair = pairs[i];
    if (!pair) return;
    if (pair.pn) pnBySerialized.set(id._serialized, pair.pn);
    if (pair.lid && pair.pn) pnBySerialized.set(pair.lid, pair.pn);
    if (pair.pn) pnBySerialized.set(pair.pn, pair.pn);
  });

  for (const id of unique) {
    let contact = null;
    try {
      contact = await client.getContactById(id._serialized);
    } catch (_) {
      contact = null;
    }

    const pn = pnBySerialized.get(id._serialized) || '';
    let phone = serialisedPnToPhone(pn);
    if (!phone && contact && contact.number) {
      const lidContact = contact.id && contact.id.server === 'lid';
      if (!lidContact) phone = serialisedPnToPhone(contact.number);
    }

    const pushname = contact && contact.pushname ? String(contact.pushname) : '';
    const name = contact && contact.name ? String(contact.name) : '';
    const user =
      id.user ||
      (contact && contact.id && contact.id.user) ||
      id._serialized.split('@')[0] ||
      '';
    const display = pushname || name || user || '';

    contactMap.set(id._serialized, {
      display_name: display,
      push_name: pushname,
      phone: phone || '',
      contact_id: id._serialized,
    });
  }
  return true;
}

function mdEscapeHeading(name) {
  return String(name || 'Unnamed group').replace(/\s+/g, ' ').trim();
}

function adminNamesOnly(admins) {
  if (!admins) return 'none captured';
  const names = String(admins)
    .split(';')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      const withPhone = trimmed.match(/^(.*)\s<[^>]+>$/);
      return (withPhone ? withPhone[1] : trimmed).trim();
    })
    .filter(Boolean);
  return names.length ? names.join(', ') : 'none captured';
}

function plainInviteLine(record) {
  if (record.invite_link) return `Invite link: ${record.invite_link}`;
  if (record.invite_note) return `Invite link: ${record.invite_note}`;
  return 'Invite link: none';
}

function plainDescription(record) {
  const description = String(record.description || '').replace(/\s+/g, ' ').trim();
  return description || 'none';
}

function writeGroupsTxt(records) {
  if (!records.length) {
    writeFileAtomic(GROUPS_TXT, 'No groups found yet.\n');
    return;
  }

  const blocks = records.map((r) => {
    const name = mdEscapeHeading(r.group_name);
    const underline = '='.repeat(Math.max([...name].length, 4));
    return [
      name,
      underline,
      plainInviteLine(r),
      `Your status: ${r.self_status}`,
      `Admins: ${adminNamesOnly(r.admins)}`,
      `Description: ${plainDescription(r)}`,
    ].join('\n');
  });

  writeFileAtomic(GROUPS_TXT, `${blocks.join('\n\n')}\n`);
}

function writeGroupsOutputs(records) {
  const rows = records.map((r) => [
    r.group_name,
    r.group_id,
    r.description,
    r.created_utc,
    r.member_count,
    r.participants_loaded,
    r.group_kind,
    r.self_status,
    r.admin_count,
    r.admins,
    r.invite_link,
    r.invite_note,
    r.last_activity_utc,
    r.error,
  ]);
  writeCsvFile(GROUPS_CSV, GROUP_CSV_HEADERS, rows);

  const notLoaded = records.filter(
    (r) => r.group_kind === 'normal' && r.participants_loaded === 'no',
  );
  const restricted = records.filter((r) => r.participants_loaded === 'restricted');
  const soleAdmin = records.filter((r) => r.self_status === 'sole-admin');
  const selfNotFound = records.filter((r) => r.self_status === 'self-not-found');

  const lines = [];
  lines.push('# WhatsApp group rejoin playbook');
  lines.push('');
  lines.push(`## Total groups: **${records.length}**`);
  lines.push('');
  lines.push(
    'Check this number against what you remember **before deleting the account**.',
  );
  lines.push('');

  lines.push('## Participants not loaded');
  lines.push('');
  if (notLoaded.length) {
    lines.push(
      'These ordinary groups have no member list, so we captured no admins. Open each one in the WhatsApp Web window this script opened, then run the script again:',
    );
    lines.push('');
    for (const r of notLoaded) lines.push(`- ${mdEscapeHeading(r.group_name)}`);
  } else {
    lines.push('None.');
  }
  lines.push('');

  lines.push('## Community announcement (member list restricted)');
  lines.push('');
  if (restricted.length) {
    lines.push(
      'These groups restrict the member list by design. We cannot capture admins from them, and opening them will not fix that:',
    );
    lines.push('');
    for (const r of restricted) {
      lines.push(`- ${mdEscapeHeading(r.group_name)} (${r.group_kind})`);
    }
  } else {
    lines.push('None.');
  }
  lines.push('');

  lines.push('## You are the only admin');
  lines.push('');
  if (soleAdmin.length) {
    lines.push(
      'Appoint another admin in the phone app **before deleting the account**, or these groups will be left with nobody in charge:',
    );
    lines.push('');
    for (const r of soleAdmin) lines.push(`- ${mdEscapeHeading(r.group_name)}`);
  } else {
    lines.push('None.');
  }
  lines.push('');

  if (selfNotFound.length) {
    lines.push('## Admin status could not be determined');
    lines.push('');
    lines.push(
      'We could not match this account in the member list. That is **not** the same as “not an admin”. Do not delete until this is resolved:',
    );
    lines.push('');
    for (const r of selfNotFound) lines.push(`- ${mdEscapeHeading(r.group_name)}`);
    lines.push('');
  }

  lines.push('## Message to send admins');
  lines.push('');
  lines.push('Copy and paste:');
  lines.push('');
  lines.push(`> ${ADD_ME_BACK_MESSAGE}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Groups');
  lines.push('');

  if (!records.length) {
    lines.push('_No groups found yet._');
    lines.push('');
  }

  for (const r of records) {
    lines.push(`### ${mdEscapeHeading(r.group_name)}`);
    lines.push('');
    lines.push(`- **ID:** ${r.group_id}`);
    lines.push(`- **Kind:** ${r.group_kind}`);
    lines.push(`- **Created (UTC):** ${r.created_utc || 'unknown'}`);
    lines.push(`- **Last activity (UTC):** ${r.last_activity_utc || 'unknown'}`);
    lines.push(`- **Your status:** ${r.self_status}`);
    lines.push(`- **Participants loaded:** ${r.participants_loaded}`);
    lines.push(`- **Member count (from this session):** ${r.member_count}`);
    if (r.description) {
      lines.push(`- **Description:** ${String(r.description).replace(/\n/g, ' ')}`);
    } else {
      lines.push('- **Description:** _(none)_');
    }
    lines.push(`- **Admins:** ${r.admins || '_(none captured)_'}`);
    if (r.invite_link) lines.push(`- **Invite link:** ${r.invite_link}`);
    else lines.push(`- **Invite:** ${r.invite_note || '_(none)_'}`);
    if (r.error) lines.push(`- **Error:** ${r.error}`);
    lines.push('');
  }

  writeFileAtomic(GROUPS_MD, lines.join('\n'));
  writeGroupsTxt(records);
}

function printPhase1Warnings(records) {
  const notLoaded = records.filter(
    (r) => r.group_kind === 'normal' && r.participants_loaded === 'no',
  );
  const soleAdmin = records.filter((r) => r.self_status === 'sole-admin');
  const selfNotFound = records.filter((r) => r.self_status === 'self-not-found');

  console.log('');
  if (notLoaded.length) {
    console.log(`⚠  PARTICIPANTS NOT LOADED (${notLoaded.length} groups)`);
    console.log('   These groups have no member list, so we captured no admins.');
    console.log('   Open each one in the WhatsApp Web window and run this script again:');
    for (const r of notLoaded) console.log(`     - ${r.group_name}`);
  } else {
    console.log('⚠  PARTICIPANTS NOT LOADED (none)');
  }

  console.log('');
  if (soleAdmin.length) {
    console.log(`⚠  YOU ARE THE ONLY ADMIN IN (${soleAdmin.length} groups)`);
    console.log('   Appoint another admin in the phone app BEFORE deleting the account,');
    console.log('   or these groups will be left with nobody in charge:');
    for (const r of soleAdmin) console.log(`     - ${r.group_name}`);
  } else {
    console.log('⚠  YOU ARE THE ONLY ADMIN IN (none)');
  }

  console.log('');
  if (selfNotFound.length) {
    console.log(`⚠  SELF NOT FOUND — admin status unknown (${selfNotFound.length} groups)`);
    console.log('   We could not match this account in the member list, so we do not');
    console.log('   know whether you are an admin. Do not delete until this is resolved:');
    for (const r of selfNotFound) console.log(`     - ${r.group_name}`);
  } else {
    console.log('⚠  SELF NOT FOUND — admin status unknown (none)');
  }
  console.log('');
}

function blankGroupRecord(chat) {
  return {
    group_name: chat.name || chat.id.user || '',
    group_id: chat.id._serialized,
    description: '',
    created_utc: '',
    member_count: '0',
    participants_loaded: 'no',
    group_kind: 'normal',
    self_status: 'unknown',
    admin_count: '0',
    admins: '',
    invite_link: '',
    invite_note: '',
    last_activity_utc: unixToIso(chat.timestamp),
    error: '',
  };
}

function toInviteLink(code) {
  if (!code) return '';
  const s = String(code).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://chat.whatsapp.com/${s}`;
}

async function processGroup(waClient, chat, contactMap, selfUser) {
  const record = blankGroupRecord(chat);
  try {
    const meta = chat.groupMetadata;
    let participants = meta ? chat.participants ?? [] : [];
    if (!Array.isArray(participants)) participants = [];
    const { groupKind, participantsLoaded } = classifyGroup(chat, participants);
    record.group_kind = groupKind;
    record.participants_loaded = participantsLoaded;
    record.member_count = String(participants.length);
    record.description = meta ? chat.description || '' : '';
    record.created_utc = meta ? createdAtIso(chat) : '';
    record.self_status = computeSelfStatus(participants, selfUser, participantsLoaded);

    const adminParticipants = participants.filter((p) => p.isAdmin || p.isSuperAdmin);
    record.admin_count = String(adminParticipants.length);

    const grew = await resolveContacts(
      waClient,
      adminParticipants.map((p) => p.id),
      contactMap,
    );
    if (grew) writeContactsCsv(contactMap);

    record.admins = adminParticipants
      .map((p) => formatPerson(contactMap.get(p.id._serialized)))
      .join('; ');

    if (record.self_status === 'admin' || record.self_status === 'sole-admin') {
      try {
        const code = await chat.getInviteCode();
        const link = toInviteLink(code);
        if (link) {
          record.invite_link = link;
          record.invite_note = '';
        } else {
          record.invite_link = '';
          record.invite_note = 'invite failed: empty response';
        }
      } catch (err) {
        record.invite_link = '';
        record.invite_note = `invite failed: ${errorText(err)}`;
      }
    } else {
      record.invite_link = '';
      record.invite_note = 'invite skipped (not admin)';
    }
  } catch (err) {
    record.error = errorText(err);
    console.error(`  ERROR ${record.group_name}: ${record.error}`);
  }
  return record;
}

async function exportGroups(waClient, chats, contactMap, selfUser) {
  const groups = chats.filter((c) => c.isGroup && !isNewsletter(c));
  const records = [];
  writeGroupsOutputs(records);

  console.log(`\nPhase 1: group roster (${groups.length} groups)`);
  for (let i = 0; i < groups.length; i++) {
    throwIfStopped();
    const chat = groups[i];
    process.stdout.write(`  [${i + 1}/${groups.length}] ${chat.name || chat.id.user} ... `);
    const record = await processGroup(waClient, chat, contactMap, selfUser);
    records.push(record);
    writeGroupsOutputs(records);
    console.log(
      `${record.self_status}, ${record.admin_count} admin(s)` +
        (record.error ? `, error: ${record.error}` : ''),
    );
    if (i < groups.length - 1) await jitteredSleep(1500, 3000);
  }

  printPhase1Warnings(records);
  console.log(
    'Phase 1 complete. The rejoin playbook is in export/groups.md and export/groups.txt — keep those even if Phase 2 fails.',
  );
  return records;
}

function messageSender(m, contactMap) {
  if (m.fromMe) return 'Me';
  const notify = m._data && m._data.notifyName;
  if (notify) return notify;
  const rawId = m.author || m.from || '';
  const entry = contactMap.get(rawId);
  if (entry && entry.display_name) return entry.display_name;
  return rawId || 'Unknown';
}

function messageBody(m) {
  if (m.hasMedia) {
    const caption = m.body ? ` ${m.body}` : '';
    return `[MEDIA: ${m.type}]${caption}`;
  }
  return m.body || '';
}

function formatMessageLine(m, contactMap) {
  const ts = unixToIso(m.timestamp) || 'unknown-time';
  return `[${ts}] ${messageSender(m, contactMap)}: ${messageBody(m)}`;
}

async function exportChats(waClient, chats, contactMap, groupRecords, summaryMap) {
  const targets = chats.filter((c) => !isNewsletter(c));
  const completed = loadProgress();
  const groupById = new Map(groupRecords.map((g) => [g.group_id, g]));
  let exported = 0;
  let skipped = 0;
  let failed = 0;
  let timedOutCount = 0;

  console.log(`\nPhase 2: recent messages (${targets.length} chats, ${completed.size} already done)`);

  for (let i = 0; i < targets.length; i++) {
    throwIfStopped();
    const chat = targets[i];
    const chatId = chat.id._serialized;
    const name = chat.name || chat.id.user || '';
    const type = chat.isGroup ? 'group' : 'direct';
    const groupMeta = groupById.get(chatId);
    const label = `${type === 'group' ? 'GROUP' : 'DIRECT'} ${name}`;

    const existing = summaryMap.get(chatId) || {};
    const baseRow = {
      chat_id: chatId,
      name,
      type,
      last_activity_utc: unixToIso(chat.timestamp),
      messages_exported: existing.messages_exported || '0',
      participants_loaded: chat.isGroup
        ? (groupMeta && groupMeta.participants_loaded) || existing.participants_loaded || 'no'
        : 'n/a',
      self_status: chat.isGroup
        ? (groupMeta && groupMeta.self_status) || existing.self_status || ''
        : '',
      seen_this_run: 'yes',
      error: existing.error || '',
    };

    if (completed.has(chatId)) {
      skipped += 1;
      summaryMap.set(chatId, baseRow);
      writeSummaryCsv(summaryMap);
      console.log(`  [${i + 1}/${targets.length}] ${label} — already exported, skipping`);
      continue;
    }

    process.stdout.write(`  [${i + 1}/${targets.length}] ${label} ... `);
    let messages = [];
    let timedOut = false;
    let fetchError = '';
    try {
      messages = await withTimeout(chat.fetchMessages({ limit: FETCH_LIMIT }), FETCH_TIMEOUT_MS);
    } catch (err) {
      if (err && err.code === 'TIMEOUT') {
        timedOut = true;
        timedOutCount += 1;
        fetchError = 'fetch timed out';
        messages = [];
      } else {
        fetchError = errorText(err);
        messages = [];
      }
    }

    if (!timedOut && !fetchError) {
      messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      messages = messages.filter((m) => !DROP_TYPES.has(m.type));
      messages = messages.slice(-FETCH_KEEP);

      const authorIds = [];
      for (const m of messages) {
        if (m.fromMe) continue;
        const rawId = m.author || m.from;
        if (rawId) authorIds.push(rawId);
      }
      const grew = await resolveContacts(waClient, authorIds, contactMap);
      if (grew) writeContactsCsv(contactMap);

      const text = messages.map((m) => formatMessageLine(m, contactMap)).join('\n');
      const outPath = path.join(CHATS_DIR, chatFilename(chat));
      fs.writeFileSync(outPath, text ? `${text}\n` : '', 'utf8');
    }

    const count = timedOut || fetchError ? 0 : messages.length;
    let error = fetchError;
    if (!error && count < SHORT_CHAT_THRESHOLD) {
      error = 'short (timed out, or not loaded in this session)';
    }

    baseRow.messages_exported = String(count);
    baseRow.error = error;
    summaryMap.set(chatId, baseRow);
    writeSummaryCsv(summaryMap);

    completed.add(chatId);
    writeProgress(completed);

    if (fetchError && timedOut) {
      failed += 1;
      console.log('timed out (0 messages)');
    } else if (fetchError) {
      failed += 1;
      console.log(`failed: ${fetchError}`);
    } else {
      exported += 1;
      console.log(`${count} messages`);
    }

    if (i < targets.length - 1) {
      if (timedOut) await sleep(TIMEOUT_COOLDOWN_MS);
      await jitteredSleep(1000, 2000);
    }
  }

  return { exported, skipped, failed, timedOutCount, total: targets.length };
}

async function getChatsWithRetry(waClient) {
  const delaysMs = [2000, 4000, 6000];
  let lastErr;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    throwIfStopped();
    try {
      return await waClient.getChats();
    } catch (err) {
      lastErr = err;
      const detail = errorText(err) || 'unknown WhatsApp Web error';
      console.error(`Could not read the chat list (${detail}).`);
      if (attempt < delaysMs.length) {
        console.error(
          `The session may still be syncing. Waiting ${delaysMs[attempt] / 1000}s and trying again...`,
        );
        await sleep(delaysMs[attempt]);
      }
    }
  }
  throw lastErr;
}

async function waitForWarmedChats(waClient) {
  console.log(`\n${CACHE_WARMING_CHECKLIST}\n`);
  await prompt(
    'Press Enter when the left-hand chat list is visible in that Chrome window. ',
  );

  while (true) {
    throwIfStopped();
    let chats;
    try {
      chats = await getChatsWithRetry(waClient);
    } catch (err) {
      console.error(`\nStill cannot read chats: ${errorText(err) || err}`);
      console.error(
        'Keep the phone unlocked with WhatsApp open. Press Enter to try counting again.',
      );
      await prompt('');
      continue;
    }
    const usable = chats.filter((c) => !isNewsletter(c));
    const groups = usable.filter((c) => c.isGroup).length;
    const direct = usable.length - groups;
    const estimate = phase2Estimate(usable.length);
    console.log(
      `\n${usable.length} chats (${groups} groups, ${direct} direct). Phase 2 would take ${estimate} (~4 seconds per chat).`,
    );
    const answer = await prompt(
      'Enter to start the export, or type "more" to go load more chats first. ',
    );
    if (answer.toLowerCase() === 'more') {
      await prompt(
        'OK — load more chats in that Chrome window, then press Enter to re-count. ',
      );
      continue;
    }
    return chats;
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  console.log(
    '\nClosing the browser. This does not unlink the device — do that later from the phone: Settings → Linked devices.',
  );
  try {
    await client.destroy();
  } catch (err) {
    console.error(`Error while closing the client: ${errorText(err)}`);
  }
  process.exit(code);
}

async function run() {
  ensureExportDirs();

  const wid = client.info && client.info.wid;
  if (!wid || !wid.user) {
    throw new Error(
      "Could not read this account's WhatsApp id (client.info.wid). Stopping — we cannot determine admin status without it.",
    );
  }
  const selfUser = wid.user;
  console.log(
    `\nLinked as ${wid._serialized} (matching groups on the user portion only: ${selfUser}).`,
  );

  const contactMap = loadContactsMap();
  if (contactMap.size) {
    console.log(`Seeded ${contactMap.size} contacts from export/contacts.csv.`);
  }
  const summaryMap = loadSummaryMap();

  const chats = await waitForWarmedChats(client);
  const groupRecords = await exportGroups(client, chats, contactMap, selfUser);

  let chatStats = { exported: 0, skipped: 0, failed: 0, timedOutCount: 0, total: 0 };
  try {
    chatStats = await exportChats(client, chats, contactMap, groupRecords, summaryMap);
  } catch (err) {
    console.error(
      `\nPhase 2 failed. Phase 1 results in export/groups.md, export/groups.txt and export/groups.csv are still valid.`,
    );
    throw err;
  }

  const groupFailures = groupRecords.filter((r) => r.error).length;
  const notLoaded = groupRecords.filter(
    (r) => r.group_kind === 'normal' && r.participants_loaded === 'no',
  ).length;
  console.log('\n========== EXPORT COMPLETE ==========');
  console.log(`Groups found:            ${groupRecords.length}`);
  console.log(`Groups with errors:      ${groupFailures}`);
  console.log(`Participants not loaded: ${notLoaded}`);
  console.log(`Chats exported this run: ${chatStats.exported}`);
  console.log(`Chats skipped (resume):  ${chatStats.skipped}`);
  console.log(`Chats failed:            ${chatStats.failed}`);
  console.log('Review export/groups.md, export/groups.txt, export/groups.csv and export/chat_summary.csv before deleting the account.');
  console.log('=====================================\n');

  await shutdown(0);
}

client.on('qr', (qr) => {
  console.log(
    "Scan this QR code on the phone: Settings → Linked devices → Link a device\n",
  );
  qrcode.generate(qr, { small: true });
});

let runStarted = false;

client.on('ready', () => {
  if (runStarted) return;
  runStarted = true;
  console.log('WhatsApp Web is ready.');
  run().catch(async (err) => {
    if (shuttingDown) return;
    const code = err && err.exitCode ? err.exitCode : 1;
    if (code === 2) {
      console.error(`\nStopped: ${errorText(err)}`);
      console.error(
        'Wait a few minutes and rerun. Phase 1 will rewrite the group roster; Phase 2 resumes from export/progress.json.',
      );
    } else {
      console.error(`\nFatal error: ${errorText(err)}`);
      if (err && err.stack) console.error(err.stack);
    }
    await shutdown(code);
  });
});

client.on('auth_failure', async (msg) => {
  if (shuttingDown) return;
  stopReason = `Authentication failed: ${msg || 'unknown reason'}`;
  exitCode = 2;
  console.error(`\n${stopReason}`);
  console.error(
    'Wait a few minutes and rerun. Phase 1 will rewrite the group roster; Phase 2 resumes from export/progress.json.',
  );
  await shutdown(2);
});

client.on('disconnected', async (reason) => {
  if (shuttingDown) return;
  stopReason = `Disconnected: ${reason || 'unknown reason'}`;
  exitCode = 2;
  console.error(`\n${stopReason}`);
  console.error(
    'The linked session dropped. Wait a few minutes and rerun. Phase 1 will rewrite the group roster; Phase 2 resumes from export/progress.json.',
  );
  await shutdown(2);
});

process.on('SIGINT', async () => {
  if (shuttingDown) return;
  console.error('\nInterrupted.');
  await shutdown(1);
});

process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  console.error('\nTerminated.');
  await shutdown(1);
});

client.initialize().catch(async (err) => {
  const message = errorText(err);
  console.error(`Failed to start WhatsApp Web: ${message}`);
  if (/already running/i.test(message)) {
    console.error(
      'A Chrome window from a previous run is still open. Close that window (or quit that Chrome), then run: node export.js',
    );
  }
  await shutdown(1);
});
