require('../scanner');
const { chromium } = require('playwright');
const { buildReport } = require('../export-report');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  await fs.mkdir('tmp/pdfs', { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    let scans = 0;
    page.on('request', req => { if (req.url().endsWith('/api/preflight')) scans++; });
    await page.goto('http://localhost:3000');
    assert.equal(await page.getByRole('button', { name: 'Download Report' }).count(), 0);
    await page.getByLabel('Public webpage URL').fill('https://example.com');
    await page.getByRole('button', { name: 'Run Preflight' }).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Preflight complete.', null, { timeout: 65000 });
    const expected = await page.locator('.finding h3').allTextContents();
    const manualCount = await page.locator('.manual-checks article').count();
    async function download(format, name) {
      await page.getByLabel('Report format').selectOption(format);
      const waiting = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download Report' }).click();
      const file = await waiting;
      assert.match(file.suggestedFilename(), new RegExp(`^508-preflight-report-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
      await file.saveAs(`tmp/pdfs/${name}.${format}`);
      await page.waitForFunction(() => !document.querySelector('.export-controls button').disabled);
    }
    await download('html', 'live'); await download('pdf', 'live');
    assert.equal(scans, 1, 'exports must not rerun the scan');
    const offline = await browser.newContext({ offline: true });
    const view = await offline.newPage();
    await view.goto(`file:///${path.resolve('tmp/pdfs/live.html').replaceAll('\\', '/')}`);
    assert.deepEqual(await view.locator('.finding h3').allTextContents(), expected);
    assert.equal(await view.locator('.manual-checks article').count(), manualCount);
    assert.equal(await view.locator('script,img,iframe').count(), 0);
    await view.setViewportSize({ width: 390, height: 844 });
    assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await view.screenshot({ path: 'tmp/pdfs/offline.png', fullPage: true });
    await offline.close();
    await page.evaluate(() => {
      const node = { html: '<script>window.INJECTED=true</script><img src="https://evil.example/tracker" onerror="alert(1)">' + ' long-snippet'.repeat(1200), target: ['#test'], failureSummary: 'Original remediation', any: [{ message: 'Original manual guidance' }], all: [], none: [] };
      const findings = Array.from({ length: 20 }, (_, i) => ({ id: 'image-alt', impact: ['critical', 'serious', 'moderate', 'minor'][i % 4], help: `Original title ${i}`, description: 'Original description', tags: ['wcag2a', 'wcag111'], nodes: [node], helpUrl: 'https://dequeuniversity.com/' }));
      render({ url: 'https://fixture.example', scannedAt: '2026-10-06T12:00:00Z', axeVersion: 'fixture', issueCount: 20, affectedElementCount: 20, manualReviewCount: 5, violations: findings, incomplete: findings.slice(0, 5) });
    });
    await download('html', 'stress'); await download('pdf', 'stress');
    const stress = await browser.newPage();
    await stress.goto(`file:///${path.resolve('tmp/pdfs/stress.html').replaceAll('\\', '/')}`);
    assert.equal(await stress.locator('.finding').count(), 25);
    assert.equal(await stress.locator('script,img,iframe').count(), 0);
    assert.equal(await stress.evaluate(() => window.INJECTED), undefined);
    assert.equal(await stress.locator('pre').first().textContent(), await page.locator('pre').first().textContent());
    assert.throws(() => buildReport({ url: 'x', axeVersion: 'x', scannedAt: new Date().toISOString(), issueCount: 0, affectedElementCount: 0, manualReviewCount: 0, content: [{ tag: 'script', children: ['alert(1)'] }] }));
    console.log('Export checks passed: live PDF/HTML downloads, no rescans, offline mobile HTML, all findings and manual items, long snippets, escaped malicious markup.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
