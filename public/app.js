const form = document.querySelector('#scan-form');
const report = document.querySelector('#report');
const status = document.querySelector('#status');
const button = form.querySelector('button');
let completedReport = null;
let exportButton = null;
let exportBusy = false;
function reportTree(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  return { tag: node.localName, className: node.className, href: node.getAttribute('href'), children: [...node.childNodes].map(reportTree) };
}
async function downloadReport(format) {
  if (!completedReport || exportBusy) return;
  exportBusy = true; exportButton.disabled = true;
  const snapshot = completedReport;
  const message = document.querySelector('#export-status');
  message.textContent = 'Preparing report…';
  try {
    const response = await fetch(`/api/export/${format}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Export failed.'); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `508-preflight-report-${new Date(snapshot.scannedAt).toISOString().slice(0, 10)}.${format}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    message.textContent = 'Report downloaded.';
  } catch (error) { message.textContent = error.message; }
  finally { exportBusy = false; if (exportButton) exportButton.disabled = button.disabled; }
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
// Editorial explanations only; scan results and rule selection are unchanged.
const explanations = {
  'image-alt': ['An image needs a text alternative', 'People who cannot see the image need its meaning described by a screen reader.', 'Add a short description of the image’s purpose. Mark purely decorative images as decorative.'],
  'color-contrast': ['Text may be hard to read', 'People with low vision may struggle to read text that blends into its background.', 'Choose text and background colors with enough contrast: usually 4.5:1 for normal text or 3:1 for large text.'],
  'button-name': ['A button needs a clear label', 'Screen reader users need to know what a button does before activating it.', 'Give the button a descriptive visible label, such as “Submit application”. Ask your web team to label icon-only buttons.'],
  'link-name': ['A link needs a clear label', 'People using screen readers need to understand where a link goes.', 'Add descriptive link text that explains the destination or action. Label linked images and icons too.'],
  'label': ['A form field needs a label', 'People using assistive technology need to know what information to enter.', 'Add a visible label and ask your web team to associate it with the form field. A placeholder alone is not enough.'],
  'document-title': ['The page needs a descriptive title', 'The browser tab title helps people identify the page and switch between tabs.', 'Set a unique page title that describes its content, followed by the site name if useful.'],
  'html-has-lang': ['The page language is missing', 'Screen readers use the page language to pronounce words correctly.', 'Ask your web team to set the page’s primary language in the HTML language attribute.'],
  'html-lang-valid': ['The page language setting is invalid', 'An invalid language setting can cause screen readers to pronounce content incorrectly.', 'Ask your web team to use a valid language code, such as “en” for English.'],
  'landmark-one-main': ['The page needs a main content area', 'Screen reader users use page regions to jump directly to the main content.', 'Ask your web team to mark the main content as one main region, separate from navigation and the footer.'],
  'page-has-heading-one': ['The page needs a main heading', 'A clear main heading helps people understand the page’s purpose and navigate its content.', 'Add a descriptive main heading and format it as Heading 1 in your content editor.'],
  'region': ['Some content is outside the page’s navigation regions', 'Screen reader users may miss content when navigating by page region.', 'Ask your web team to place this content within an appropriate region, such as main content, navigation, or footer.'],
  'heading-order': ['Heading levels skip a step', 'People navigating by headings rely on their levels to understand the content’s structure.', 'Use heading levels in order. Choose headings for structure, and adjust their appearance with styles.'],
  'aria-valid-attr-value': ['An accessibility setting has an invalid value', 'Incorrect accessibility settings can give assistive technology misleading information.', 'Ask your web team to correct the accessibility attribute values listed in Technical details.'],
  'aria-required-attr': ['An interactive element is missing accessibility information', 'Assistive technology may not be able to explain the element’s purpose or state.', 'Ask your web team to add the required accessibility attributes listed in Technical details.'],
  'aria-required-children': ['This component is missing required structure', 'Screen reader users may not understand or be able to use this component when its required parts are missing.', 'Ask your web team to add the missing parts and check that the component’s structure matches its intended function.'],
  'frame-title': ['An embedded frame needs a title', 'Screen reader users need a label to identify embedded content.', 'Ask your web team to add a descriptive title to the embedded frame.'],
  'duplicate-id-aria': ['Accessibility labels use a duplicate identifier', 'Assistive technology may associate a label or description with the wrong element.', 'Ask your web team to give these elements unique identifiers and update their label references.']
};
function representative(node) {
  if (!node) return 'No element example was provided.';
  if (/^\s*<html(?:\s|>)/i.test(node.html)) return 'Whole page';
  // Parse as inert markup; never insert scanned HTML into the page.
  const doc = new DOMParser().parseFromString(node.html, 'text/html');
  const item = doc.body.firstElementChild;
  if (!item) return 'Page-level element';
  const names = { a: 'Link', img: 'Image', button: 'Button', input: 'Form field', select: 'Selection field', textarea: 'Text field', p: 'Paragraph', html: 'Whole page', iframe: 'Embedded frame' };
  const kind = names[item.localName] || (/^h[1-6]$/.test(item.localName) ? 'Heading' : 'Page element');
  const label = item.getAttribute('aria-label') || item.getAttribute('alt') || item.textContent.trim() || item.getAttribute('title');
  return label ? `${kind}: “${label.replace(/\s+/g, ' ').slice(0, 180)}”` : `${kind} with no readable label or text`;
}
function field(card, label, value) {
  const p = element('p', undefined, 'finding-field');
  p.append(element('strong', label), element('span', value));
  card.append(p);
}
function criteria(tags) {
  const values = tags.filter(tag => /^wcag\d{3,4}$/.test(tag)).map(tag => {
    const digits = tag.slice(4);
    return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
  });
  return values.length ? [...new Set(values)].map(value => `WCAG ${value}`).join(', ') : 'No specific WCAG criterion supplied by axe (may be a best-practice rule).';
}
const manualExplanations = {
  'duplicate-id-aria': ['Accessibility labels use a duplicate identifier', 'A person needs to confirm which labels or descriptions assistive technology associates with these elements.', 'Ask your web team to inspect the repeated identifiers and their label references, then check the announced labels with a screen reader.'],
  'color-contrast': ['Check whether text is easy to read', 'The automated check could not reliably determine the text or background colors for these elements.', 'Check the text against its actual background, including images, gradients, and overlays. Measure contrast with a contrast checker.'],
  'image-alt': ['Check the image descriptions', 'A person needs to judge what an image communicates in this page’s context.', 'Check that meaningful images have useful descriptions and decorative images are marked as decorative.'],
  'link-name': ['Check whether link labels explain their purpose', 'A person needs to interpret the destination and surrounding content.', 'Read each link label in context and with a screen reader. Check that it explains where the link goes or what it does.'],
  'button-name': ['Check whether button labels explain their actions', 'The automated check could not confirm that these controls have useful accessible labels.', 'Use a screen reader to hear each button’s label and compare it with the action the button performs.'],
  'label': ['Check the labels on form fields', 'The automated check could not confirm how these fields are labeled for assistive technology.', 'Check that each field has a clear label and that a screen reader announces it when the field receives focus.'],
  'aria-required-children': ['Check this component’s structure', 'The automated check could not confirm that the component contains all the parts its role requires.', 'Ask your web team to inspect the required child roles and test the component with a keyboard and screen reader.'],
  'aria-required-parent': ['Check how this component fits into its container', 'The automated check could not confirm that this component is inside the structure its role requires.', 'Ask your web team to inspect its parent roles and test the component in context with a screen reader.'],
  'frame-tested': ['Check accessibility inside embedded content', 'The automated check could not fully inspect the embedded page.', 'Review the embedded content separately, including keyboard access, labels, reading order, and text contrast.'],
  'landmark-one-main': ['Check the main content region', 'The automated check could not confirm the page’s main content structure.', 'Use a screen reader’s region navigation to check that the main content is identified and easy to reach.'],
  'region': ['Check that page content can be reached by region', 'The automated check could not confirm how this content fits into the page’s regions.', 'Navigate the page by regions with a screen reader and check that the listed content is available in an appropriate region.']
};
function renderManualChecks(findings) {
  const group = element('section', undefined, 'manual-checks');
  group.append(element('h2', `Manual checks required (${findings.length})`));
  group.append(element('p', 'These checks need human review. They are not recorded as passes or failures.'));
  if (!findings.length) group.append(element('p', 'Axe did not flag any checks for manual review in this scan. A full manual accessibility review is still required.'));
  for (const finding of findings) {
    const card = element('article', undefined, 'finding');
    const copy = manualExplanations[finding.id] || [
      `Review: ${explanations[finding.id]?.[0] || finding.help}`,
      'The automated check could not reach a conclusion for these elements. A person needs to inspect them in the context of the page.',
      `Review the listed elements against this requirement: ${finding.description}. Use the specific review messages in Technical details to guide the check.`
    ];
    card.append(element('span', 'Needs human review', 'badge'), element('h3', copy[0]));
    field(card, 'Why it needs a human', copy[1]);
    field(card, 'What to check', copy[2]);
    field(card, 'Elements to review', String(finding.nodes.length));
    field(card, 'WCAG criterion', criteria(finding.tags));
    field(card, 'Example element to review', representative(finding.nodes[0]));
    const details = element('details');
    details.append(element('summary', 'Technical details'));
    details.append(element('p', `${finding.id}: ${finding.help}`), element('p', finding.description));
    details.append(element('p', `Axe tags: ${finding.tags.join(', ')}`, 'meta'));
    for (const node of finding.nodes) {
      details.append(element('p', `Selector: ${node.target.join(' → ')}`, 'meta'), element('pre', node.html));
      details.append(element('p', 'Axe remediation guidance:'));
      if (node.failureSummary) details.append(element('pre', node.failureSummary));
      // Incomplete checks may carry review messages instead of a failure summary.
      for (const check of [...(node.any || []), ...(node.all || []), ...(node.none || [])]) {
        if (check.message) details.append(element('pre', check.message));
      }
    }
    const link = element('a', 'Read remediation guidance');
    if (/^https:\/\//.test(finding.helpUrl)) link.href = finding.helpUrl;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    details.append(link); card.append(details); group.append(card);
  }
  return group;
}
function render(data) {
  report.replaceChildren(element('h2', `${data.issueCount} ${data.issueCount === 1 ? 'issue' : 'issues'} found`));
  report.append(element('p', `${data.affectedElementCount} affected element occurrences · ${data.manualReviewCount} manual checks required`, 'meta'));
  const guidance = element('aside', undefined, 'start-here');
  guidance.append(element('h2', 'Start Here'));
  guidance.append(element('p', 'Address Critical issues first, then Serious issues. A high affected-element count may come from one repeated template or structural problem. Complete the Manual checks required section before treating the page as fully reviewed.'));
  report.append(guidance);
  report.append(element('p', `${data.url} · ${new Date(data.scannedAt).toLocaleString()} · axe ${data.axeVersion}`, 'meta'));
  if (!data.issueCount) report.append(element('p', 'No automated violations were detected. Manual review is still required.'));
  for (const severity of ['critical', 'serious', 'moderate', 'minor', 'unspecified']) {
    const findings = data.violations.filter(v => (v.impact || 'unspecified') === severity);
    if (!findings.length) continue;
    const group = element('section');
    group.append(element('h2', `${severity[0].toUpperCase() + severity.slice(1)} (${findings.length})`));
    for (const finding of findings) {
      const card = element('article', undefined, 'finding');
      const copy = explanations[finding.id] || [finding.help, `${finding.description}. This can make the page harder to understand or use with assistive technology.`, `Ask your web team to address this requirement: ${finding.help}. Use the guidance in Technical details to check the affected elements.`];
      card.append(element('span', `Severity: ${severity[0].toUpperCase() + severity.slice(1)}`, `badge severity-${severity}`));
      card.append(element('h3', copy[0]));
      field(card, 'Why it matters', copy[1]);
      field(card, 'Affected elements', String(finding.nodes.length));
      field(card, 'WCAG criterion', criteria(finding.tags));
      field(card, 'Suggested fix', copy[2]);
      field(card, 'Example affected element', representative(finding.nodes[0]));
      const details = element('details');
      details.append(element('summary', 'Technical details'));
      details.append(element('p', `${finding.id}: ${finding.help}`), element('p', finding.description));
      details.append(element('p', `Axe tags: ${finding.tags.join(', ')}`, 'meta'));
      for (const node of finding.nodes) {
        details.append(element('p', `Selector: ${node.target.join(' → ')}`, 'meta'));
        details.append(element('pre', node.html));
        details.append(element('p', 'Axe remediation guidance:'));
        details.append(element('pre', node.failureSummary || 'See the remediation link below.'));
      }
      const link = element('a', 'Read remediation guidance');
      if (/^https:\/\//.test(finding.helpUrl)) link.href = finding.helpUrl;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      details.append(link); card.append(details); group.append(card);
    }
    report.append(group);
  }
  report.append(renderManualChecks(data.incomplete || []));
  completedReport = { url: data.url, scannedAt: data.scannedAt, scanTime: `${new Date(data.scannedAt).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`, axeVersion: data.axeVersion, issueCount: data.issueCount, affectedElementCount: data.affectedElementCount, manualReviewCount: data.manualReviewCount, content: [...report.childNodes].map(reportTree) };
  const controls = element('div', undefined, 'export-controls');
  const label = element('label', 'Report format');
  label.htmlFor = 'export-format';
  const formats = element('select'); formats.id = 'export-format';
  for (const format of ['PDF', 'HTML']) { const option = element('option', format); option.value = format.toLowerCase(); formats.append(option); }
  exportButton = element('button', 'Download Report'); exportButton.type = 'button'; exportButton.disabled = exportBusy;
  exportButton.addEventListener('click', () => downloadReport(formats.value));
  const exportStatus = element('span'); exportStatus.id = 'export-status'; exportStatus.setAttribute('role', 'status');
  controls.append(label, formats, exportButton, exportStatus);
  report.insertBefore(controls, report.children[2]);
  report.hidden = false;
}
form.addEventListener('submit', async event => {
  event.preventDefault(); button.disabled = true; button.textContent = 'Running…';
  if (exportButton) exportButton.disabled = true;
  report.hidden = true; status.className = ''; status.textContent = 'Loading page and checking accessibility…';
  try {
    const response = await fetch('/api/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: form.elements.url.value.trim() }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Scan failed.');
    render(data); status.textContent = 'Preflight complete.';
  } catch (error) { status.className = 'error'; status.textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Run Preflight'; }
});
