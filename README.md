# WhatsApp readable backup

A one-shot exporter for a linked WhatsApp Web session. Run it **before deleting the old account**.

Deleting the account removes that person from every group. The new account starts empty even on the same number. This tool’s job is to capture what you need to **get back into those groups afterwards**: group names, who the admins are, their phone numbers, and any invite links. Recent chat text is a bonus, not the point.

## Requirements

- **Node 18 or newer**
- The **phone in hand**, unlocked, on Wi-Fi, with WhatsApp in the foreground
- This must be done **before** the old account is deleted

`npm ci` installs the Node libraries. The script drives the **Chrome already installed on this Mac** (it does not need Puppeteer's extra headless browser).

Do **not** count on WhatsApp’s own backups (Google Drive or otherwise) being available after deletion. This tool does not use them.

## Install and run

```bash
npm ci
node export.js
```

A Chrome window opens. Scan the QR code from the phone:

**Settings → Linked devices → Link a device**

The session is saved locally, so a crash or a rerun should not need a new scan.

## What you get (and what you don’t)

| Reliable | Best-effort |
| --- | --- |
| Group list, admin names and numbers, invite links, whether this account is an admin | About the last **50** user messages per chat |

Media is recorded as `[MEDIA: image] <caption>` rather than downloaded. Keep the caption — it is often the actual content.

All timestamps are **UTC** and end in `Z`.

## Before the export: warm the cache

WhatsApp Web only shows conversations this browser window has already loaded. A freshly linked session can miss most groups, and a group’s admin list is often empty until you open that group.

Do **all** of the following in the Chrome window the script opened (not a second tab):

```
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
or looking for a "download all history" button — Web has none.
```

## The count prompt

The script then prints something like `120 chats (40 groups, 80 direct)` plus how long Phase 2 would take.

- If the **group number looks low**, type `more`, open more groups in **that same Chrome window**, press Enter to re-count. No restart, no new QR.
- When the number looks right, press Enter to start the export.

## After the export, in this order

1. Review `export/groups.md`, `export/groups.csv` and `export/chat_summary.csv`. Open any ordinary group still flagged participants-not-loaded in WhatsApp Web, then rerun the script.
2. In the phone app, **transfer sole admin** on every group the script listed under the sole-admin warning.
3. Optional: use WhatsApp’s official **Export chat** (email/zip) for the handful of personal chats where 50 messages is not enough.
4. **Unlink** this session: Settings → Linked devices → log out. The script does not do this for you.
5. **Delete** the old account: Settings → Account → Delete account.
6. Create the parent-managed account. Rejoin via the invite links and admin numbers in `groups.csv`.

## Privacy

Do not commit, email, or cloud-sync `export/` or `.wwebjs_auth/`. They contain private messages and a live session token.

## Troubleshooting

- If the session logs out mid-run, wait a few minutes and rerun. Phase 1 rewrites the group list from scratch. Phase 2 skips chats already listed in `export/progress.json`.
- If the bundled Chromium download was skipped or incomplete, the script falls back to system Chrome automatically. You can also set `executablePath` yourself to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- If `ready` never fires with the bundled browser, that same system Chrome path is the next thing to try.
- If `npm ci` still fails on a `chrome-headless-shell` download, delete `~/.cache/puppeteer` and run `npm ci` again.
- If the script says it cannot read the chat list (`r`), stop it and rerun `node export.js`. A patch in this repo teaches the library about a WhatsApp Web id-field rename. After `npm ci`, `patch-package` reapplies it.
- Never `npm update` mid-project. This library scrapes WhatsApp Web internals and can break silently when WhatsApp renames fields. Install with `npm ci` only.
