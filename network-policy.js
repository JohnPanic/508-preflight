const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const ipaddr = require('ipaddr.js');
const { pipeline } = require('node:stream');

function deadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
function isPublicAddress(address) {
  try {
    const parsed = ipaddr.process(address);
    // Azure's platform virtual IP is public-looking but is not a scan target.
    return parsed.range() === 'unicast' && parsed.toString() !== '168.63.129.16';
  } catch { return false; }
}
async function resolveTarget(value, lookup = dns.lookup) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid public HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2048 || (url.port && !['80', '443'].includes(url.port))) {
    throw new Error('Use a public HTTP or HTTPS URL on port 80 or 443 without embedded credentials.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.includes('%') || /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(hostname.replace(/\.$/, ''))) throw new Error('Only public internet addresses can be scanned.');
  const addresses = ipaddr.isValid(hostname) ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }] : await deadline(lookup(hostname, { all: true, verbatim: true }), 3000, 'DNS lookup timed out.');
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Only public internet addresses can be scanned.');
  return { url, hostname, address: addresses[0].address, family: addresses[0].family };
}
// Pin the actual socket lookup to the checked address. Chromium never resolves
// this request independently, eliminating the check/connection rebinding gap.
function pinnedRequest(target, request, { signal, maxBytes = 5 * 1024 * 1024, timeout = 10000, onBytes = () => {}, transport } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers, host: target.url.host, 'accept-encoding': 'identity' };
    for (const key of ['connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'content-length']) delete headers[key];
    const body = request.body;
    if (body?.length) headers['content-length'] = body.length;
    const send = transport || (target.url.protocol === 'https:' ? https.request : http.request);
    const req = send(target.url, {
      method: request.method, headers, agent: false, signal,
      lookup: (_host, options, callback) => callback(null, options.all ? [{ address: target.address, family: target.family }] : target.address, target.family),
      servername: ipaddr.isValid(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true
    }, response => {
      const chunks = []; let bytes = 0, wireBytes = 0;
      response.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > maxBytes) req.destroy(new Error('Response exceeds the resource limit.')); });
      const encoding = response.headers['content-encoding'];
      const decode = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      if (encoding && !decode && encoding !== 'identity') { req.destroy(new Error('Unsupported response encoding.')); return; }
      const stream = decode || response;
      if (decode) pipeline(response, decode, error => { if (error) req.destroy(error); });
      stream.on('data', chunk => {
        bytes += chunk.length;
        try { if (bytes > maxBytes) throw new Error('Response exceeds the resource limit.'); onBytes(chunk.length); chunks.push(chunk); }
        catch (error) { stream.destroy(error); req.destroy(error); }
      });
      stream.once('error', reject);
      stream.once('end', () => {
        const clean = { ...response.headers };
        for (const key of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) delete clean[key];
        resolve({ status: response.statusCode, headers: clean, body: Buffer.concat(chunks) });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Resource request timed out.')), timeout);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject);
    req.end(body);
  });
}

async function protectContext(context, { resolve = resolveTarget, fetch = pinnedRequest, maxRequests = 400, maxTotalBytes = 40 * 1024 * 1024, maxConnections = 20 } = {}) {
  const controller = new AbortController();
  let requests = 0, bytes = 0, connections = 0, fatal;
  function fail(error) { fatal ||= error; controller.abort(); }
  context.on('response', response => {
    let redirects = 0;
    for (let previous = response.request().redirectedFrom(); previous; previous = previous.redirectedFrom()) {
      if (++redirects > 10) { fail(new Error('Page exceeds the redirect resource limit.')); response.frame().page().close().catch(() => {}); break; }
    }
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    let acquired = false;
    try {
      if (controller.signal.aborted) throw new Error('Scan cancelled.');
      if (++requests > maxRequests || connections >= maxConnections) { const error = new Error('Page exceeds network resource limits.'); fail(error); throw error; }
      connections++; acquired = true;
      const request = route.request();
      let redirects = 0;
      for (let prev = request.redirectedFrom(); prev; prev = prev.redirectedFrom()) if (++redirects > 10) throw new Error('Too many redirects.');
      const target = await resolve(request.url());
      const body = request.postDataBuffer();
      if (body && body.length > 1024 * 1024) { const error = new Error('Page request exceeds the resource limit.'); fail(error); throw error; }
      const response = await fetch(target, { method: request.method(), headers: await request.allHeaders(), body }, { signal: controller.signal, onBytes: size => { bytes += size; if (bytes > maxTotalBytes) { const error = new Error('Page exceeds total download limits.'); fail(error); throw error; } } });
      if (response.status >= 300 && response.status < 400 && response.headers.location) await resolve(new URL(response.headers.location, target.url).href);
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)]));
      await route.fulfill({ status: response.status, headers, body: response.body });
    } catch (error) {
      if (/resource limit|download limit|Unsupported response encoding/.test(error.message)) fail(error);
      await route.abort('blockedbyclient').catch(() => {});
    } finally { if (acquired) connections--; }
  });
  context.on('close', () => controller.abort());
  return { check: () => { if (fatal) throw fatal; }, cancel: () => controller.abort() };
}
module.exports = { deadline, isPublicAddress, resolveTarget, pinnedRequest, protectContext };
