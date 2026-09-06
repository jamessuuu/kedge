// The Jepsen log parser, including the hostile-input rows of R6.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJepsenLog } from '../src/io/jepsen.js';
import { validateHistory } from '../src/lin/history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JEPSEN = path.resolve(HERE, '..', 'vendor', 'porcupine', 'jepsen');

test('a real log parses into a well-formed history', () => {
  const text = fs.readFileSync(path.join(JEPSEN, 'etcd_000.log'), 'utf8');
  const h = parseJepsenLog(text, { source: 'etcd_000.log' });
  assert.ok(h.length > 0);
  validateHistory(h);
  for (const op of h) {
    assert.ok(['read', 'write', 'cas'].includes(op.input.op));
    assert.equal(op.key, 'x');
    assert.ok(op.ret > op.call);
  }
});

test('every operation gets exactly one response, including the abandoned ones', () => {
  for (const file of fs.readdirSync(JEPSEN).filter((f) => f.endsWith('.log'))) {
    const text = fs.readFileSync(path.join(JEPSEN, file), 'utf8');
    if (text.trim() === '') continue; // etcd_095.log is empty; covered below
    const h = parseJepsenLog(text, { source: file });
    const positions = new Set();
    for (const op of h) {
      assert.ok(op.ret >= 0, file + ': operation ' + op.id + ' has no response');
      assert.ok(!positions.has(op.call) && !positions.has(op.ret), file + ': duplicate position');
      positions.add(op.call);
      positions.add(op.ret);
    }
  }
});

test('`:info ... :timed-out` leaves the operation pending, with a response at the end', () => {
  const text = [
    'INFO  jepsen.util - 0\t:invoke\t:write\t4',
    'INFO  jepsen.util - 1\t:invoke\t:read\tnil',
    'INFO  jepsen.util - 1\t:ok\t:read\tnil',
    'INFO  jepsen.util - 0\t:info\t:write\t:timed-out',
  ].join('\n');
  const h = parseJepsenLog(text);
  assert.equal(h.length, 2);
  const write = h.find((o) => o.input.op === 'write');
  assert.equal(/** @type {any} */ (write).output.unknown, true);
  // the pending response sits after every other event in the history
  const maxOther = Math.max(...h.filter((o) => o !== write).map((o) => o.ret));
  assert.ok(/** @type {any} */ (write).ret > maxOther);
});

test('`:fail :read :timed-out` responds at its own position, not at the end', () => {
  const text = [
    'INFO  jepsen.util - 0\t:invoke\t:read\tnil',
    'INFO  jepsen.util - 0\t:fail\t:read\t:timed-out',
    'INFO  jepsen.util - 1\t:invoke\t:write\t4',
    'INFO  jepsen.util - 1\t:ok\t:write\t4',
  ].join('\n');
  const h = parseJepsenLog(text);
  const read = /** @type {any} */ (h.find((o) => o.input.op === 'read'));
  const write = /** @type {any} */ (h.find((o) => o.input.op === 'write'));
  assert.equal(read.output.unknown, true);
  assert.ok(read.ret < write.call, 'the timed-out read must respond before the next call');
});

test('cas outcomes are carried through', () => {
  const text = [
    'INFO  jepsen.util - 0\t:invoke\t:cas\t[3 0]',
    'INFO  jepsen.util - 0\t:ok\t:cas\t[3 0]',
    'INFO  jepsen.util - 1\t:invoke\t:cas\t[1 2]',
    'INFO  jepsen.util - 1\t:fail\t:cas\t[1 2]',
  ].join('\n');
  const h = parseJepsenLog(text);
  assert.equal(h[0].output.ok, true);
  assert.equal(h[1].output.ok, false);
});

// ---- hostile input (release-standard row R6) -------------------------------

test('an empty file is refused with a stated error', () => {
  assert.throws(() => parseJepsenLog('', { source: 'empty.log' }), /empty\.log: file is empty/);
  assert.throws(() => parseJepsenLog('   \n\n  ', { source: 'ws.log' }), /file is empty/);
});

test('the corpus’s own empty file is refused, not silently passed', () => {
  const text = fs.readFileSync(path.join(JEPSEN, 'etcd_095.log'), 'utf8');
  assert.equal(text.length, 0);
  assert.throws(() => parseJepsenLog(text, { source: 'etcd_095.log' }), /file is empty/);
});

test('a file that is not a Jepsen log is refused', () => {
  assert.throws(
    () => parseJepsenLog('the quick brown fox\njumped over\n', { source: 'prose.txt' }),
    /no Jepsen operations found/
  );
  assert.throws(
    () => parseJepsenLog('{"json": true}', { source: 'x.json' }),
    /no Jepsen operations found/
  );
});

test('binary input is refused rather than parsed as text', () => {
  assert.throws(
    () => parseJepsenLog('PK' + String.fromCharCode(3, 4, 0) + 'binary', { source: 'a.zip' }),
    /NUL bytes/
  );
});

test('a wrong-type argument is refused', () => {
  assert.throws(() => parseJepsenLog(/** @type {any} */ (42)), /expected log text as a string/);
  assert.throws(() => parseJepsenLog(/** @type {any} */ (null)), /expected log text as a string/);
  assert.throws(() => parseJepsenLog(/** @type {any} */ (['a'])), /expected log text as a string/);
});

test('an oversized input is refused before it is parsed', () => {
  const huge = 'x'.repeat(33 * 1024 * 1024);
  assert.throws(() => parseJepsenLog(huge, { source: 'huge.log' }), /over the .* byte limit/);
});

test('a client that invokes twice without responding is refused', () => {
  const text = [
    'INFO  jepsen.util - 0\t:invoke\t:read\tnil',
    'INFO  jepsen.util - 0\t:invoke\t:read\tnil',
  ].join('\n');
  assert.throws(() => parseJepsenLog(text, { source: 'bad.log' }), /still outstanding/);
});

test('CRLF line endings parse the same as LF', () => {
  const lines = [
    'INFO  jepsen.util - 0\t:invoke\t:write\t4',
    'INFO  jepsen.util - 0\t:ok\t:write\t4',
  ];
  assert.deepEqual(parseJepsenLog(lines.join('\n')), parseJepsenLog(lines.join('\r\n')));
});
