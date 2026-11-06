'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const h = require('./helpers');
const { searchSessions } = require('../src/core/search');
const { listSessions, resolveRoots, projectLabelFromDir } = require('../src/core/roots');
const { toMarkdown } = require('../src/core/markdown');
const { resumeCommand, shQuote } = require('../src/core/resume');

const roots = { claude: [path.join(h.FIX, 'claude', 'projects')], codex: [path.join(h.FIX, 'codex', 'sessions')] };

test('listSessions finds both tools, newest first', async () => {
  const list = await listSessions(roots);
  assert.strictEqual(list.filter((e) => e.source === 'claude').length, 3);
  assert.strictEqual(list.filter((e) => e.source === 'codex').length, 1);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].mtimeMs >= list[i].mtimeMs);
  assert.strictEqual((await listSessions(roots, { max: 2 })).length, 2);
  assert.deepStrictEqual(await listSessions({ claude: ['/no/such/dir'], codex: [] }), []);
});

test('resolveRoots: settings, env vars, defaults', () => {
  assert.deepStrictEqual(resolveRoots({}, {}, '/h'), { claude: ['/h/.claude/projects'], codex: ['/h/.codex/sessions'] });
  assert.deepStrictEqual(resolveRoots({}, { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '~/cx' }, '/h'), { claude: ['/c/projects'], codex: ['/h/cx/sessions'] });
  assert.deepStrictEqual(resolveRoots({ claudeRoots: ['~/a', ''], codexRoots: ['/b'] }, {}, '/h'), { claude: ['/h/a'], codex: ['/b'] });
  assert.strictEqual(projectLabelFromDir('-tmp-demo'), '/tmp/demo');
});

test('search finds text in prompts, tool inputs and outputs across tools', async () => {
  const list = await listSessions(roots);
  const r1 = await searchSessions(list, 'BACKOFF');
  assert.ok(r1.hits.some((x) => x.kind === 'user' && x.source === 'claude'));
  const r2 = await searchSessions(list, '--place');
  assert.ok(r2.hits.some((x) => x.source === 'codex' && x.kind === 'tool'));
  const r3 = await searchSessions(list, 'pass 3');
  assert.ok(r3.hits.some((x) => x.kind === 'result'));
  const r4 = await searchSessions(list, '"lisbon"');
  assert.ok(r4.hits.length >= 1, 'quotes are matched after JSON decoding');
  const none = await searchSessions(list, 'zzz-not-there');
  assert.strictEqual(none.hits.length, 0);
  assert.strictEqual((await searchSessions(list, '   ')).hits.length, 0);
});

test('search can be cancelled', async () => {
  const list = await listSessions(roots);
  let n = 0;
  const r = await searchSessions(list, 'the', { isCancelled: () => ++n > 1 });
  assert.strictEqual(r.cancelled, true);
  assert.ok(r.files < list.length);
});

test('markdown export, with and without tool outputs', async () => {
  const { meta, items } = await h.load(h.TOOLS);
  const md = toMarkdown(meta, items);
  assert.match(md, /^# Add retry with backoff/);
  assert.match(md, /\*\*Tool:\*\* Claude Code/);
  assert.match(md, /```diff\n--- \/tmp\/demo\/src\/forecast\.js/);
  assert.match(md, /pass 3/);
  assert.match(md, /> ## User \(subagent\)/);
  const lean = toMarkdown(meta, items, { stripToolOutputs: true });
  assert.doesNotMatch(lean, /pass 3/);
  assert.match(lean, /Tool outputs removed/);
  assert.match(lean, /npm test -- forecast/, 'tool inputs stay');
});

test('markdown fences survive content that holds backticks', async () => {
  const { meta } = await h.load(h.QA);
  const md = toMarkdown(meta, [{ k: 'tool', id: 'a', name: 'Bash', input: 'echo ```' }, { k: 'result', id: 'a', text: '````' }]);
  assert.match(md, /`````\n````\n`````/);
});

test('resume commands', async () => {
  const { meta } = await h.load(h.TOOLS);
  assert.strictEqual(resumeCommand(meta), 'cd /tmp/demo && claude --resume 22222222-2222-4222-8222-222222222222');
  assert.strictEqual(resumeCommand(meta, { withCd: false }), 'claude --resume 22222222-2222-4222-8222-222222222222');
  const cx = (await h.load(h.CODEX)).meta;
  assert.strictEqual(resumeCommand(cx, { withCd: false }), 'codex resume 0199aa00-1111-7222-8333-444455556666');
  assert.strictEqual(resumeCommand({ format: 'claude', id: 'x; rm -rf ~', cwd: '/' }), '');
  assert.strictEqual(shQuote("/my dir/it's"), "'/my dir/it'\\''s'");
});

test('export file name: the simple save dialog\'s added ".md" is fixed, session names are refused', () => {
  const { exportFileName } = require('../src/core/markdown');
  assert.deepEqual(exportFileName('notes.md'), { name: 'notes.md' });
  assert.deepEqual(exportFileName('notes.md.md'), { name: 'notes.md' });
  assert.deepEqual(exportFileName('notes.MD.md.md'), { name: 'notes.MD' });
  assert.deepEqual(exportFileName('notes'), { name: 'notes.md' });
  assert.deepEqual(exportFileName('report.txt'), { name: 'report.txt' });
  for (const bad of ['evil.jsonl', 'evil.jsonl.md', 'EVIL.JSONL.md.md', '.md', '']) assert.ok(exportFileName(bad).error, bad);
});
