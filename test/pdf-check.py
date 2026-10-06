"""Verify exported PDF evidence and basic accessibility (requires pypdf)."""
from pathlib import Path
import re
from html.parser import HTMLParser
from pypdf import PdfReader

def compact(value):
    return re.sub(r'\s+', '', value).replace('\ufffd', '')

class ReportParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.headings, self.evidence = [], []
        self.capture = None
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'h3' or tag == 'pre' or (tag == 'p' and attrs.get('class') == 'meta'):
            self.capture = [tag, '']
    def handle_data(self, data):
        if self.capture:
            self.capture[1] += data
    def handle_endtag(self, tag):
        if self.capture and tag == self.capture[0]:
            (self.headings if tag == 'h3' else self.evidence).append(self.capture[1])
            self.capture = None

for name in ('live', 'stress'):
    reader = PdfReader(f'tmp/pdfs/{name}.pdf')
    root = reader.trailer['/Root']
    assert root.get('/Lang') == 'en'
    assert root['/MarkInfo']['/Marked']
    assert root.get('/StructTreeRoot')
    assert reader.metadata.title == '508 Preflight — Accessibility Report'
    assert reader.outline, 'PDF should have heading bookmarks'
    pages = [page.extract_text() for page in reader.pages]
    for i, text in enumerate(pages):
        assert f'Page {i + 1} of {len(pages)}' in text
    text = '\n'.join(re.sub(r'508 Preflight . Page \d+ of \d+', '', page) for page in pages)
    before, appendix = re.split(r'Appendix A . Complete technical evidence', text, maxsplit=1)
    report = ReportParser()
    report.feed(Path(f'tmp/pdfs/{name}.html').read_text(encoding='utf-8'))
    normalized = compact(appendix)
    for heading in report.headings:
        assert compact(heading) in compact(before), 'Missing main report finding'
    for value in report.evidence:
        if not (value.startswith('Selector:') or value.startswith('Axe tags:') or value.startswith('<') or value.startswith('Fix') or value.startswith('Original') or value.startswith('No valid') or value.startswith('Page does')):
            continue
        # Non-Latin glyphs also receive visual QA because extraction can vary.
        if value.isascii():
            assert compact(value) in normalized, f'Missing or truncated evidence: {value[:80]}'
    assert 'does not certify Section' in text
    if name == 'stress':
        assert text.count('Original manual guidance') == 5
        assert all(f'Original title {i}' in appendix for i in range(20))
    print(f'{name}: evidence, main findings, bookmarks, title, language, tags and {len(pages)} page numbers verified')
