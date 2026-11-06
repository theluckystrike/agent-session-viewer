'use strict';
// Screenshot harness: the real webview HTML (src/html.js, with its CSP), the real media/session.js and css,
// and host messages built by the real parser from the synthetic fixtures. Driven over CDP.
// Usage: node scripts/screenshot/shot.js <cdpPort> <outDir>
// Start the browser with: AGENT_CHROME_HEADLESS=1 ~/bin/agent-chrome <profileDir> <cdpPort>
const fs = require('fs');
const http = require('http');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { buildHtml } = require(root + '/src/html');
const { hostMessage } = require(root + '/src/core/protocol');
const { resumeCommand } = require(root + '/src/core/resume');
const h = require(root + '/test/helpers');
const [port, outDir] = process.argv.slice(2);

const THEMES = {
  dark: '--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Monaco,monospace;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;--vscode-textLink-foreground:#4daafc;--vscode-textCodeBlock-background:#2b2b2b;--vscode-focusBorder:#0078d4;--vscode-editorWarning-foreground:#cca700;',
  light: '--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Monaco,monospace;--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-textLink-foreground:#005fb8;--vscode-textCodeBlock-background:#f3f3f3;--vscode-focusBorder:#005fb8;--vscode-editorWarning-foreground:#895503;',
};
const NONCE = 'shotnonceshotnonceshotnonce01234';
let theme = 'dark';
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/index.html') {
    let html = buildHtml({ cspSource: `http://127.0.0.1:${server.address().port}`, scriptUri: '/session.js', styleUri: '/session.css', title: 'session.jsonl', nonce: NONCE });
    const shim = `<script nonce="${NONCE}">${JSON.stringify(THEMES[theme])}.split(';').filter(Boolean).forEach(d=>{const i=d.indexOf(':');document.documentElement.style.setProperty(d.slice(0,i).trim(),d.slice(i+1).trim());});window.__sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__sent.push(m),getState:()=>null,setState:()=>{}});</script>`;
    html = html.replace('<script nonce', shim + '<script nonce');
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return;
  }
  const f = { '/session.js': 'text/javascript', '/session.css': 'text/css' }[u];
  if (f) { res.writeHead(200, { 'content-type': f }); res.end(fs.readFileSync(path.join(root, 'media', u.slice(1)))); return; }
  res.writeHead(404); res.end();
});

async function cdp() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const wait = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${list.id}`); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(c, name, file, t, opts = {}) {
  theme = t;
  const { meta, items } = await h.load(file);
  const msgs = [hostMessage('init', { fileName: path.basename(file), expandEdits: true })];
  for (let i = 0; i < items.length; i += 400) msgs.push(hostMessage('items', { items: items.slice(i, i + 400) }));
  msgs.push(hostMessage('done', { meta, resume: resumeCommand(meta) }));
  if (opts.focus) msgs.push(hostMessage('focus', { line: opts.focus }));
  await c.send('Emulation.setDeviceMetricsOverride', { width: opts.w || 1200, height: opts.h || 860, deviceScaleFactor: 2, mobile: false });
  await c.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  await sleep(700);
  for (const m of msgs) await c.send('Runtime.evaluate', { expression: `window.postMessage(${JSON.stringify(m)}, '*')` });
  await sleep(300);
  if (opts.js) await c.send('Runtime.evaluate', { expression: opts.js });
  await sleep(300);
  const chk = await c.send('Runtime.evaluate', { expression: 'JSON.stringify({sent: window.__sent, items: document.querySelectorAll(".item").length, title: document.getElementById("title").textContent})', returnByValue: true });
  console.log(name, chk.result.result.value);
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, 'base64'));
}

server.listen(0, '127.0.0.1', async () => {
  const c = await cdp();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const openBash = `document.querySelectorAll('details.tool').forEach(d => { if (/Bash|shell/.test(d.querySelector('.badge').textContent) && /npm test/.test(d.textContent)) d.open = true; })`;
  await shot(c, 'session-dark.png', h.TOOLS, 'dark', { h: 1180, js: `document.querySelector('details.thinking').open = true;` });
  await shot(c, 'codex-light.png', h.CODEX, 'light', { h: 1060, js: `document.querySelector('details.thinking').open = true;` + openBash });
  await shot(c, 'subagent-dark.png', h.TOOLS, 'dark', { h: 900, js: `window.scrollTo(0, 0); document.querySelectorAll('details.tool').forEach(d => { d.open = /Task|Grep|Bash/.test(d.querySelector('.badge').textContent); }); document.querySelectorAll('.k-tool .badge').forEach(b => { if (b.textContent === 'Edit') b.closest('details').open = false; });` });
  await shot(c, 'search-hit-light.png', h.TOOLS, 'light', { h: 760, focus: 14, js: openBash });
  await c.close();
  server.close(); process.exit(0);
});
