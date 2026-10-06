const dns = require('node:dns/promises');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= require('node:path').join(__dirname, '.pw-browsers');
const { chromium } = require('playwright');
const axe = require('axe-core');
const ipaddr = require('ipaddr.js');

async function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid public HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use a public HTTP or HTTPS URL without embedded credentials.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
    throw new Error('Only public internet addresses can be scanned.');
  }
  return url.href;
}

async function scan(url) {
  const browser = await chromium.launch({ headless: true });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        await context.route('**/*', async route => {
          try { await publicUrl(route.request().url()); await route.continue(); }
          catch { await route.abort(); }
        });
        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        if (response && response.status() >= 400) throw new Error(`Page returned HTTP ${response.status()}.`);
        await page.waitForTimeout(1000);
        await page.addScriptTag({ content: axe.source });
        const results = await page.evaluate(() => window.axe.run());
        return {
          url: page.url(), scannedAt: new Date().toISOString(), axeVersion: results.testEngine.version,
          issueCount: results.violations.length,
          affectedElementCount: results.violations.reduce((n, v) => n + v.nodes.length, 0),
          manualReviewCount: results.incomplete.length, violations: results.violations,
          incomplete: results.incomplete
        };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Scan timed out after 60 seconds.')), 60000); })
    ]);
  } finally { clearTimeout(timer); await browser.close(); }
}
module.exports = { publicUrl, scan };
