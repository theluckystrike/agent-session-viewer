'use strict';
// Line diffs for file edits: Edit/MultiEdit (old_string/new_string), Write (new file) and apply_patch text.
// Output: [{ file, op, lines: [{ t: '+'|'-'|' '|'@', s }] , more }]

const MAX_LINES = 600; // lines shown per file; the rest is counted in `more`
const MAX_LCS = 1500;  // above this many lines on a side, fall back to "all removed, all added"

function splitLines(s) {
  if (typeof s !== 'string' || s === '') return [];
  const a = s.split('\n');
  if (a[a.length - 1] === '') a.pop();
  return a;
}

/** Line diff of two strings with a small LCS. Returns [{t, s}]. */
function diffLines(oldStr, newStr) {
  const a = splitLines(oldStr), b = splitLines(newStr);
  // trim common head and tail
  let h = 0;
  while (h < a.length && h < b.length && a[h] === b[h]) h++;
  let ta = a.length, tb = b.length;
  while (ta > h && tb > h && a[ta - 1] === b[tb - 1]) { ta--; tb--; }
  const out = [];
  const ctxHead = a.slice(Math.max(0, h - 3), h);
  for (const s of ctxHead) out.push({ t: ' ', s });
  const A = a.slice(h, ta), B = b.slice(h, tb);
  if (A.length > MAX_LCS || B.length > MAX_LCS || A.length * B.length > 1500000) {
    for (const s of A) out.push({ t: '-', s });
    for (const s of B) out.push({ t: '+', s });
  } else {
    const n = A.length, m = B.length;
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ t: '-', s: A[i++] }); }
      else { out.push({ t: '+', s: B[j++] }); }
    }
    while (i < n) out.push({ t: '-', s: A[i++] });
    while (j < m) out.push({ t: '+', s: B[j++] });
  }
  for (const s of a.slice(ta, Math.min(a.length, ta + 3))) out.push({ t: ' ', s });
  return out;
}

function cap(file) {
  if (file.lines.length > MAX_LINES) { file.more = file.lines.length - MAX_LINES; file.lines = file.lines.slice(0, MAX_LINES); }
  return file;
}

function countStats(files) {
  let add = 0, del = 0;
  for (const f of files) for (const l of f.lines) { if (l.t === '+') add++; else if (l.t === '-') del++; }
  return { add, del };
}

/** Parses the apply_patch format ("*** Begin Patch" ... "*** End Patch"). Unknown lines are ignored. */
function parseApplyPatch(text) {
  if (typeof text !== 'string') return [];
  const at = text.indexOf('*** Begin Patch');
  if (at === -1) return [];
  const lines = text.slice(at).split('\n');
  const files = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let m;
    if ((m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line))) {
      cur = { file: m[2].trim(), op: m[1].toLowerCase(), lines: [] };
      files.push(cur);
    } else if ((m = /^\*\*\* Move to: (.+)$/.exec(line)) && cur) {
      cur.moveTo = m[1].trim();
    } else if (line.startsWith('*** End Patch')) {
      break;
    } else if (line.startsWith('*** ')) {
      continue;
    } else if (cur) {
      if (line.startsWith('@@')) cur.lines.push({ t: '@', s: line });
      else if (line.startsWith('+')) cur.lines.push({ t: '+', s: line.slice(1) });
      else if (line.startsWith('-')) cur.lines.push({ t: '-', s: line.slice(1) });
      else if (line.startsWith(' ')) cur.lines.push({ t: ' ', s: line.slice(1) });
      else if (line === '' ) continue;
    }
  }
  return files.map(cap);
}

/** Builds a diff from a tool call, or null when the tool does not edit files. */
function toolDiff(name, input) {
  if (!input || typeof input !== 'object') {
    if (typeof input === 'string' && input.includes('*** Begin Patch')) { const f = parseApplyPatch(input); return f.length ? f : null; }
    return null;
  }
  const file = typeof input.file_path === 'string' ? input.file_path : (typeof input.path === 'string' ? input.path : '');
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [cap({ file, op: 'update', lines: diffLines(input.old_string, input.new_string) })];
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const lines = [];
    input.edits.forEach((e, i) => {
      if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return;
      lines.push({ t: '@', s: `@@ edit ${i + 1} of ${input.edits.length}` });
      lines.push(...diffLines(e.old_string, e.new_string));
    });
    return lines.length ? [cap({ file, op: 'update', lines })] : null;
  }
  if ((name === 'Write' || name === 'create_file') && typeof input.content === 'string') {
    return [cap({ file, op: 'add', lines: splitLines(input.content).map((s) => ({ t: '+', s })) })];
  }
  if (name === 'NotebookEdit' && typeof input.new_source === 'string') {
    return [cap({ file: input.notebook_path || file, op: 'update', lines: splitLines(input.new_source).map((s) => ({ t: '+', s })) })];
  }
  // apply_patch passed in arguments: {input}, {patch}, {command: [...]}, {cmd: "..."}
  for (const k of ['input', 'patch', 'cmd', 'command']) {
    const v = input[k];
    const s = Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : v;
    if (typeof s === 'string' && s.includes('*** Begin Patch')) { const f = parseApplyPatch(s); if (f.length) return f; }
  }
  return null;
}

module.exports = { diffLines, parseApplyPatch, toolDiff, countStats, splitLines, MAX_LINES };
