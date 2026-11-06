'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamLines } = require('../src/core/lines');
const h = require('./helpers');

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asv-test-')); });
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('streamLines: CRLF, missing final newline, empty lines', async () => {
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\r\n\r\n{"b":2}');
  const got = [];
  const r = await streamLines(f, (l, n) => { got.push([n, l]); });
  assert.deepStrictEqual(got, [[1, '{"a":1}'], [3, '{"b":2}']]);
  assert.strictEqual(r.truncated, false);
});

test('streamLines: maxBytes stops early and drops the cut line', async () => {
  const f = path.join(dir, 'b.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"bbbbbbbbbb":2}\n');
  const got = [];
  const r = await streamLines(f, (l) => { got.push(l); }, { maxBytes: 12 });
  assert.deepStrictEqual(got, ['{"a":1}']);
  assert.strictEqual(r.truncated, true);
});

test('streamLines: an oversized line is skipped and counted', async () => {
  const f = path.join(dir, 'c.jsonl');
  fs.writeFileSync(f, '{"x":"' + 'y'.repeat(5000) + '"}\n{"ok":1}\n');
  const got = [];
  const r = await streamLines(f, (l) => { got.push(l); }, { maxLineBytes: 1000, chunkSize: 512 });
  assert.deepStrictEqual(got, ['{"ok":1}']);
  assert.strictEqual(r.longLines, 1);
});

test('30 MB session streams, sends a first batch early, respects the size limit', async () => {
  const f = path.join(dir, 'big.jsonl');
  const fd = fs.openSync(f, 'w');
  const out = 'x'.repeat(2000);
  let n = 0, size = 0;
  while (size < 30 * 1024 * 1024) {
    const u = JSON.stringify({ type: 'user', sessionId: 'big-1', uuid: 'u' + n, parentUuid: null, timestamp: new Date(1e12 + n * 1000).toISOString(), message: { role: 'user', content: 'synthetic prompt ' + n } });
    const a = JSON.stringify({ type: 'assistant', sessionId: 'big-1', uuid: 'a' + n, parentUuid: 'u' + n, message: { id: 'm' + n, model: 'demo-model', content: [{ type: 'tool_use', id: 't' + n, name: 'Bash', input: { command: 'echo ' + n } }], usage: { input_tokens: 1, output_tokens: 2 } } });
    const r = JSON.stringify({ type: 'user', sessionId: 'big-1', uuid: 'r' + n, parentUuid: 'a' + n, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + n, content: out }] } });
    const chunk = u + '\n' + a + '\n' + r + '\n';
    fs.writeSync(fd, chunk);
    size += Buffer.byteLength(chunk);
    n++;
  }
  fs.closeSync(fd);
  assert.ok(fs.statSync(f).size >= 30 * 1024 * 1024);
  let firstAt = 0, batches = 0;
  const t0 = Date.now();
  const { loadSession } = require('../src/core/session');
  const { meta } = await loadSession(f, { onItems: () => { if (!batches++) firstAt = Date.now() - t0; } });
  const total = Date.now() - t0;
  assert.strictEqual(meta.turns, n);
  assert.strictEqual(meta.tokens.output, 2 * n);
  assert.ok(batches > 10, 'items arrive in batches');
  assert.ok(firstAt < total / 4, `first batch at ${firstAt} ms of ${total} ms`);
  const cut = await loadSession(f, { maxBytes: 1024 * 1024 });
  assert.strictEqual(cut.meta.truncated, true);
  assert.ok(cut.meta.turns < n);
  // cancel
  let calls = 0;
  const c = await loadSession(f, { isCancelled: () => ++calls > 3 });
  assert.ok(c.stats.cancelled);
  fs.rmSync(f);
});

test('loadSession refuses a JSONL file that is not a session', async () => {
  await assert.rejects(() => h.load(h.OTHER), (e) => e.code === 'NOT_SESSION');
});
