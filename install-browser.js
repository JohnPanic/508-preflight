const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, [require.resolve('playwright/cli'), 'install', 'chromium'], {
  stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(__dirname, '.pw-browsers') }
});
process.exit(result.status ?? 1);
