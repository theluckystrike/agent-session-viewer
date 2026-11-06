'use strict';
// Webview HTML with a strict Content-Security-Policy: no remote content, one nonce'd local script.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// For the CSP attribute: it is built from fixed text and the webview's cspSource, and sits in double quotes.
function escAttr(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** @param {{cspSource: string, scriptUri: string, styleUri: string, title: string, nonce?: string}} o */
function buildHtml(o) {
  const nonce = o.nonce || makeNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${o.cspSource}`,
    `img-src ${o.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    "font-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escAttr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${esc(o.styleUri)}">
<title>${esc(o.title)}</title>
</head>
<body>
<header id="head" class="head"><div class="title" id="title">${esc(o.title)}</div><div class="chips" id="chips"></div><div class="notices" id="notices"></div></header>
<nav class="toolbar" id="toolbar">
  <button id="btn-resume" type="button" title="Copy the shell command that resumes this session">Copy resume command</button>
  <button id="btn-export" type="button" title="Export this session to a Markdown file">Export Markdown</button>
  <button id="btn-expand" type="button" class="secondary">Expand all</button>
  <button id="btn-collapse" type="button" class="secondary">Collapse all</button>
  <label><input type="checkbox" id="opt-tools"> Hide tool calls</label>
  <label><input type="checkbox" id="opt-thinking"> Hide thinking</label>
  <button id="btn-raw" type="button" class="secondary link" title="Open the .jsonl file as read-only text">Open as text</button>
  <span class="status" id="status">Loading…</span>
</nav>
<main id="list" class="list" aria-live="polite"></main>
<div id="sentinel" class="sentinel"></div>
<script nonce="${nonce}" src="${esc(o.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, esc, makeNonce };
