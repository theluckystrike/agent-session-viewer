// Session webview. Every piece of file content is set with textContent or createTextNode, never parsed as HTML.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const PAGE = 300;
  const items = [];            // display items (results attached to their tool when possible)
  const tools = new Map();     // tool id -> item
  const toolEls = new Map();   // tool id -> output container element
  let rendered = 0;
  let meta = null;
  let expandEdits = true;
  let focusLine = 0;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function fmtNum(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
    return String(n);
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(a, b) {
    const ms = Date.parse(b) - Date.parse(a);
    if (!(ms >= 0)) return '';
    const m = Math.round(ms / 60000);
    if (m < 1) return Math.round(ms / 1000) + ' s';
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  // Text with ``` fences as code blocks and `inline code`.
  function renderText(text, into) {
    const parts = String(text).split(/^```[^\n]*\n?/m);
    parts.forEach((p, i) => {
      if (i % 2 === 1) { const pre = el('pre', 'code'); pre.textContent = p.replace(/\n$/, ''); into.appendChild(pre); return; }
      if (!p.trim()) return;
      const div = el('div', 'text');
      p.split('`').forEach((seg, j) => {
        if (j % 2 === 1) div.appendChild(el('code', null, seg));
        else div.appendChild(document.createTextNode(seg));
      });
      into.appendChild(div);
    });
  }

  function diffEl(diff) {
    const wrap = el('div', 'diff');
    for (const f of diff) {
      const head = el('div', 'diff-file');
      head.appendChild(el('span', 'op op-' + f.op, f.op === 'add' ? 'new' : f.op === 'delete' ? 'deleted' : 'edit'));
      head.appendChild(el('span', 'path', f.file + (f.moveTo ? ' → ' + f.moveTo : '')));
      wrap.appendChild(head);
      const body = el('div', 'diff-body');
      for (const l of f.lines) {
        const row = el('div', 'dl ' + (l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '@' ? 'hunk' : 'ctx'));
        row.appendChild(el('span', 'sign', l.t === '@' ? '' : l.t));
        row.appendChild(el('span', 'code', l.s));
        body.appendChild(row);
      }
      if (f.more) body.appendChild(el('div', 'dl more', '… ' + f.more + ' more lines'));
      wrap.appendChild(body);
    }
    return wrap;
  }

  function stats(diff) {
    let a = 0, d = 0;
    for (const f of diff) for (const l of f.lines) { if (l.t === '+') a++; else if (l.t === '-') d++; }
    return [a, d];
  }

  function outputEl(r) {
    const box = el('div', 'output' + (r.isError ? ' error' : ''));
    box.appendChild(el('div', 'sub', r.isError ? 'Output (error)' : 'Output'));
    box.appendChild(el('pre', 'code', r.text || '(empty)'));
    return box;
  }

  function toolEl(it) {
    const d = el('details', 'tool');
    if (it.diff && expandEdits) d.open = true;
    const s = el('summary');
    s.appendChild(el('span', 'badge', it.name));
    if (it.summary) s.appendChild(el('span', 'sum', it.summary));
    if (it.diff) { const [a, del] = stats(it.diff); s.appendChild(el('span', 'plus', '+' + a)); s.appendChild(el('span', 'minus', '−' + del)); }
    const st = el('span', 'state');
    s.appendChild(st);
    d.appendChild(s);
    const body = el('div', 'tool-body');
    if (it.diff) {
      body.appendChild(diffEl(it.diff));
      const raw = el('details', 'raw');
      raw.appendChild(el('summary', null, 'Input'));
      raw.appendChild(el('pre', 'code', it.input));
      body.appendChild(raw);
    } else if (it.input) {
      body.appendChild(el('div', 'sub', 'Input'));
      body.appendChild(el('pre', 'code', it.input));
    }
    const out = el('div', 'out-slot');
    body.appendChild(out);
    d.appendChild(body);
    const r = it.result;
    if (r) { out.appendChild(outputEl(r)); st.textContent = r.isError ? '✗' : '✓'; st.className = 'state ' + (r.isError ? 'bad' : 'ok'); }
    toolEls.set(it.id, { out, st });
    return d;
  }

  function itemEl(it) {
    let e;
    switch (it.k) {
      case 'user':
      case 'assistant': {
        e = el('section', 'turn ' + it.k);
        const h = el('div', 'who');
        h.appendChild(el('span', 'name', it.k === 'user' ? 'User' : 'Assistant'));
        if (it.ts) h.appendChild(el('span', 'time', fmtTime(it.ts)));
        e.appendChild(h);
        renderText(it.text, e);
        break;
      }
      case 'thinking': {
        e = el('details', 'thinking');
        e.appendChild(el('summary', null, meta && meta.format === 'codex' ? 'Reasoning' : 'Thinking'));
        e.appendChild(el('div', 'text', it.text));
        break;
      }
      case 'context': {
        e = el('details', 'context');
        e.appendChild(el('summary', null, it.label || 'Context'));
        e.appendChild(el('pre', 'code', it.text));
        break;
      }
      case 'note':
        e = el('div', 'note', (it.label ? it.label + ': ' : '') + it.text);
        break;
      case 'tool':
        e = toolEl(it);
        break;
      case 'result': {
        e = el('details', 'tool orphan');
        e.appendChild(el('summary', null, 'Tool output'));
        e.appendChild(outputEl(it));
        break;
      }
      default:
        return null;
    }
    e.classList.add('item', 'k-' + it.k);
    if (it.side) { e.classList.add('side'); }
    if (it.line) e.dataset.line = String(it.line);
    return e;
  }

  function renderMore(n) {
    const frag = document.createDocumentFragment();
    const end = Math.min(items.length, rendered + n);
    for (; rendered < end; rendered++) {
      const e = itemEl(items[rendered]);
      if (e) frag.appendChild(e);
    }
    list.appendChild(frag);
    updateStatus();
  }

  function addItems(batch) {
    for (const it of batch) {
      if (it.k === 'result' && it.id && tools.has(it.id)) {
        const t = tools.get(it.id);
        t.result = it;
        const dom = toolEls.get(it.id);
        if (dom) {
          dom.out.textContent = '';
          dom.out.appendChild(outputEl(it));
          dom.st.textContent = it.isError ? '✗' : '✓';
          dom.st.className = 'state ' + (it.isError ? 'bad' : 'ok');
        }
        continue;
      }
      if (it.k === 'tool' && it.id) tools.set(it.id, it);
      items.push(it);
    }
    if (rendered < PAGE) renderMore(PAGE - rendered);
    else updateStatus();
    if (focusLine) tryFocus();
  }

  function updateStatus() {
    const left = items.length - rendered;
    $('status').textContent = (meta ? '' : 'Loading… ') + rendered + ' of ' + items.length + ' items' + (left > 0 ? ' (scroll for more)' : '');
  }

  function chip(label, value, cls) {
    if (!value) return;
    const c = el('span', 'chip' + (cls ? ' ' + cls : ''));
    c.appendChild(el('span', 'k', label));
    c.appendChild(el('span', 'v', value));
    $('chips').appendChild(c);
  }

  function renderHeader(m) {
    $('title').textContent = m.title || (m.firstPrompt || '').split('\n')[0].slice(0, 120) || m.id || 'Session';
    $('chips').textContent = '';
    chip('Tool', m.format === 'codex' ? 'Codex' : 'Claude Code', 'tool-' + m.format);
    chip('Model', (m.models || []).join(', '));
    chip('Project', m.cwd);
    chip('Branch', m.branch);
    chip('Started', fmtTime(m.start));
    chip('Duration', fmtDur(m.start, m.end));
    chip('Turns', String(m.turns));
    const t = m.tokens || {};
    const tok = ['in ' + fmtNum(t.input), 'out ' + fmtNum(t.output)];
    if (t.cacheRead) tok.push('cache read ' + fmtNum(t.cacheRead));
    if (t.cacheWrite) tok.push('cache write ' + fmtNum(t.cacheWrite));
    if (t.reasoning) tok.push('reasoning ' + fmtNum(t.reasoning));
    chip('Tokens', tok.join(' · '));
    if (typeof m.costUSD === 'number') chip('Cost', '$' + m.costUSD.toFixed(m.costUSD < 1 ? 3 : 2), 'cost');
    chip('Session', m.id, 'mono');
    const n = $('notices');
    n.textContent = '';
    const skipped = Object.entries(m.skipped || {});
    if (skipped.length) n.appendChild(el('div', 'notice', 'Skipped record types: ' + skipped.map(([k, v]) => k + ' (' + v + ')').join(', ')));
    if (m.badLines) n.appendChild(el('div', 'notice', m.badLines + ' line(s) were not valid JSON and were skipped.'));
    if (m.truncated) n.appendChild(el('div', 'notice warn', 'Only the first part of this file was read (size limit). Raise "Agent Session Viewer: Max File Size MB" to read all of it.'));
  }

  function tryFocus() {
    let idx = -1;
    for (let i = 0; i < items.length; i++) { const it = items[i]; if ((it.line || 0) >= focusLine || (it.result && (it.result.line || 0) >= focusLine)) { idx = i; break; } }
    if (idx === -1) return;
    if (idx >= rendered) renderMore(idx - rendered + 50);
    const node = list.querySelector('[data-line="' + items[idx].line + '"]');
    if (!node) return;
    focusLine = 0;
    if (node.tagName === 'DETAILS') node.open = true;
    node.classList.add('hit');
    node.scrollIntoView({ block: 'center' });
  }

  function setOpen(open) {
    list.querySelectorAll('details').forEach((d) => { d.open = open; });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        items.length = 0; tools.clear(); toolEls.clear(); rendered = 0; list.textContent = ''; meta = null;
        expandEdits = m.expandEdits !== false;
        if (m.fileName) $('title').textContent = m.fileName;
        $('btn-resume').disabled = false;
        break;
      case 'items':
        if (Array.isArray(m.items)) addItems(m.items);
        break;
      case 'done':
        meta = m.meta || null;
        if (meta) {
          renderHeader(meta);
          if (meta.format === 'codex') list.querySelectorAll('details.thinking > summary').forEach((x) => { x.textContent = 'Reasoning'; });
        }
        if (!m.resume) $('btn-resume').disabled = true;
        updateStatus();
        if (focusLine) tryFocus();
        break;
      case 'focus':
        focusLine = Number(m.line) || 0;
        if (focusLine) tryFocus();
        break;
      case 'error': {
        $('status').textContent = '';
        const box = el('div', 'error-box', m.message || 'Could not read this file.');
        list.textContent = '';
        list.appendChild(box);
        break;
      }
    }
  });

  $('btn-resume').addEventListener('click', () => vscode.postMessage({ type: 'copyResume' }));
  $('btn-export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  $('btn-raw').addEventListener('click', () => vscode.postMessage({ type: 'openRaw' }));
  $('btn-expand').addEventListener('click', () => setOpen(true));
  $('btn-collapse').addEventListener('click', () => setOpen(false));
  $('opt-tools').addEventListener('change', (e) => document.body.classList.toggle('hide-tools', e.target.checked));
  $('opt-thinking').addEventListener('change', (e) => document.body.classList.toggle('hide-thinking', e.target.checked));

  const io = new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting) && rendered < items.length) renderMore(PAGE);
  }, { rootMargin: '600px' });
  io.observe($('sentinel'));

  vscode.postMessage({ type: 'ready' });
})();
