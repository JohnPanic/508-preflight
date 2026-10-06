const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const active = new Set();
function killTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', reject); killer.once('exit', resolve);
  });
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') return Promise.reject(error); }
  return Promise.resolve();
}
function runOperation(kind, payload, { signal, timeout = kind === 'scan' ? 60000 : 30000, workerPath = path.join(__dirname, 'operation-worker.js') } = {}) {
  if (active.size) return Promise.reject(new Error('Another operation is already running.'));
  if (signal?.aborted) return Promise.reject(new Error('Operation cancelled.'));
  const env = {};
  // Do not pass service credentials, proxy settings, or cloud environment to workers.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[key]) env[key] = process.env[key];
  const child = fork(workerPath, [], { env, execArgv: ['--max-old-space-size=256'], serialization: 'advanced', detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  active.add(child);
  return new Promise((resolve, reject) => {
    let message, stopped = false, stopError, teardown, browserPid;
    const stop = async error => {
      if (stopped) return;
      stopped = true; stopError = error;
      teardown = Promise.all([killTree(child), browserPid ? killTree({ pid: browserPid }) : Promise.resolve()]).catch(() => { child.kill('SIGKILL'); });
      await teardown;
    };
    const cancel = () => stop(new Error('Operation cancelled.'));
    const timer = setTimeout(() => stop(new Error('Browser operation exceeded its runtime limit.')), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('message', value => {
      if (Number.isSafeInteger(value?.browserPid) && value.browserPid > 0) { browserPid = value.browserPid; child.browserPid = browserPid; }
      else message = value;
    });
    child.once('error', error => stop(error));
    child.once('close', async () => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      await teardown;
      if (browserPid && !message && !stopError) await killTree({ pid: browserPid }).catch(() => {});
      active.delete(child);
      if (stopError) reject(stopError);
      else if (message?.error) reject(new Error(message.error));
      else if (message && 'result' in message) resolve(message.result);
      else reject(new Error('Browser worker exited unexpectedly.'));
    });
    child.send({ kind, payload }, error => { if (error) stop(error); });
  });
}
async function stopOperations() { await Promise.all([...active].flatMap(child => [killTree(child), child.browserPid ? killTree({ pid: child.browserPid }) : Promise.resolve()])); }
module.exports = { runOperation, stopOperations };
