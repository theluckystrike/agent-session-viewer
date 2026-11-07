'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validateWebviewMessage, hostMessage, MAX_COPY } = require('../src/core/protocol');
const { buildHtml } = require('../src/html');

test('webview messages: valid ones pass, others are dropped', () => {
  assert.deepStrictEqual(validateWebviewMessage({ type: 'ready', extra: 1 }), { type: 'ready' });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'resumeTerminal', cmd: 'rm -rf /' }), { type: 'resumeTerminal' }, 'the webview cannot pass its own command');
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export' }), { type: 'export', stripToolOutputs: false });
  assert.deepStrictEqual(validateWebviewMessage({ type: 'export', stripToolOutputs: true }), { type: 'export', stripToolOutputs: true });
  assert.strictEqual(validateWebviewMessage({ type: 'export', stripToolOutputs: 'yes' }), null);
  assert.deepStrictEqual(validateWebviewMessage({ type: 'copy', text: 'x' }), { type: 'copy', text: 'x' });
  assert.strictEqual(validateWebviewMessage({ type: 'copy', text: 'x'.repeat(MAX_COPY + 1) }), null);
  for (const bad of [null, 'ready', [], {}, { type: 1 }, { type: 'writeFile', path: '/etc/x' }, { type: 'copy' }]) assert.strictEqual(validateWebviewMessage(bad), null);
});

test('host messages have known types only', () => {
  assert.deepStrictEqual(hostMessage('items', { items: [] }), { type: 'items', items: [] });
  assert.throws(() => hostMessage('eval', {}));
});

test('HTML has a strict CSP and escapes the title', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: '<img src=x onerror=alert(1)>.jsonl', nonce: 'N0NCE' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0NCE'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /https?:|unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.strictEqual((html.match(/<script/g) || []).length, 1);
  assert.match(html, /<script nonce="N0NCE"/);
});

test('webview script never uses innerHTML or eval', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'session.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

test('read-only: no source file calls a file write, move or delete API', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(dir);
  const banned = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rename|renameSync|rmSync|rmdir|truncate|ftruncate|copyFile|mkdir|chmod|utimes)\b|workspace\.fs\.(delete|rename|copy)/;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!banned.test(l)) return;
      // The only write: the Markdown export, through VS Code, to a .md path the user picked.
      const ok = path.basename(f) === 'extension.js' && /vscode\.workspace\.fs\.writeFile\(target/.test(l);
      assert.ok(ok, `${path.basename(f)}:${i + 1} ${l.trim()}`);
    });
  }
  const lines = fs.readFileSync(path.join(dir, 'core', 'lines.js'), 'utf8');
  assert.match(lines, /flags: 'r'/);
});

test('the toolbar has Resume in terminal and a find box with previous, next and a live count', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: 't', nonce: 'N0NCE' });
  for (const id of ['btn-term', 'btn-resume', 'find', 'find-prev', 'find-next', 'find-count']) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.match(html, /id="find-count"[^>]*aria-live="polite"/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'session.js'), 'utf8');
  // find marks are built with DOM text nodes only
  assert.match(js, /createTreeWalker\(node, NodeFilter\.SHOW_TEXT\)/);
});
