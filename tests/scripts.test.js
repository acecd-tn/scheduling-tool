// Guards for the Windows PowerShell scripts. Windows PowerShell 5.1 (built into
// Windows Server) reads .ps1 files without a BOM as ANSI, so non-ASCII characters can
// corrupt strings, and $PSScriptRoot is empty while param() defaults are evaluated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'scripts', 'windows');
const scripts = fs.readdirSync(dir).filter((f) => f.endsWith('.ps1'));

test('PowerShell scripts are plain ASCII', () => {
  for (const f of scripts) {
    const buf = fs.readFileSync(path.join(dir, f));
    const bad = [...buf].findIndex((b) => b > 0x7f);
    assert.equal(bad, -1, `${f} has a non-ASCII byte at offset ${bad}`);
  }
});

test('param() defaults do not use $PSScriptRoot or $MyInvocation', () => {
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = src.match(/\bparam\s*\(([\s\S]*?)\n\)/i);
    if (!m) continue;
    const params = m[1].replace(/#.*$/gm, '');
    assert.ok(!/\$PSScriptRoot|\$MyInvocation/i.test(params), `${f}: set these defaults after the param block`);
  }
});

test('install.ps1 does not pass quoted node arguments through nssm set', () => {
  const src = fs.readFileSync(path.join(dir, 'install.ps1'), 'utf8');
  assert.ok(!/nssm\S*\s+set\s+\S+\s+AppParameters/i.test(src.replace(/#.*$/gm, '')), 'write AppParameters to the registry instead');
  assert.match(src, /Name 'AppParameters'/);
});

test('every browser script parses (a syntax error stops a whole page from loading)', () => {
  const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '..', 'js');
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => path.join(root, f))
    .concat(fs.readdirSync(path.join(root, 'views')).map((f) => path.join(root, 'views', f)));
  for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
});
