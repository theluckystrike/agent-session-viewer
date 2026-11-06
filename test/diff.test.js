'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { diffLines, parseApplyPatch, toolDiff } = require('../src/core/diff');

test('diffLines keeps common lines as context', () => {
  const d = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepStrictEqual(d, [{ t: ' ', s: 'a' }, { t: '-', s: 'b' }, { t: '+', s: 'B' }, { t: ' ', s: 'c' }]);
});

test('diffLines handles empty sides', () => {
  assert.deepStrictEqual(diffLines('', 'x'), [{ t: '+', s: 'x' }]);
  assert.deepStrictEqual(diffLines('x', ''), [{ t: '-', s: 'x' }]);
});

test('very large edits fall back without blowing up', () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n');
  const t = Date.now();
  const d = diffLines(a, b);
  assert.strictEqual(d.length, 6000);
  assert.ok(Date.now() - t < 1000);
  const f = toolDiff('Edit', { file_path: 'x', old_string: a, new_string: b });
  assert.ok(f[0].more > 0, 'long diffs are capped for display');
});

test('parseApplyPatch reads add, update, delete and move', () => {
  const p = parseApplyPatch('noise\n*** Begin Patch\n*** Update File: a.js\n*** Move to: b.js\n@@ fn\n-x\n+y\n ctx\n*** Delete File: old.txt\n*** Add File: new.txt\n+hi\n*** End Patch\n+ignored');
  assert.deepStrictEqual(p.map((f) => [f.file, f.op, f.moveTo]), [['a.js', 'update', 'b.js'], ['old.txt', 'delete', undefined], ['new.txt', 'add', undefined]]);
  assert.deepStrictEqual(p[0].lines.map((l) => l.t), ['@', '-', '+', ' ']);
  assert.deepStrictEqual(parseApplyPatch('no patch here'), []);
});

test('toolDiff finds apply_patch inside shell arguments', () => {
  const d = toolDiff('shell', { command: ['apply_patch', '*** Begin Patch\n*** Add File: x\n+1\n*** End Patch'] });
  assert.strictEqual(d[0].file, 'x');
  assert.strictEqual(toolDiff('Bash', { command: 'ls' }), null);
  assert.strictEqual(toolDiff('Edit', { file_path: 'x' }), null);
});
