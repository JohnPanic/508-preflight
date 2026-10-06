const { chromium } = require('playwright');
async function launchBrowser(options = {}) {
  const server = await chromium.launchServer({ headless: true, timeout: 15000, chromiumSandbox: process.platform === 'linux', host: '127.0.0.1', ...options });
  try {
    // Track Chromium separately so an unexpected Node-worker exit can still
    // clean up its browser tree. Never expose the control endpoint to clients.
    if (process.send) await new Promise((resolve, reject) => process.send({ browserPid: server.process().pid }, error => error ? reject(error) : resolve()));
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: 10000 });
    const disconnect = browser.close.bind(browser);
    browser.close = async () => { try { await disconnect(); } finally { await server.close(); } };
    return browser;
  } catch (error) { await server.close(); throw error; }
}
module.exports = { launchBrowser };
