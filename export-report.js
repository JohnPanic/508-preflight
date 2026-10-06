const { launchBrowser } = require('./browser-runtime');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tags = new Set(['section', 'article', 'aside', 'h2', 'h3', 'p', 'span', 'strong', 'details', 'summary', 'pre', 'a', 'div']);
function content(node, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 100000) throw new Error('Report content limit exceeded.');
  if (depth > 30) throw new Error('Report nesting is too deep.');
  if (typeof node === 'string') return escape(node);
  if (!node || !tags.has(node.tag) || !Array.isArray(node.children)) throw new Error('Invalid report content.');
  const classes = typeof node.className === 'string' ? node.className.split(/\s+/).filter(c => /^(finding|finding-field|meta|badge|severity-(critical|serious|moderate|minor|unspecified)|manual-checks|start-here)$/.test(c)).join(' ') : '';
  let attrs = classes ? ` class="${classes}"` : '';
  if (node.tag === 'details') attrs += ' open';
  if (node.tag === 'a' && typeof node.href === 'string' && /^https:\/\//.test(node.href)) attrs += ` href="${escape(node.href)}" rel="noopener noreferrer"`;
  return `<${node.tag}${attrs}>${node.children.map(n => content(n, depth + 1, budget)).join('')}</${node.tag}>`;
}
const css = `
*{box-sizing:border-box}body{margin:0;background:#fff;color:#17252b;font:15px/1.55 Arial,sans-serif}main{max-width:900px;margin:40px auto;padding:0 28px}h1{font-size:28px;line-height:1.2}h2{font-size:21px;margin:28px 0 12px}h3{font-size:17px;line-height:1.35;margin:8px 0 14px}p{overflow-wrap:anywhere}header{border-bottom:2px solid #234d5c;padding-bottom:18px}.metadata p{margin:5px 0}.notice,.start-here{background:#edf3f5;border-left:3px solid #386272;padding:12px 16px;margin:20px 0}.start-here h2{font-size:16px;margin:0}.start-here p{margin:6px 0}.finding{border:1px solid #cbd4d9;border-radius:6px;padding:18px;margin:14px 0;break-inside:avoid}.finding-field strong{display:block;font-size:13px}.finding-field span{display:block}.badge{display:inline-block;padding:3px 8px;border:1px solid #aab9c2;border-radius:4px;font-size:12px}.severity-critical,.severity-serious{background:#fff0ef;color:#8b2520}.severity-moderate{background:#fff6e6;color:#76500b}.severity-minor{background:#eef3f5;color:#234d5c}.meta{font-size:13px;color:#48565d}details{border-top:1px solid #cbd4d9;margin-top:18px;padding-top:12px}summary{font-weight:bold;cursor:pointer}pre{font:11px/1.5 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;background:#f3f5f6;padding:10px;break-inside:auto}a{color:#18536d;overflow-wrap:anywhere}h2,h3,summary,strong{break-after:avoid}p{orphans:3;widows:3}footer{margin-top:24px;border-top:1px solid #cbd4d9;padding-top:12px;font-size:12px}
@media(max-width:600px){main{margin:20px auto;padding:0 16px}h1{font-size:24px}}
@media print{main{max-width:none;margin:0;padding:0}body{font-size:10pt}h1{font-size:22pt}h2{font-size:15pt}h3{font-size:12pt}.finding{padding:12px}.meta{font-size:9pt}details::details-content{display:block!important}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
const printFixes = '<style>@media print{.finding.long-finding{break-inside:auto}.manual-checks>p{break-after:avoid}.finding details>p,.finding details>a{break-inside:avoid}details>a{display:block;break-before:avoid}footer{break-inside:avoid}}</style>';
function buildReport(payload) {
  if (!payload || typeof payload.url !== 'string' || typeof payload.axeVersion !== 'string' || !Array.isArray(payload.content)) throw new Error('Invalid report.');
  const date = new Date(payload.scannedAt);
  const budget = { nodes: 0 };
  if (Buffer.byteLength(JSON.stringify(payload)) > 20 * 1024 * 1024) throw new Error('Report size limit exceeded.');
  if (Number.isNaN(date.getTime())) throw new Error('Invalid scan date.');
  if (payload.url.length > 2048 || payload.axeVersion.length > 100 || (payload.scanTime && (typeof payload.scanTime !== 'string' || payload.scanTime.length > 200))) throw new Error('Invalid report metadata.');
  for (const key of ['issueCount', 'affectedElementCount', 'manualReviewCount']) if (!Number.isSafeInteger(payload[key]) || payload[key] < 0) throw new Error('Invalid report count.');
  const disclaimer = '508 Preflight provides automated accessibility findings and identifies items requiring human review. It does not certify Section 508 or WCAG compliance.';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>508 Preflight — Accessibility Report</title><style>${css}</style></head><body><main><header><h1>508 Preflight — Accessibility Report</h1><div class="metadata"><p><strong>Scanned URL:</strong> ${escape(payload.url)}</p><p><strong>Scan date and time:</strong> ${escape(payload.scanTime || date.toISOString())}</p><p><strong>axe-core version:</strong> ${escape(payload.axeVersion)}</p><p><strong>Total issues found:</strong> ${payload.issueCount}</p><p><strong>Total affected element occurrences:</strong> ${payload.affectedElementCount}</p><p><strong>Manual-review rules:</strong> ${payload.manualReviewCount}</p></div></header><p class="notice">${disclaimer}</p>${payload.content.map(n => content(n, 0, budget)).join('')}<footer>${disclaimer}</footer></main></body></html>`;
  if (Buffer.byteLength(html) > 40 * 1024 * 1024) throw new Error('Report size limit exceeded.');
  return { html: html.replace('</head>', `${printFixes}</head>`), filename: `508-preflight-report-${date.toISOString().slice(0, 10)}` };
}
async function reportPdf(html) {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { timeout: 15000 });
    // PDF-only presentation. Move original technical nodes without rewriting them.
    await page.evaluate(() => {
      const main = document.querySelector('main');
      const appendix = document.createElement('section');
      appendix.className = 'technical-appendix';
      const title = document.createElement('h2');
      title.textContent = 'Appendix A — Complete technical evidence';
      appendix.append(title);
      const intro = document.createElement('p');
      intro.textContent = 'Original axe rule information and every affected element are preserved below. Match each entry to its reference in the main report.';
      appendix.append(intro);
      let automated = 0, manual = 0;
      document.querySelectorAll('.finding').forEach(card => {
        const ref = card.closest('.manual-checks') ? `M${++manual}` : `F${++automated}`;
        const entry = document.createElement('article');
        entry.className = 'evidence-entry'; entry.id = `evidence-${ref}`;
        const heading = document.createElement('h3');
        heading.textContent = `${ref} — ${card.querySelector('h3').textContent}`;
        entry.append(heading, card.querySelector('.badge').cloneNode(true));
        const details = card.querySelector('details');
        if (details) {
          let evidenceElement = null;
          [...details.children].filter(node => node.localName !== 'summary').forEach(node => {
            if (node.localName === 'p' && node.textContent.startsWith('Selector: ')) {
              evidenceElement = document.createElement('div');
              evidenceElement.className = 'evidence-element'; entry.append(evidenceElement);
            }
            (evidenceElement || entry).append(node);
          });
          details.remove();
        }
        const reference = document.createElement('p'); reference.className = 'evidence-reference';
        const link = document.createElement('a'); link.href = `#evidence-${ref}`;
        link.textContent = `Technical evidence: ${ref} (Appendix A)`;
        reference.append(link); card.append(reference); appendix.append(entry);
      });
      main.insertBefore(appendix, main.querySelector('footer'));
      [...main.children].forEach(node => {
        if (node.matches('.meta') || (node.localName === 'h2' && /issues? found$/.test(node.textContent))) node.remove();
      });
      const style = document.createElement('style');
      style.textContent = `@media print {
        body{font-size:9.5pt;line-height:1.4}header{padding-bottom:10px}h1{font-size:20pt;margin:0 0 12px}
        h2{font-size:14pt;margin:20px 0 8px}h3{font-size:11pt;margin:5px 0 9px}
        .notice,.start-here{margin:12px 0;padding:10px 12px}
        .finding{padding:12px;margin:10px 0;break-inside:avoid}
        .finding-field{margin:7px 0;break-inside:avoid}
        .finding-field strong{display:inline;font-size:9pt}.finding-field strong::after{content:': '}.finding-field span{display:inline}
        .evidence-reference{font-size:8.5pt;margin:9px 0 0}
        .technical-appendix{break-before:auto;border-top:2px solid #234d5c;margin-top:24px;padding-top:8px}
        .technical-appendix>p{break-after:avoid}
        .appendix-lead{break-inside:avoid}
        .evidence-entry{border-top:1px solid #cbd4d9;padding-top:10px;margin-top:18px;break-inside:auto}
        .evidence-entry p{margin:7px 0}.evidence-entry .badge{break-after:avoid}
        .evidence-entry .meta{font-size:8.5pt;break-after:avoid}
        .evidence-entry pre{font-size:8pt;line-height:1.4;margin:7px 0;padding:8px}
        .evidence-entry>a{display:block;font-size:9pt;break-before:avoid}
        .evidence-element{break-inside:avoid}.evidence-element.long-evidence{break-inside:auto}
        .evidence-entry.short-evidence{break-inside:avoid}
        h2,h3{break-after:avoid}footer{break-inside:avoid}
      }`;
      document.head.append(style);
    });
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 672, height: 986 });
    // Cards taller than a printable page must flow, rather than leave an empty page.
    await page.evaluate(() => {
      document.querySelectorAll('.finding').forEach(card => {
        if (card.getBoundingClientRect().height > 970) card.classList.add('long-finding');
      });
      document.querySelectorAll('.evidence-entry').forEach(entry => {
        if (entry.getBoundingClientRect().height <= 970) entry.classList.add('short-evidence');
      });
      document.querySelectorAll('.evidence-element').forEach(entry => {
        if (entry.getBoundingClientRect().height > 970) entry.classList.add('long-evidence');
      });
      const appendix = document.querySelector('.technical-appendix');
      const first = appendix.querySelector('.evidence-entry');
      const lead = document.createElement('div'); lead.className = 'appendix-lead';
      const heading = appendix.firstElementChild;
      const intro = heading.nextElementSibling;
      appendix.prepend(lead); lead.append(heading, intro);
      if (first?.classList.contains('short-evidence')) lead.append(first);
    });
    return await page.pdf({ format: 'A4', printBackground: true, tagged: true, outline: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#48565d">508 Preflight · Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>', margin: { top: '16mm', bottom: '20mm', left: '16mm', right: '16mm' }, timeout: 30000 });
  } finally { await browser.close(); }
}
module.exports = { buildReport, reportPdf };
