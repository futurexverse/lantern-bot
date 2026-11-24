/* Cross-platform runner for the bot smoke tests.
   Isolates the store (temp file per run) so tests never touch a real
   store.json, and fails the process if any suite fails. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const suites = [
  'smoketest.js',
  'smoketest.chain.js',
  'smoketest.commands.js',
  'smoketest.alerts.js'
];

const tmpStore = path.join(os.tmpdir(), 'lantern-bot-test-store.json');
let failed = [];

for (const suite of suites) {
  const file = path.join(here, suite);
  if (!fs.existsSync(file)) {
    console.log(`\n=== ${suite}  (missing, skipped) ===`);
    continue;
  }
  console.log(`\n=== ${suite} ===`);
  const res = spawnSync(process.execPath, [file], {
    cwd: here,
    stdio: 'inherit',
    env: {
      ...process.env,
      STORE_PATH: tmpStore,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
      WEBAPP_URL: process.env.WEBAPP_URL || 'https://example.vercel.app/trade.html',
      BOT_API_URL: process.env.BOT_API_URL || 'https://example.up.railway.app'
    }
  });
  if (res.status !== 0) failed.push(suite);
}

try { fs.rmSync(tmpStore, { force: true }); } catch (e) { /* ignore */ }

console.log('\n────────────────────────────────────────');
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('All bot test suites passed.');
