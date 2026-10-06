# 508 Preflight

**V0.3** — A local web app that checks public webpages for automated accessibility findings and produces reports for developers, content managers, and project stakeholders.

508 Preflight provides automated accessibility findings and identifies items requiring human review. It does not certify Section 508 or WCAG compliance.

## Features

- Scan one public HTTP/HTTPS URL in a rendered Chromium browser.
- Group findings by Critical, Serious, Moderate, Minor, or unspecified severity.
- Provide friendly explanations for common findings, suggested fixes, WCAG criteria when available, affected-element counts, and example elements.
- Preserve original axe information, selectors, HTML snippets, tags, and guidance in Technical details.
- Display axe's incomplete results under Manual checks required without assigning pass/fail judgments.
- Download standalone offline HTML and printable PDF reports without rescanning.
- Include a concise PDF main report, complete technical appendix, cross-references, page numbers, heading bookmarks, and basic PDF accessibility tags.

No AI features, API keys, or external reporting service are required.

## Technology stack

Node.js 22+, Express 5, Playwright Chromium, axe-core, and ipaddr.js. The frontend uses plain HTML, CSS, and JavaScript. Playwright Chromium also generates PDFs.

## Installation

Install Node.js 22 or later and Git. After cloning your copy of this repository:

```sh
cd 508-preflight
npm ci
npm run install:browser
npm start
```

Open http://localhost:3000, enter a public webpage URL, and select **Run Preflight**. After a successful scan, select PDF or HTML and **Download Report**. Stop the server with Ctrl+C.

Chromium downloads into the ignored `.pw-browsers/` folder. Set `PLAYWRIGHT_BROWSERS_PATH` to use another browser location. Set `PORT` to change the default port. The server binds to `127.0.0.1`. No `.env` file is required or automatically loaded.

## Project structure

```text
server.js              Express API and static frontend
scanner.js             Public URL validation and rendered-page axe scan
export-report.js       Safe standalone HTML and PDF generation
install-browser.js     Local Chromium installer
public/                HTML, CSS, and JavaScript interface
test/                  Scanner, UI, export, and PDF checks
package-lock.json      Locked npm dependencies
```

## Verification

```sh
npm test
```

With the server running in another terminal:

```sh
node test/ui-check.js
node test/export-check.js
```

Browser checks use example.com and verify the interface, downloads, offline HTML, malicious markup handling, many findings, long snippets, and no repeat scans during export. Test artifacts are written to ignored `tmp/pdfs/` and `test-report.png`.

Optional PDF checks require Python 3 and pypdf:

```sh
python -m pip install pypdf
python test/pdf-check.py
```

These verify main findings, ASCII technical evidence, page numbers, title, language, tags, and bookmarks. Non-Latin snippets also require visual review because extraction varies by font. These checks do not establish PDF/UA conformance.

## API

`POST /api/preflight` accepts JSON `{ "url": "https://example.com" }` and returns the final URL, scan timestamp, axe version, issue count, affected-element occurrence count, manual-review count, original violations, and original incomplete results. Errors return `{ "error": "..." }`.

`POST /api/export/html` and `POST /api/export/pdf` accept the completed frontend report snapshot and return a download. Scanned markup is escaped as text, report elements are allowlisted, and PDF rendering disables JavaScript and network requests.

## Limitations

See [SECURITY.md](SECURITY.md) for the security review, application limits, and mandatory hosting-level isolation before public deployment. The interface displays V0.3. Scans and exports now share one isolated worker slot, with IP quotas of five scans and twenty exports per ten minutes. Only public HTTP/HTTPS targets on ports 80/443 are accepted. Resource limits may reject complex pages; rejected scans do not imply accessibility compliance.

- One rendered page state is scanned without login or user interaction. Keyboard behavior, content meaning, and other accessibility concerns require manual review.
- All default axe rules run, including best practices. Issue totals count violated rules. Affected-element totals count occurrences across rules, not unique elements.
- Manual-review totals reflect axe's incomplete results, vary by page, and do not form a comprehensive manual audit checklist.
- Zero automated violations does not imply compliance. Less common rules use axe's title and description with a web-team review prompt.
- Navigation times out after 30 seconds; scans after 60 seconds. One scan runs at a time. Some websites block automated browsers.
- Export payloads are limited to 20 MB, PDF generation to 30 seconds, and one export runs at a time. Full technical evidence is retained, so large reports can be lengthy and oversized snippets must span pages.
- HTML reports work offline, but external guidance links need internet access. Basic PDF tags and bookmarks do not establish accessibility conformance; specialist and screen-reader review remain appropriate.
- Private and reserved network destinations are rejected, including redirects and subresources. This local prototype needs authentication, rate limits, network-level egress isolation, and additional security review before public deployment.
- Generated reports may contain page content. Review reports before sharing. Environment files, browser downloads, dependencies, temporary files, and generated reports are excluded from Git.

## References

[Playwright browsers](https://playwright.dev/docs/browsers) · [axe-core API](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md)

