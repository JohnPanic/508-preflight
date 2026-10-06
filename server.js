const express = require('express');
const path = require('node:path');
const { publicUrl, scan } = require('./scanner');
const app = express();
const { buildReport, reportPdf } = require('./export-report');
let exporting = false;
app.post('/api/export/:format', express.json({ limit: '20mb' }), async (req, res) => {
  if (!['html', 'pdf'].includes(req.params.format)) return res.status(400).json({ error: 'Choose HTML or PDF.' });
  if (exporting) return res.status(429).json({ error: 'A report is being prepared. Please try again shortly.' });
  exporting = true;
  try {
    let report;
    try { report = buildReport(req.body); } catch { return res.status(400).json({ error: 'Invalid report content.' }); }
    const format = req.params.format;
    const file = format === 'pdf' ? await reportPdf(report.html) : report.html;
    res.set('Content-Disposition', `attachment; filename="${report.filename}.${format}"`);
    res.type(format === 'pdf' ? 'application/pdf' : 'text/html').send(file);
  } catch (error) {
    console.error('Export failed:', error.message);
    res.status(500).json({ error: 'Unable to prepare the report. Please try again.' });
  } finally { exporting = false; }
});
let busy = false;
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/preflight', async (req, res) => {
  if (busy) return res.status(429).json({ error: 'A scan is already running. Please try again shortly.' });
  busy = true;
  try {
    let url;
    try {
      if (typeof req.body?.url !== 'string' || req.body.url.length > 2048) throw new Error('Enter a valid public URL (maximum 2048 characters).');
      url = await publicUrl(req.body.url);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    res.json(await scan(url));
  } catch (error) {
    console.error('Scan failed:', error.message);
    res.status(502).json({ error: 'Unable to scan this page. It may be unavailable, block automated browsers, or have timed out.' });
  } finally { busy = false; }
});
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'Invalid request. Send JSON with a URL.' }));
app.listen(process.env.PORT || 3000, '127.0.0.1', () => console.log(`508 Preflight: http://localhost:${process.env.PORT || 3000}`));
