'use strict';
// Full-text search across session files, streamed line by line, with cancel. Read-only.
const { streamLines, parseLine } = require('./lines');
const { makeParser } = require('./session');

const JSON_ESCAPED = /["\\\n\r\t\u0000-\u001f]/;

function snippet(text, idx, qlen, width = 90) {
  const a = Math.max(0, idx - width), b = Math.min(text.length, idx + qlen + width);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

function itemTexts(it) {
  const out = [];
  if (it.text) out.push(it.text);
  if (it.k === 'tool') { if (it.name) out.push(it.name); if (it.input) out.push(it.input); }
  return out;
}

/**
 * @param {{file: string, source: string}[]} entries
 * @param {string} query
 * @param {{ isCancelled?: () => boolean, maxHits?: number, maxPerFile?: number, maxBytes?: number,
 *           kinds?: string[], onProgress?: (done: number, total: number) => void, onHit?: (hit) => void }} opts
 */
async function searchSessions(entries, query, opts = {}) {
  const q = String(query || '').toLowerCase();
  const hits = [];
  if (!q.trim()) return { hits, files: 0, cancelled: false };
  const isCancelled = opts.isCancelled || (() => false);
  const maxHits = opts.maxHits || 300, maxPerFile = opts.maxPerFile || 20;
  const kinds = new Set(opts.kinds || ['user', 'assistant', 'tool', 'result', 'thinking']);
  const mustParse = JSON_ESCAPED.test(q) || /[^\x20-\x7e]/.test(q);
  let files = 0;
  for (const e of entries) {
    if (isCancelled() || hits.length >= maxHits) break;
    files++;
    let parser;
    try { parser = makeParser(e.source); } catch { continue; }
    let perFile = 0;
    try {
      await streamLines(e.file, (line, lineNo) => {
        if (!mustParse && !line.toLowerCase().includes(q)) return;
        const r = parseLine(line);
        if (!r) return;
        let items;
        try { items = parser.push(r, lineNo); } catch { return; }
        for (const it of items) {
          if (!kinds.has(it.k)) continue;
          for (const t of itemTexts(it)) {
            const idx = t.toLowerCase().indexOf(q);
            if (idx === -1) continue;
            const hit = { file: e.file, source: e.source, line: lineNo, kind: it.k, snippet: snippet(t, idx, q.length), sessionId: parser.meta.id, cwd: parser.meta.cwd };
            hits.push(hit);
            if (opts.onHit) opts.onHit(hit);
            perFile++;
            break;
          }
          if (perFile >= maxPerFile || hits.length >= maxHits) return false;
        }
      }, { isCancelled, maxBytes: opts.maxBytes });
    } catch { /* unreadable file: skip */ }
    if (opts.onProgress) opts.onProgress(files, entries.length);
  }
  return { hits, files, cancelled: isCancelled() };
}

module.exports = { searchSessions, snippet };
