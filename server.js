const express = require('express');
const path = require('node:path');
const http = require('node:http');
const { publicUrl } = require('./scanner');
const { runOperation, stopOperations } = require('./operations');
const { rateLimit, operationSlot } = require('./request-security');
function createApp({ execute = runOperation, validate = publicUrl, scanLimit = 5, exportLimit = 20 } = {}) {
  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (req.path.startsWith('/api/') && (req.get('Sec-Fetch-Site') === 'cross-site' || (req.get('Origin') && req.get('Origin') !== `${req.protocol}://${req.get('host')}`))) return res.status(403).json({ error: 'Cross-origin requests are not permitted.' });
    next();
  });
  const slot = operationSlot();
  const json = limit => express.json({ limit, inflate: false, strict: true });
  app.post('/api/preflight', rateLimit({ limit: scanLimit }), slot, json('4kb'), async (req, res) => {
    try {
      let url;
      try {
        if (typeof req.body?.url !== 'string' || req.body.url.length > 2048) throw new Error('Enter a valid public URL (maximum 2048 characters).');
        url = await validate(req.body.url);
      } catch (error) { return res.status(400).json({ error: error.message }); }
      const result = await execute('scan', url, { signal: req.operationController.signal });
      if (!res.destroyed) res.json(result);
    } catch (error) {
      console.error('Scan failed:', error.message);
      if (!res.destroyed) res.status(502).json({ error: 'Unable to scan this page. It may be unavailable, block automated browsers, or exceed security or resource limits.' });
    } finally { req.releaseOperation(); }
  });
  app.post('/api/export/:format', rateLimit({ limit: exportLimit }), slot, json('20mb'), async (req, res) => {
    try {
      const format = req.params.format;
      if (!['html', 'pdf'].includes(format)) return res.status(400).json({ error: 'Choose HTML or PDF.' });
      const result = await execute(format, req.body, { signal: req.operationController.signal });
      if (!res.destroyed) {
        res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
        res.type(format === 'pdf' ? 'application/pdf' : 'text/html').send(result.data);
      }
    } catch (error) {
      const invalid = /Invalid report|nesting|content limit|report size limit/.test(error.message);
      if (!res.destroyed) res.status(invalid ? 400 : 500).json({ error: invalid ? 'Invalid report content or report exceeds limits.' : 'Unable to prepare the report. Please try again.' });
    } finally { req.releaseOperation(); }
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((error, req, res, next) => {
    req.releaseOperation?.();
    if (!res.destroyed) res.status(error.status || 500).json({ error: error.status === 413 ? 'Request is too large.' : 'Invalid request. Send uncompressed JSON.' });
  });
  return app;
}
function startServer() {
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, createApp());
  server.maxConnections = 100; server.keepAliveTimeout = 5000; server.setTimeout(90000);
  server.listen(process.env.PORT || 3000, '127.0.0.1', () => console.log(`508 Preflight: http://localhost:${process.env.PORT || 3000}`));
  const shutdown = async () => { server.close(); await stopOperations(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  return server;
}
if (require.main === module) startServer();
module.exports = { createApp, startServer };
