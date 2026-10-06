const http = require('node:http');
const net = require('node:net');
const { resolveTarget } = require('./network-policy');

async function createEgressProxy({ resolve = resolveTarget, maxBytes = 40 * 1024 * 1024, maxConnectionBytes = 10 * 1024 * 1024, maxConnections = 20, maxRequests = 400 } = {}) {
  const sockets = new Set(); let bytes = 0, requests = 0, connections = 0, fatal, closing = false;
  function fail(error) { fatal ||= error; for (const socket of sockets) socket.destroy(); }
  function count(size, state) {
    bytes += size; state.bytes += size;
    if (bytes > maxBytes || state.bytes > maxConnectionBytes) { fail(new Error('Page exceeds proxy download resource limits.')); return false; }
    return true;
  }
  function acquire() {
    if (closing || fatal) throw new Error('Proxy is closed.');
    requests++;
    if (requests > maxRequests || connections >= maxConnections) { const error = new Error('Page exceeds proxy network resource limits.'); fail(error); throw error; }
    connections++;
    let released = false;
    return () => { if (!released) { released = true; connections--; } };
  }
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    let release;
    try {
      release = acquire();
      const target = await resolve(request.url);
      if (closing || response.destroyed) { release(); return; }
      if (target.url.protocol !== 'http:') throw new Error('HTTPS requires a tunnel.');
      const headers = { ...request.headers, host: target.url.host };
      for (const name of ['proxy-authorization', 'proxy-connection', 'connection']) delete headers[name];
      const upstream = http.request(target.url, { method: request.method, headers, agent: false, lookup: (_host, options, callback) => callback(null, options.all ? [{ address: target.address, family: target.family }] : target.address, target.family) }, result => {
        response.writeHead(result.statusCode, result.headers);
        const state = { bytes: 0 };
        result.on('data', chunk => { if (!count(chunk.length, state)) result.destroy(); });
        result.on('error', () => response.destroy());
        result.pipe(response);
      });
      const timer = setTimeout(() => upstream.destroy(new Error('Proxy request timed out.')), 10000);
      let upload = 0;
      request.on('data', chunk => { upload += chunk.length; if (upload > 1024 * 1024) { fail(new Error('Page request exceeds proxy resource limits.')); upstream.destroy(); } });
      response.once('close', () => { clearTimeout(timer); upstream.destroy(); release(); });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    } catch { release?.(); response.writeHead(403); response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(15000, () => socket.destroy()); });
  server.on('connect', async (request, client, head) => {
    let release, upstream;
    try {
      release = acquire();
      if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(?:80|443)$/.test(request.url)) throw new Error('Invalid tunnel destination.');
      const target = await resolve(`https://${request.url}`);
      if (closing || client.destroyed) { release(); return; }
      // No second DNS lookup: connect directly to the validated address.
      upstream = net.connect({ host: target.address, family: target.family, port: Number(target.url.port || 443) });
      sockets.add(upstream); upstream.once('close', () => { sockets.delete(upstream); release(); });
      client.once('close', () => upstream.destroy());
      upstream.setTimeout(10000, () => upstream.destroy());
      const state = { bytes: 0 };
      upstream.on('data', chunk => { if (!count(chunk.length, state)) upstream.destroy(); });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    } catch { release?.(); client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    check: () => { if (fatal) throw fatal; },
    close: async () => { closing = true; for (const socket of sockets) socket.destroy(); await new Promise(resolveClose => server.close(resolveClose)); }
  };
}
module.exports = { createEgressProxy };
