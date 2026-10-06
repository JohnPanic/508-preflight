const ipaddr = require('ipaddr.js');
function ipKey(value) {
  try {
    const address = ipaddr.process(value);
    if (address.kind() === 'ipv6') return `${address.parts.slice(0, 4).map(n => n.toString(16)).join(':')}::/64`;
    return address.toString();
  } catch { return 'unknown'; }
}
function rateLimit({ limit, windowMs = 600000, maxKeys = 10000, now = Date.now } = {}) {
  const clients = new Map(); let sweepAt = 0;
  return (req, res, next) => {
    const time = now();
    if (time >= sweepAt) { for (const [key, value] of clients) if (value.until <= time) clients.delete(key); sweepAt = time + 60000; }
    const key = ipKey(req.ip); let entry = clients.get(key);
    if (!entry || entry.until <= time) {
      if (!entry && clients.size >= maxKeys) return res.status(429).set('Retry-After', '60').json({ error: 'Too many clients. Please try again later.' });
      entry = { count: 0, until: time + windowMs }; clients.set(key, entry);
    }
    res.set('RateLimit-Limit', String(limit)); res.set('RateLimit-Remaining', String(Math.max(0, limit - entry.count - 1)));
    if (++entry.count > limit) return res.status(429).set('Retry-After', String(Math.ceil((entry.until - time) / 1000))).json({ error: 'Request limit reached. Please try again later.' });
    next();
  };
}
function operationSlot() {
  let active = false;
  return (req, res, next) => {
    if (active) return res.status(429).set('Retry-After', '5').json({ error: 'A scan or report is already running. Please try again shortly.' });
    active = true;
    req.operationController = new AbortController();
    // Release only after the worker has actually exited, not on client disconnect.
    req.releaseOperation = () => { active = false; };
    res.once('close', () => { if (!res.writableFinished) req.operationController.abort(); });
    req.once('aborted', () => req.operationController.abort());
    next();
  };
}
module.exports = { ipKey, rateLimit, operationSlot };
