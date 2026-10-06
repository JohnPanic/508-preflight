require('./scanner'); // Configure the browser installation path before imports.
const { scan } = require('./scanner');
const { buildReport, reportPdf } = require('./export-report');
process.once('message', async ({ kind, payload }) => {
  try {
    let result;
    if (kind === 'scan') result = await scan(payload);
    else if (kind === 'html' || kind === 'pdf') {
      const report = buildReport(payload);
      result = { filename: `${report.filename}.${kind}`, data: kind === 'pdf' ? await reportPdf(report.html) : report.html };
      if (Buffer.byteLength(result.data) > 40 * 1024 * 1024) throw new Error('Report size limit exceeded.');
    } else throw new Error('Invalid operation.');
    if (kind === 'scan' && Buffer.byteLength(JSON.stringify(result)) > 20 * 1024 * 1024) throw new Error('Scan results exceed the report size limit.');
    process.send({ result }, () => process.exit(0));
  } catch (error) { process.send({ error: error.message }, () => process.exit(1)); }
});
