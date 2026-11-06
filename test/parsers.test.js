'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const { detectFile, detectFromRecords, summarizeFile } = require('../src/core/session');
const { createClaudeParser } = require('../src/core/claude');
const { createCodexParser } = require('../src/core/codex');

test('detects Claude Code, Codex and other JSONL', async () => {
  assert.strictEqual(await detectFile(h.QA), 'claude');
  assert.strictEqual(await detectFile(h.CODEX), 'codex');
  assert.strictEqual(await detectFile(h.OTHER), null);
});

test('detection looks only at the first 20 records', () => {
  const filler = Array.from({ length: 20 }, (_, i) => ({ id: i }));
  assert.strictEqual(detectFromRecords([...filler, { type: 'session_meta', payload: {} }]), null);
  assert.strictEqual(detectFromRecords([...filler.slice(0, 19), { type: 'session_meta', payload: {} }]), 'codex');
  assert.strictEqual(detectFromRecords([{ id: 'x', timestamp: 't', instructions: null }]), 'codex');
  assert.strictEqual(detectFromRecords([{ type: 'summary', summary: 's', leafUuid: 'u' }]), 'claude');
});

test('Claude plain Q&A: turns, title, cost and tokens', async () => {
  const { meta, items } = await h.load(h.QA);
  assert.strictEqual(meta.format, 'claude');
  assert.strictEqual(meta.title, 'Explain the forecast cache');
  assert.strictEqual(meta.turns, 2);
  assert.deepStrictEqual(items.map((i) => i.k), ['user', 'assistant', 'user', 'assistant']);
  assert.strictEqual(meta.costUSD, 0.0123);
  assert.deepStrictEqual(meta.tokens, { input: 18, output: 112, cacheRead: 900, cacheWrite: 900, reasoning: 0, total: 1930 });
  assert.strictEqual(meta.cwd, '/tmp/demo');
  assert.strictEqual(meta.branch, 'feat/retry');
});

test('Claude tools: diffs, results, thinking, sidechain, usage counted once per message id', async () => {
  const { meta, items } = await h.load(h.TOOLS);
  const kinds = items.map((i) => i.k + (i.side ? '*' : ''));
  assert.deepStrictEqual(kinds, ['user', 'thinking', 'tool', 'result', 'tool', 'user*', 'tool*', 'result*', 'assistant*', 'result', 'tool', 'result', 'tool', 'result', 'assistant']);
  assert.strictEqual(meta.turns, 1, 'sidechain prompts are not top-level turns');
  const edit = items.find((i) => i.name === 'Edit');
  assert.ok(edit.diff && edit.diff[0].file === '/tmp/demo/src/forecast.js');
  const add = edit.diff[0].lines.filter((l) => l.t === '+').length;
  const del = edit.diff[0].lines.filter((l) => l.t === '-').length;
  assert.ok(add >= 6 && del >= 1, `diff +${add} -${del}`);
  assert.ok(edit.diff[0].lines.some((l) => l.t === ' ' && l.s === '}'), 'unchanged line kept as context');
  const bash = items.find((i) => i.name === 'Bash');
  assert.strictEqual(bash.summary, 'npm test -- forecast');
  const res = items.find((i) => i.k === 'result' && i.id === 'toolu_bash1');
  assert.match(res.text, /pass 3/);
  // msg_a1 is split over two records with usage; only the last one counts.
  assert.strictEqual(meta.tokens.input, 20 + 12 * 5 + 30);
  assert.strictEqual(meta.costUSD, 0.0871);
});

test('unknown record types and bad lines are skipped, never thrown', async () => {
  const { meta, items } = await h.load(h.ODD);
  assert.strictEqual(meta.badLines, 3);
  assert.deepStrictEqual(meta.skipped, { 'brand-new-record-type': 1 });
  assert.deepStrictEqual(items.map((i) => i.k), ['user', 'tool', 'result', 'tool', 'result']);
  const write = items.find((i) => i.name === 'Write');
  assert.strictEqual(write.diff[0].op, 'add');
  assert.ok(write.diff[0].lines.every((l) => l.t === '+'));
  const me = items.find((i) => i.name === 'MultiEdit');
  assert.ok(me.diff[0].lines.some((l) => l.t === '@'));
});

test('parsers survive hostile records', () => {
  const bad = [null, 1, 'x', [], {}, { type: 'user' }, { type: 'user', message: { content: 5 } }, { type: 'assistant', message: { content: [null, 1, { type: 'tool_use' }] } },
    { type: 'assistant', message: { content: 'plain' } }, { type: 'response_item', payload: { type: 'function_call', arguments: '{bad json' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'not-an-array' } }, { type: 'event_msg', payload: { type: 'token_count', info: null } },
    { type: 'response_item', payload: null }, { type: 'session_meta', payload: { git: null, source: 'cli' } }, { type: 'response_item', payload: { type: 'custom_tool_call', input: { x: 1 } } }];
  for (const make of [createClaudeParser, createCodexParser]) {
    const p = make();
    for (const r of bad) assert.doesNotThrow(() => p.push(r, 1));
    assert.doesNotThrow(() => p.finish());
  }
});

test('Codex: meta, context, reasoning, apply_patch diff, tool errors, tokens', async () => {
  const { meta, items } = await h.load(h.CODEX);
  assert.strictEqual(meta.format, 'codex');
  assert.strictEqual(meta.id, '0199aa00-1111-7222-8333-444455556666');
  assert.strictEqual(meta.cwd, '/tmp/demo');
  assert.strictEqual(meta.branch, 'main');
  assert.deepStrictEqual(meta.models, ['gpt-5-codex']);
  assert.strictEqual(meta.turns, 1);
  assert.deepStrictEqual(items.map((i) => i.k), ['context', 'user', 'thinking', 'tool', 'result', 'tool', 'result', 'tool', 'result', 'assistant']);
  const patch = items.find((i) => i.name === 'apply_patch');
  assert.deepStrictEqual(patch.diff.map((f) => [f.file, f.op]), [['src/cli.js', 'update'], ['docs/flags.md', 'add']]);
  assert.strictEqual(items[3].input, 'rg -n "--city" src', 'bash -lc wrapper is removed');
  const fail = items.filter((i) => i.k === 'result')[2];
  assert.strictEqual(fail.isError, true);
  assert.deepStrictEqual(meta.tokens, { input: 4600, output: 1430, cacheRead: 11200, cacheWrite: 0, reasoning: 512, total: 17230 });
  assert.deepStrictEqual(meta.skipped, { some_future_type: 1 });
});

test('Codex older format with bare items', () => {
  const p = createCodexParser();
  p.push({ id: 'abc-1', timestamp: '2025-05-01T10:00:00Z', instructions: null, git: { branch: 'dev' } }, 1);
  p.push({ record_type: 'state' }, 2);
  const items = p.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, 3);
  const m = p.finish();
  assert.strictEqual(m.id, 'abc-1');
  assert.strictEqual(m.branch, 'dev');
  assert.strictEqual(items[0].k, 'user');
});

test('summarizeFile reads only the head and marks partial reads', async () => {
  const m = await summarizeFile(h.TOOLS, { maxBytes: 400 });
  assert.ok(m === null || m.partial === true);
  const full = await summarizeFile(h.TOOLS);
  assert.strictEqual(full.partial, false);
  assert.strictEqual(full.firstPrompt, 'Add retry with backoff to fetchForecast and run the tests.');
  assert.strictEqual(await summarizeFile(h.OTHER), null);
});
