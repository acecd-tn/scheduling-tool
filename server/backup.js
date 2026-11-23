#!/usr/bin/env node
/*
 * Safe online backup of the PSAP Scheduler database — works while the server
 * is running (uses SQLite's VACUUM INTO, a consistent snapshot).
 *
 *   node server/backup.js                      backup to <data>/backups
 *   node server/backup.js D:\Backups\PSAP      backup to a folder of your choice
 *   node server/backup.js D:\Backups\PSAP --keep 60   keep the newest 60 (default 30)
 *   node server/backup.js D:\Backups\PSAP --config C:\PSAP\psap.config.json
 *
 * Reads the data folder from the same settings as the server (--data,
 * DATA_DIR, or psap.config.json). Exit code is non-zero on failure, so Task
 * Scheduler / monitoring can alert.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
let file = {};
const cfgPath = path.resolve(flag('config') || process.env.PSAP_CONFIG || path.join(ROOT, 'psap.config.json'));
if (fs.existsSync(cfgPath)) file = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
// Same rule as the server: --data / DATA_DIR are relative to the app folder; a
// relative dataDir in the config file is relative to the config file's folder.
const dataDir = flag('data') || process.env.DATA_DIR ? path.resolve(ROOT, flag('data') || process.env.DATA_DIR)
  : path.resolve(fs.existsSync(cfgPath) ? path.dirname(cfgPath) : ROOT, file.dataDir || 'data');
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const dest = path.resolve(positional[0] || path.join(dataDir, 'backups'));
const keep = Math.max(1, +(flag('keep') || 30));

try {
  const src = path.join(dataDir, 'psap.db');
  if (!fs.existsSync(src)) throw new Error(`No database at ${src}`);
  fs.mkdirSync(dest, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23);
  const out = path.join(dest, `psap-${stamp}.db`);
  const db = new DatabaseSync(src);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  db.close();
  // integrity check of the copy
  const chk = new DatabaseSync(out, { readOnly: true });
  const ok = chk.prepare('PRAGMA integrity_check').get();
  chk.close();
  if (Object.values(ok)[0] !== 'ok') throw new Error('Integrity check failed on ' + out);
  const old = fs.readdirSync(dest).filter((f) => /^psap-[\d-]+\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.unlinkSync(path.join(dest, f));
  console.log(`Backup OK: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)${old.length ? `, removed ${old.length} old` : ''}`);
} catch (e) {
  console.error('BACKUP FAILED: ' + e.message);
  process.exit(1);
}
