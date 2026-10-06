const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicUrl } = require('../scanner');
const { chromium } = require('playwright');
const axe = require('axe-core');
test('reject non-public URLs and credentials', async () => {
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1', 'http://10.0.0.1', 'http://[::1]', 'http://169.254.169.254', 'https://user:pass@example.com', 'bad']) {
    await assert.rejects(publicUrl(url));
  }
});
test('axe finds known violations in a rendered page', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<html><head><title>Fixture</title></head><body><main><img src="data:image/png;base64,broken"><button></button></main></body></html>');
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(() => axe.run());
    assert.ok(result.violations.some(v => v.id === 'image-alt'));
    assert.ok(result.violations.some(v => v.id === 'button-name'));
    assert.ok(result.violations.every(v => v.nodes.length && v.helpUrl && v.description));
  } finally { await browser.close(); }
});
