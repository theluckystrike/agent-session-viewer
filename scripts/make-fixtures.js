'use strict';
// Writes synthetic session files. All content is invented; no real session is copied.
// Usage: node scripts/make-fixtures.js [outDir]   (default test/fixtures)
const fs = require('fs');
const path = require('path');
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures'));

const CWD = '/tmp/demo';
const T0 = Date.parse('2026-11-06T09:12:00.000Z');
const ts = (s) => new Date(T0 + s * 1000).toISOString();
let uuidN = 0;
const uuid = () => { uuidN++; const h = uuidN.toString(16).padStart(12, '0'); return `00000000-0000-4000-8000-${h}`; };
const line = (o) => JSON.stringify(o);

function claudeSession(id, recs) {
  let parent = null;
  return recs.map((r) => {
    if (r.raw !== undefined) return r.raw;
    const u = uuid();
    const base = { parentUuid: parent, isSidechain: !!r.side, userType: 'external', cwd: CWD, sessionId: id, version: '2.1.0', gitBranch: 'feat/retry', uuid: u, timestamp: ts(r.t) };
    parent = u;
    if (r.user !== undefined) return line({ ...base, type: 'user', message: { role: 'user', content: r.user }, ...(r.extra || {}) });
    if (r.asst) {
      return line({ ...base, type: 'assistant', requestId: 'req_demo' + r.t, message: { id: r.msgId || 'msg_demo' + r.t, type: 'message', role: 'assistant', model: r.model || 'claude-sonnet-4-5', content: r.asst, stop_reason: null, usage: r.usage || { input_tokens: 12, output_tokens: 90, cache_creation_input_tokens: 1200, cache_read_input_tokens: 8000 } } });
    }
    return line({ ...base, ...r.rec });
  }).join('\n') + '\n';
}

const OLD = `export async function fetchForecast(city) {\n  const res = await fetch(url(city));\n  return res.json();\n}\n`;
const NEW = `export async function fetchForecast(city, { retries = 3 } = {}) {\n  for (let i = 0; i <= retries; i++) {\n    const res = await fetch(url(city));\n    if (res.ok) return res.json();\n    await sleep(250 * 2 ** i);\n  }\n  throw new Error(\`forecast failed for \${city}\`);\n}\n`;

// Read tool output: each line numbered like `cat -n` (6-wide number, then a tab).
const catN = (text) => text.replace(/\n$/, '').split('\n').map((l, i) => String(i + 1).padStart(6) + '\t' + l).join('\n');

const files = {};
const CL = 'claude/projects/-tmp-demo';
files[`${CL}/11111111-1111-4111-8111-111111111111.jsonl`] = claudeSession('11111111-1111-4111-8111-111111111111', [
  { rec: { type: 'summary', summary: 'Explain the forecast cache' }, raw: line({ type: 'summary', summary: 'Explain the forecast cache', leafUuid: '00000000-0000-4000-8000-000000000999' }) },
  { t: 0, user: 'How does the forecast cache decide when an entry is stale?' },
  { t: 6, asst: [{ type: 'text', text: 'Each entry stores `fetchedAt`. `get()` treats it as stale when `Date.now() - fetchedAt > ttlMs` (10 minutes by default), and then fetches again.' }], usage: { input_tokens: 8, output_tokens: 64, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 } },
  { t: 40, user: 'Can I change the TTL per city?' },
  { t: 47, asst: [{ type: 'text', text: 'Yes. Pass `ttlMs` in the options object:\n\n```js\ncache.get("Lisbon", { ttlMs: 60_000 })\n```' }], usage: { input_tokens: 10, output_tokens: 48, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 } },
  { raw: line({ type: 'cost-state', sessionId: '11111111-1111-4111-8111-111111111111', totalCostUSD: 0.0123 }) },
]);

files[`${CL}/22222222-2222-4222-8222-222222222222.jsonl`] = claudeSession('22222222-2222-4222-8222-222222222222', [
  { t: 0, user: 'Add retry with backoff to fetchForecast and run the tests.' },
  { t: 3, msgId: 'msg_a1', asst: [{ type: 'thinking', thinking: 'The function lives in src/forecast.js. Read it first, then wrap the fetch in a loop with exponential backoff.', signature: 'sig' }] },
  { t: 4, msgId: 'msg_a1', asst: [{ type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: '/tmp/demo/src/forecast.js' } }], usage: { input_tokens: 20, output_tokens: 140, cache_creation_input_tokens: 2400, cache_read_input_tokens: 12000 } },
  { t: 5, user: [{ type: 'tool_result', tool_use_id: 'toolu_read1', content: catN(OLD) }] },
  { t: 9, asst: [{ type: 'tool_use', id: 'toolu_task1', name: 'Task', input: { description: 'Find callers', prompt: 'List every caller of fetchForecast.', subagent_type: 'Explore' } }] },
  { t: 10, side: true, user: 'List every caller of fetchForecast.' },
  { t: 12, side: true, asst: [{ type: 'tool_use', id: 'toolu_grep1', name: 'Grep', input: { pattern: 'fetchForecast\\(', path: '/tmp/demo/src' } }] },
  { t: 13, side: true, user: [{ type: 'tool_result', tool_use_id: 'toolu_grep1', content: 'src/cli.js:14\nsrc/server.js:31' }] },
  { t: 15, side: true, asst: [{ type: 'text', text: 'Two callers: src/cli.js:14 and src/server.js:31. Neither passes options.' }] },
  { t: 16, user: [{ type: 'tool_result', tool_use_id: 'toolu_task1', content: [{ type: 'text', text: 'Two callers: src/cli.js:14 and src/server.js:31. Neither passes options.' }] }] },
  { t: 20, asst: [{ type: 'tool_use', id: 'toolu_edit1', name: 'Edit', input: { file_path: '/tmp/demo/src/forecast.js', old_string: OLD, new_string: NEW } }] },
  { t: 21, user: [{ type: 'tool_result', tool_use_id: 'toolu_edit1', content: 'The file /tmp/demo/src/forecast.js has been updated.' }] },
  { t: 24, asst: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'npm test -- forecast', description: 'Run forecast tests' } }] },
  { t: 31, user: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: '> demo@1.0.0 test\n> node --test forecast\n\n✔ returns parsed JSON (4ms)\n✔ retries 3 times on 503 (760ms)\n✔ throws after the last retry (1.8s)\nℹ tests 3  pass 3  fail 0' }] },
  { t: 33, asst: [{ type: 'text', text: 'Done. `fetchForecast` now retries up to 3 times with 250 ms, 500 ms and 1 s waits, then throws. All 3 forecast tests pass.' }], usage: { input_tokens: 30, output_tokens: 210, cache_creation_input_tokens: 600, cache_read_input_tokens: 15000 } },
  { raw: line({ type: 'cost-state', sessionId: '22222222-2222-4222-8222-222222222222', totalCostUSD: 0.0871 }) },
]);

files[`${CL}/33333333-3333-4333-8333-333333333333.jsonl`] = claudeSession('33333333-3333-4333-8333-333333333333', [
  { raw: line({ type: 'queue-operation', operation: 'enqueue', sessionId: '33333333-3333-4333-8333-333333333333', timestamp: ts(0) }) },
  { raw: line({ type: 'brand-new-record-type', sessionId: '33333333-3333-4333-8333-333333333333', data: { x: 1 } }) },
  { raw: '{"type":"user","message": this line is broken' },
  { t: 2, user: 'Write a README for the demo.' },
  { t: 5, asst: [{ type: 'tool_use', id: 'toolu_w1', name: 'Write', input: { file_path: '/tmp/demo/README.md', content: '# demo\n\nA tiny weather CLI.\n\n    npx demo forecast Lisbon\n' } }, { type: 'mystery_block', foo: 1 }] },
  { t: 6, user: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: 'File created successfully at: /tmp/demo/README.md' }] },
  { t: 8, asst: [{ type: 'tool_use', id: 'toolu_me1', name: 'MultiEdit', input: { file_path: '/tmp/demo/README.md', edits: [{ old_string: 'A tiny weather CLI.', new_string: 'A tiny weather CLI with retries.' }] } }] },
  { raw: '[1,2,3]' },
  { raw: 'not json at all' },
  { t: 9, user: [{ type: 'tool_result', tool_use_id: 'toolu_me1', content: 'Applied 1 edit.', is_error: false }] },
]);

// Codex
const CX_ID = '0199aa00-1111-7222-8333-444455556666';
const cx = [];
const c = (s, type, payload) => cx.push(line({ timestamp: ts(s), type, payload }));
c(0, 'session_meta', { id: CX_ID, timestamp: ts(0), cwd: CWD, originator: 'codex_cli_rs', cli_version: '0.50.0', git: { branch: 'main', commit_hash: 'abc1234' } });
c(0, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>' }] });
c(1, 'turn_context', { cwd: CWD, approval_policy: 'on-request', model: 'gpt-5-codex', effort: 'medium', summary: 'auto' });
c(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rename the --city flag to --place and keep --city as an alias.' }] });
c(1, 'event_msg', { type: 'user_message', message: 'Rename the --city flag to --place and keep --city as an alias.', images: [] });
c(3, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Locating the flag parser**\n\nThe flags are parsed in src/cli.js with a small table.' }], content: null, encrypted_content: 'gAAAA-synthetic' });
c(4, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'rg -n "--city" src'], workdir: CWD }), call_id: 'call_rg1' });
c(5, 'response_item', { type: 'function_call_output', call_id: 'call_rg1', output: JSON.stringify({ output: 'src/cli.js:8:  { name: "--city", key: "city" },\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) });
c(8, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'call_patch1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/cli.js\n@@ const FLAGS = [\n-  { name: "--city", key: "city" },\n+  { name: "--place", key: "place" },\n+  { name: "--city", key: "place", alias: true },\n   { name: "--units", key: "units" },\n*** Add File: docs/flags.md\n+# Flags\n+\n+- `--place` (alias `--city`)\n*** End Patch' });
c(9, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_patch1', output: 'Success. Updated the following files:\nM src/cli.js\nA docs/flags.md' });
c(10, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 9100, cached_input_tokens: 6400, output_tokens: 820, reasoning_output_tokens: 256, total_tokens: 9920 }, last_token_usage: { input_tokens: 4000, cached_input_tokens: 3000, output_tokens: 400, reasoning_output_tokens: 128, total_tokens: 4400 }, model_context_window: 272000 } });
c(11, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'call_t1' });
c(14, 'response_item', { type: 'function_call_output', call_id: 'call_t1', output: JSON.stringify({ output: '✔ cli accepts --place\n✖ cli rejects unknown flags\n', metadata: { exit_code: 1 } }) });
c(15, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Renamed the flag to `--place`; `--city` still works as an alias and is listed in docs/flags.md. One test fails: "cli rejects unknown flags" now needs the alias in its fixture.' }] });
c(15, 'event_msg', { type: 'agent_message', message: 'Renamed the flag...' });
c(16, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 15800, cached_input_tokens: 11200, output_tokens: 1430, reasoning_output_tokens: 512, total_tokens: 17230 } } });
c(16, 'some_future_type', { anything: true });
files[`codex/sessions/2026/11/06/rollout-2026-11-06T09-12-00-${CX_ID}.jsonl`] = cx.join('\n') + '\n';

// A JSONL file that is not a session (custom editor must refuse it politely).
files['other/data.jsonl'] = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }].map(line).join('\n') + '\n';

for (const [rel, text] of Object.entries(files)) {
  const p = path.join(out, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
console.log(`wrote ${Object.keys(files).length} files to ${out}`);
