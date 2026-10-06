require('../scanner');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:3000');
    await page.getByLabel('Public webpage URL').fill('https://example.com');
    await page.getByRole('button', { name: 'Run Preflight' }).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Preflight complete.', null, { timeout: 65000 });
    assert.ok(await page.locator('.finding').count());
    assert.ok(await page.getByText('Axe remediation guidance:', { exact: true }).count());
    assert.ok(await page.locator('.finding pre').count());
    const card = page.locator('.finding').first();
    for (const label of ['Why it matters', 'Affected elements', 'WCAG criterion', 'Suggested fix', 'Example affected element']) {
      assert.equal(await card.getByText(label, { exact: true }).isVisible(), true);
    }
    assert.equal(await card.locator('details').getAttribute('open'), null);
    assert.equal(await card.locator('pre').first().isVisible(), false);
    await card.getByText('Technical details', { exact: true }).click();
    assert.equal(await card.locator('pre').first().isVisible(), true);
    await card.getByText('Technical details', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Run Preflight' }).isEnabled(), true);
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.screenshot({ path: 'test-report.png', fullPage: true });
    await page.evaluate(() => render({ issueCount: 1, affectedElementCount: 1, manualReviewCount: 0, url: 'Fixture', scannedAt: new Date().toISOString(), axeVersion: 'fixture', violations: [{ id: 'image-alt', impact: 'serious', help: 'Images must have alternate text', description: 'Ensure images have alternate text', tags: ['wcag2a', 'wcag111'], helpUrl: 'https://dequeuniversity.com/', nodes: [{ html: '<img src="photo.jpg">', target: ['img'], failureSummary: 'Add alternative text.' }] }] }));
    assert.equal(await page.getByText('WCAG 1.1.1', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('heading', { name: 'An image needs a text alternative' }).isVisible(), true);
    await page.evaluate(() => {
      const rules = ['color-contrast', 'image-alt', 'link-name', 'button-name', 'label'].map(id => ({
        id, help: `Original axe title: ${id}`, description: 'Original axe description', tags: ['wcag2a', 'wcag111'], helpUrl: 'https://dequeuniversity.com/',
        nodes: [{ html: '<button>Example</button>', target: ['#original-selector'], any: [{ message: 'Original review message' }], all: [], none: [] }]
      }));
      render({ issueCount: 1, affectedElementCount: 1, manualReviewCount: 5, url: 'Fixture', scannedAt: new Date().toISOString(), axeVersion: 'fixture', violations: [{ ...rules[0], impact: 'minor' }], incomplete: rules });
    });
    const manual = page.locator('.manual-checks');
    assert.equal(await manual.locator('article').count(), 5);
    assert.equal(await manual.getByRole('heading', { name: 'Manual checks required (5)' }).isVisible(), true);
    assert.equal(await page.locator('#report > section').last().getAttribute('class'), 'manual-checks');
    assert.equal(await manual.getByText('Why it needs a human', { exact: true }).count(), 5);
    assert.equal(await manual.getByText('What to check', { exact: true }).count(), 5);
    assert.equal(await manual.locator('details[open]').count(), 0);
    const review = manual.locator('article').first();
    await review.getByText('Technical details', { exact: true }).click();
    assert.equal(await review.getByText('Original review message', { exact: true }).isVisible(), true);
    assert.equal(await review.getByText('Selector: #original-selector', { exact: true }).isVisible(), true);
    await page.getByLabel('Public webpage URL').fill('http://127.0.0.1');
    await page.getByRole('button', { name: 'Run Preflight' }).click();
    await page.waitForFunction(() => document.querySelector('#status').className === 'error');
    assert.match(await page.locator('#status').textContent(), /public internet/);
    assert.equal(await page.locator('#report').isVisible(), false);
    console.log('UI check passed: live scan, findings, recovery, private URL rejection, no browser errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

