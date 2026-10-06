const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { resolveTarget, pinnedRequest, protectContext, isPublicAddress } = require('../network-policy');
const { ipKey, rateLimit } = require('../request-security');
const { createApp } = require('../server');
const { runOperation } = require('../operations');
const { chromium } = require('playwright');
const { buildReport } = require('../export-report');
const { createEgressProxy } = require('../egress-proxy');
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];

test('SSRF policy rejects private, reserved, mapped, encoded and metadata addresses', async () => {
  const denied = ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '0.0.0.0', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '168.63.129.16', '192.0.2.1', '224.0.0.1', '[::]', '[::1]', '[::ffff:127.0.0.1]', '[fd00:ec2::254]', '[fe80::1]', '[64:ff9b::a00:1]'];
  for (const host of denied) await assert.rejects(resolveTarget(`http://${host}`, lookup), undefined, host);
  for (const url of ['file:///etc/passwd', 'ftp://example.com', 'http://user:pass@example.com', 'http://example.com:8080', 'http://localhost', 'http://service.internal', 'http://service.local']) await assert.rejects(resolveTarget(url, lookup));
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(resolveTarget('https://mixed.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
});

test('DNS rebinding cannot replace the checked socket address', async t => {
  const server = http.createServer((req, res) => { assert.match(req.headers.host, /^rebinding\.example:/); res.end('pinned'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let queries = 0;
  const target = await resolveTarget('http://rebinding.example', async () => { queries++; return [{ address: '8.8.8.8', family: 4 }]; });
  // Connect the checked value to a local test server, not a real public host.
  target.address = '127.0.0.1'; target.url.port = String(server.address().port);
  const result = await pinnedRequest(target, { method: 'GET', headers: {} });
  assert.equal(result.body.toString(), 'pinned'); assert.equal(queries, 1);
  await assert.rejects(resolveTarget('http://rebinding.example', async () => [{ address: '127.0.0.1', family: 4 }]));
});

test('response limits apply to compressed and decoded data; requests time out', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return;
    res.setHeader('Content-Encoding', 'gzip'); res.end(zlib.gzipSync('x'.repeat(10000)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const target = { url: new URL(`http://fixture.example:${server.address().port}`), hostname: 'fixture.example', address: '127.0.0.1', family: 4 };
  await assert.rejects(pinnedRequest(target, { method: 'GET', headers: {} }, { maxBytes: 1000 }), /resource limit/);
  target.url.pathname = '/hang';
  await assert.rejects(pinnedRequest(target, { method: 'GET', headers: {} }, { timeout: 50 }), /timed out/);
});

test('browser routing and proxy validate every redirect and subresource; block WebSockets', async () => {
  const proxyHits = [];
  const fixture = http.createServer((req, res) => {
    proxyHits.push(req.url);
    if (req.url === '/chain') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body><p>Safe page</p><img src="http://127.0.0.1/private"><script>window.ws=new WebSocket("ws://127.0.0.1/socket")</script></body></html>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const proxy = await createEgressProxy({ resolve: async value => {
    const target = await resolveTarget(value, lookup);
    target.address = '127.0.0.1'; target.url.port = String(fixture.address().port);
    return target;
  } });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', proxy: { server: proxy.server } });
    const fetched = [];
    await protectContext(context, {
      resolve: url => resolveTarget(url, lookup),
      fetch: async target => {
        fetched.push(target.url.href);
        if (target.url.pathname === '/start') return { status: 302, headers: { location: '/final' }, body: Buffer.alloc(0) };
        if (target.url.pathname === '/through-chain') return { status: 302, headers: { location: '/chain' }, body: Buffer.alloc(0) };
        if (target.url.pathname === '/bad') return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' }, body: Buffer.alloc(0) };
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><body><p>Safe page</p><img src="http://127.0.0.1/private"><script>window.ws=new WebSocket("ws://127.0.0.1/socket")</script></body></html>') };
      }
    });
    const page = await context.newPage();
    await page.goto('http://public.example/start');
    assert.equal(page.url(), 'http://public.example/final');
    assert.ok(proxyHits.includes('/final'));
    assert.ok(fetched.every(url => url.startsWith('http://public.example/')));
    await page.waitForFunction(() => window.ws.readyState === WebSocket.CLOSED);
    await assert.rejects(page.goto('http://public.example/bad'));
    const redirectPage = await context.newPage();
    const denied = await redirectPage.goto('http://public.example/through-chain').catch(() => null);
    if (denied) assert.equal(denied.status(), 403);
    assert.ok(proxyHits.includes('/chain'));
    assert.ok(!fetched.some(url => url.includes('169.254.169.254')));
  } finally { await browser.close(); await proxy.close(); fixture.closeAllConnections(); fixture.close(); }
});

test('network budgets fail explicitly rather than return a partial successful scan', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const guard = await protectContext(context, { maxTotalBytes: 3, resolve: url => resolveTarget(url, lookup), fetch: async (target, request, options) => { options.onBytes(4); return {}; } });
    const page = await context.newPage(); await assert.rejects(page.goto('http://public.example'));
    assert.throws(guard.check, /download limits/);
  } finally { await browser.close(); }
});

test('proxy refuses private HTTP and CONNECT destinations before dialing', async () => {
  const proxy = await createEgressProxy();
  try {
    const address = new URL(proxy.server);
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: address.hostname, port: address.port, path: 'http://169.254.169.254/latest/meta-data' }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(result, 403);
    for (const destination of ['127.0.0.1:443', '[::1]:443', '168.63.129.16:443', 'example.com:22']) {
      const code = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: address.hostname, port: address.port, method: 'CONNECT', path: destination });
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); }); req.on('error', reject); req.end();
      });
      assert.equal(code, 403);
    }
  } finally { await proxy.close(); }
});

test('client disconnect cancels work and worker errors release the shared slot', async t => {
  let cancelled = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  const app = createApp({ validate: async value => value, execute: async (kind, payload, { signal }) => {
    if (kind === 'scan') { started(); await new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true })); }
    return { filename: 'report.html', data: 'recovered' };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/preflight', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', () => {}); req.end(JSON.stringify({ url: 'https://example.com' }));
  await ready; req.destroy();
  for (let i = 0; i < 100 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cancelled, true);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/export/html`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
});

test('HTTP proxy fallback byte limits fail the scan explicitly', async () => {
  const fixture = http.createServer((_req, res) => res.end('too large'));
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const proxy = await createEgressProxy({ maxBytes: 3, resolve: async value => {
    const target = await resolveTarget(value, lookup); target.address = '127.0.0.1'; target.url.port = String(fixture.address().port); return target;
  } });
  try {
    const address = new URL(proxy.server);
    await new Promise(resolve => {
      const req = http.request({ hostname: address.hostname, port: address.port, path: 'http://public.example' }, res => { res.on('error', resolve); res.on('end', resolve); res.resume(); });
      req.on('error', resolve); req.end();
    });
    assert.throws(proxy.check, /resource limits/);
  } finally { await proxy.close(); fixture.closeAllConnections(); fixture.close(); }
});

test('compressed or malformed API bodies are rejected and do not leave the slot locked', async t => {
  const app = createApp({ scanLimit: 20, validate: async value => value, execute: async () => ({ issueCount: 0 }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/preflight`;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: zlib.gzipSync('{"url":"https://example.com"}') })).status, 415);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"https://example.com"}' })).status, 200);
});

test('IPv6 rate keys share a /64 and mapped IPv4 cannot evade rate limits', () => {
  assert.equal(ipKey('2001:db8::1'), ipKey('2001:db8::2'));
  assert.equal(ipKey('::ffff:127.0.0.1'), ipKey('127.0.0.1'));
  let time = 0; const limit = rateLimit({ limit: 1, maxKeys: 1, windowMs: 100, now: () => time });
  function request(ip) {
    const res = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json() {} };
    limit({ ip }, res, () => {}); return res.code;
  }
  assert.equal(request('8.8.8.8'), 200); assert.equal(request('8.8.8.8'), 429);
  assert.equal(request('1.1.1.1'), 429); time = 60001; assert.equal(request('1.1.1.1'), 200);
});

test('API limits, spoofed proxy headers, body limits, origins and shared operation slot', async t => {
  let release; let running = false;
  const app = createApp({ scanLimit: 2, exportLimit: 2, validate: async value => value, execute: async kind => {
    if (kind === 'scan') { running = true; await new Promise(resolve => { release = resolve; }); return { issueCount: 0 }; }
    return { filename: '508-preflight-report-2026-10-06.html', data: 'report' };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (endpoint, body, headers = {}) => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/preflight', { url: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/export/html', { huge: 'x'.repeat(21 * 1024 * 1024) })).status, 413);
  assert.equal((await post('/api/preflight', { url: 'x'.repeat(5000) })).status, 413);
  const scan = post('/api/preflight', { url: 'https://public.example' });
  while (!running) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await post('/api/export/pdf', {})).status, 429); release(); assert.equal((await scan).status, 200);
  assert.equal((await post('/api/preflight', { url: 'https://public.example' }, { 'X-Forwarded-For': '8.8.8.8' })).status, 429);
  assert.equal((await post('/api/export/html', {}, { 'X-Forwarded-For': '1.1.1.1' })).status, 429);
});

test('hard runtime cancellation kills the worker and descendant and frees the slot', async () => {
  await fs.mkdir('tmp/security', { recursive: true });
  const pidFile = path.resolve('tmp/security/descendant.pid');
  const workerPath = path.resolve('tmp/security/hanging-worker.cjs');
  await fs.writeFile(workerPath, `const {spawn}=require('node:child_process');const fs=require('node:fs');process.once('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);});`);
  await assert.rejects(runOperation('scan', '', { workerPath, timeout: 1500 }), /runtime limit/);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/);
  await fs.writeFile(workerPath, `process.once('message',()=>{process.send({result:'recovered'},()=>process.exit(0));});`);
  assert.equal(await runOperation('scan', '', { workerPath }), 'recovered');
});

test('export rejects excessive nesting, node counts and executable markup', () => {
  const base = { url: 'https://example.com', axeVersion: 'test', scannedAt: new Date().toISOString(), issueCount: 0, affectedElementCount: 0, manualReviewCount: 0 };
  assert.throws(() => buildReport({ ...base, content: [{ tag: 'script', children: ['alert(1)'] }] }));
  assert.throws(() => buildReport({ ...base, content: [{ tag: 'p', children: Array(100001).fill('x') }] }), /content limit/);
  let node = 'x'; for (let i = 0; i < 32; i++) node = { tag: 'div', children: [node] };
  assert.throws(() => buildReport({ ...base, content: [node] }), /nesting/);
});

test('unexpected worker crash still cleans up its separately tracked Chromium process', async () => {
  await fs.mkdir('tmp/security', { recursive: true });
  const pidFile = path.resolve('tmp/security/browser.pid');
  const workerPath = path.resolve('tmp/security/crashing-browser.cjs');
  await fs.writeFile(workerPath, `require(${JSON.stringify(path.resolve('scanner.js'))});const fs=require('node:fs');const original=process.send.bind(process);process.send=(message,callback)=>{if(message.browserPid)fs.writeFileSync(${JSON.stringify(pidFile)},String(message.browserPid));return original(message,callback);};process.once('message',async()=>{await require(${JSON.stringify(path.resolve('browser-runtime.js'))}).launchBrowser();process.exit(3);});`);
  await assert.rejects(runOperation('scan', '', { workerPath, timeout: 10000 }), /unexpectedly/);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/);
});
