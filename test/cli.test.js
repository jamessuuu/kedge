// Release-standard row R6, proven behaviourally.
//
// The entry point must not throw a raw stack trace on a missing file, a
// malformed file, an empty file, a file far larger than expected, or a
// wrong-type argument. Each must produce a stated error and a non-zero exit.
// These tests run the real CLI in a child process, because that is what a
// stranger does.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kedge-cli-'));

/** @param {string[]} args */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** @param {{err:string, out:string}} r */
function assertNoStackTrace(r) {
  const text = r.err + r.out;
  assert.ok(!/\n\s+at\s.+:\d+:\d+/.test(text), 'leaked a stack trace:\n' + text);
  assert.ok(!text.includes('node:internal'), 'leaked node internals:\n' + text);
}

test('R6: a missing file states the error and exits non-zero', () => {
  const r = run(['check', path.join(TMP, 'does-not-exist.log')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no such file/);
  assertNoStackTrace(r);
});

test('R6: an empty file states the error and exits non-zero', () => {
  const f = path.join(TMP, 'empty.log');
  fs.writeFileSync(f, '');
  const r = run(['check', f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /file is empty/);
  assertNoStackTrace(r);
});

test('R6: a malformed file states the error and exits non-zero', () => {
  const f = path.join(TMP, 'prose.log');
  fs.writeFileSync(f, 'Dear reader,\n\nthis is not a Jepsen history.\n');
  const r = run(['check', f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no Jepsen operations found/);
  assertNoStackTrace(r);
});

test('R6: a file far larger than expected is refused before it is read', () => {
  const f = path.join(TMP, 'huge.log');
  const fd = fs.openSync(f, 'w');
  fs.ftruncateSync(fd, 33 * 1024 * 1024);
  fs.closeSync(fd);
  const r = run(['check', f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /the limit is/);
  assertNoStackTrace(r);
  fs.unlinkSync(f);
});

test('R6: a directory where a file was expected', () => {
  const r = run(['check', TMP]);
  assert.equal(r.code, 1);
  assert.match(r.err, /is a directory/);
  assertNoStackTrace(r);
});

test('R6: wrong-type arguments are refused', () => {
  for (const args of [
    ['run', '--seed', 'banana'],
    ['run', '--ops', '3.5'],
    ['run', '--budget', 'lots'],
    ['corpus', '--budget', '-1'],
  ]) {
    const r = run(args);
    assert.equal(r.code, 1, args.join(' ') + ' should have failed');
    assert.match(r.err, /must be an integer|must be a positive integer/);
    assertNoStackTrace(r);
  }
});

test('R6: unknown options, commands, models and build flags are refused', () => {
  const cases = [
    { args: ['run', '--nope', '1'], re: /unknown option/ },
    { args: ['frobnicate'], re: /unknown command/ },
    { args: ['check', 'x.log', '--model', 'nonsense'], re: /unknown model/ },
    { args: ['run', '--build', 'not-a-bug'], re: /unknown build flag/ },
    { args: ['run', '--seed'], re: /needs a value/ },
    { args: ['run', '--faults', 'garbage'], re: /invalid fault/ },
    { args: ['run', '--nodes', '4'], re: /odd number/ },
  ];
  for (const c of cases) {
    const r = run(c.args);
    assert.equal(r.code, 1, c.args.join(' ') + ' should have failed');
    assert.match(r.err, c.re);
    assertNoStackTrace(r);
  }
});

test('check accepts a real history', () => {
  const r = run(['check', path.join(ROOT, 'vendor', 'porcupine', 'jepsen', 'etcd_000.log')]);
  assert.equal(r.code, 0);
  assert.match(r.out, /not-linearizable/);
});

test('check --json emits parseable JSON', () => {
  const r = run(['check', path.join(ROOT, 'vendor', 'porcupine', 'jepsen', 'etcd_002.log'), '--json']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.verdict, 'linearizable');
  assert.ok(Number.isInteger(parsed.steps));
});

test('the corpus command matches all 102 and exits zero', () => {
  const r = run(['corpus']);
  assert.equal(r.code, 0);
  assert.match(r.out, /102 of 102 histories matched/);
  assert.match(r.out, /0 mismatched/);
});

test('the demo finds its violation and exits zero', () => {
  const r = run(['demo']);
  assert.equal(r.code, 0);
  assert.match(r.out, /not-linearizable/);
  assert.match(r.out, /witness:/);
});

test('run exits 1 when it finds a violation, 0 when it does not', () => {
  const bad = run(['run', '--seed', '4711', '--faults', '150-700:L', '--build', 'deposed-leader-read']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /not-linearizable/);

  const good = run(['run', '--seed', '4711', '--faults', '150-700:L']);
  assert.equal(good.code, 0);
  assert.match(good.out, /linearizable/);
});

test('a starved budget reports unknown, and says it is not a pass', () => {
  const r = run(['check', path.join(ROOT, 'vendor', 'porcupine', 'jepsen', 'etcd_002.log'), '--budget', '50']);
  assert.equal(r.code, 0);
  assert.match(r.out, /unknown/);
  assert.match(r.out, /this is not a pass/);
});

test('bare invocation prints usage and exits non-zero; help exits zero', () => {
  const bare = run([]);
  assert.equal(bare.code, 1);
  assert.match(bare.out, /kedge check/);
  const help = run(['help']);
  assert.equal(help.code, 0);
});

test('the fixtures command runs the planted bugs and the negative control', () => {
  const r = run(['fixtures']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Negative control: 800 executions/);
  assert.match(r.out, /0 violations/);
  assert.ok(!r.out.includes('FAIL'), r.out);
});

test('bugs lists every fixture', () => {
  const r = run(['bugs']);
  assert.equal(r.code, 0);
  for (const id of [
    'stale-term-commit',
    'deposed-leader-read',
    'minority-election',
    'vote-without-log-check',
    'checker-accept-on-block',
  ]) {
    assert.match(r.out, new RegExp(id));
  }
});
