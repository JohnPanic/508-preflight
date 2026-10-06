process.env.PLAYWRIGHT_BROWSERS_PATH ||= require('node:path').join(__dirname, '.pw-browsers');
const { launchBrowser } = require('./browser-runtime');
const axe = require('axe-core');
const { resolveTarget, protectContext } = require('./network-policy');
const { createEgressProxy } = require('./egress-proxy');

async function publicUrl(value) {
  return (await resolveTarget(value)).url.href;
}

async function scan(url) {
  const proxy = await createEgressProxy();
  let browser;
  let timer;
  try {
    browser = await launchBrowser({ args: ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    return await Promise.race([
      (async () => {
        const context = await browser.newContext({ serviceWorkers: 'block', proxy: { server: proxy.server } });
        const network = await protectContext(context);
        const page = await context.newPage();
        context.on('page', extra => { if (extra !== page) extra.close().catch(() => {}); });
        context.setDefaultTimeout(10000);
        const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        if (response && response.status() >= 400) throw new Error(`Page returned HTTP ${response.status()}.`);
        await page.waitForTimeout(1000);
        network.check();
        proxy.check();
        if (await page.evaluate(() => document.getElementsByTagName('*').length > 50000)) throw new Error('Page exceeds the DOM resource limit.');
        await page.addScriptTag({ content: axe.source });
        const results = await page.evaluate(() => window.axe.run());
        network.check();
        proxy.check();
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
  } finally { clearTimeout(timer); try { await browser?.close(); } finally { await proxy.close(); } }
}
module.exports = { publicUrl, scan };
