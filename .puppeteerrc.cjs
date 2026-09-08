/** @type {import('puppeteer').Configuration} */
module.exports = {
  // Visible Chrome only — skip unused browser downloads that break `npm ci`
  // when a previous attempt left a half-written cache.
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chrome-headless-shell': {
    skipDownload: true,
  },
};
