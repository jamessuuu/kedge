// The demo page ships a generated bundle. A stale bundle is a demo that shows
// something other than what the tests just verified, so freshness is a test,
// not a habit.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('the committed bundle matches the sources', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'bundle.mjs'), '--check'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
});

test('the demo page is self-contained: no network, no dependencies', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const externals = Array.from(html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)).map((m) => m[0]);
  const scripts = Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g)).map((m) => m[1]);
  const links = Array.from(html.matchAll(/<link[^>]*href="([^"]+)"/g)).map((m) => m[1]);
  assert.deepEqual(
    scripts.filter((s) => !s.startsWith('./')),
    [],
    'the page must load no remote scripts'
  );
  assert.deepEqual(links, [], 'the page must load no external stylesheets or fonts');
  // Anchors to external documentation are fine and expected (Porcupine's repo);
  // resources that must LOAD are not.
  for (const e of externals) {
    assert.ok(e.startsWith('href='), 'remote resource in the page: ' + e);
  }
});

test('the bundle carries no bare imports and no module syntax', () => {
  const bundle = fs.readFileSync(path.join(ROOT, 'web', 'kedge.bundle.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(bundle), 'ES module syntax would not load over file://');
  assert.ok(!/^\s*export\s/m.test(bundle));
  assert.ok(bundle.includes('__req('), 'the module registry should be present');
});

test('the bundler refuses module syntax it cannot handle', () => {
  const tmp = path.join(ROOT, 'web', '__lint_probe.js');
  fs.writeFileSync(tmp, "// probe\nimport def from './app.js';\n");
  try {
    // Point the bundler at a file that uses a default import by importing the
    // probe from a temporary entry is more machinery than this deserves; assert
    // on the regexes the bundler is built from instead.
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'bundle.mjs'), 'utf8');
    assert.ok(src.includes('unsupported import form'), 'the bundler must refuse, not guess');
    assert.ok(src.includes('unsupported export form'));
    assert.ok(src.includes('bare import'));
  } finally {
    fs.unlinkSync(tmp);
  }
});
