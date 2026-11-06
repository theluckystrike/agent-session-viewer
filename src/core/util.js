'use strict';
const CLIP = 40000;

/** Cuts long text for display. Export reads the file again, so nothing is lost there. */
function clip(s, max = CLIP) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… ${s.length - max} more characters`;
}

function pretty(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content && typeof content === 'object' && typeof content.text === 'string' ? content.text : '';
  const out = [];
  for (const b of content) {
    if (typeof b === 'string') out.push(b);
    else if (b && typeof b === 'object') {
      if (typeof b.text === 'string') out.push(b.text);
      else if (b.type === 'image' || b.type === 'input_image') out.push('[image]');
    }
  }
  return out.join('\n');
}

function isoOrEmpty(v) {
  if (typeof v === 'number') { const d = new Date(v < 1e12 ? v * 1000 : v); return isNaN(d) ? '' : d.toISOString(); }
  if (typeof v !== 'string') return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString();
}

function newMeta(format) {
  return {
    format, id: '', title: '', cwd: '', branch: '', version: '', models: [],
    start: '', end: '', firstPrompt: '', turns: 0, items: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    costUSD: null, skipped: {}, badLines: 0, truncated: false, subagent: false,
  };
}

function touchTime(meta, ts) {
  const t = isoOrEmpty(ts);
  if (!t) return;
  if (!meta.start || t < meta.start) meta.start = t;
  if (!meta.end || t > meta.end) meta.end = t;
}

function addModel(meta, m) {
  if (typeof m === 'string' && m && !m.startsWith('<') && !meta.models.includes(m)) meta.models.push(m);
}

function skip(meta, type) {
  const k = typeof type === 'string' && type ? type.slice(0, 60) : '(no type)';
  meta.skipped[k] = (meta.skipped[k] || 0) + 1;
}

module.exports = { clip, pretty, num, textOf, isoOrEmpty, newMeta, touchTime, addModel, skip, CLIP };
