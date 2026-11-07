'use strict';
// Finds session files. Read-only: readdir and stat only.
const fs = require('fs');
const path = require('path');
const os = require('os');

function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p.trim()) return '';
  p = p.trim();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** Folder roots for each tool. Settings win; otherwise CLAUDE_CONFIG_DIR / CODEX_HOME; otherwise ~/.claude and ~/.codex. */
function resolveRoots(settings = {}, env = process.env, home = os.homedir()) {
  const clean = (a) => (Array.isArray(a) ? a.map((x) => expandHome(x, home)).filter(Boolean) : []);
  let claude = clean(settings.claudeRoots);
  let codex = clean(settings.codexRoots);
  if (!claude.length) {
    const dirs = env.CLAUDE_CONFIG_DIR ? String(env.CLAUDE_CONFIG_DIR).split(',').map((d) => expandHome(d, home)).filter(Boolean) : [path.join(home, '.claude')];
    claude = dirs.map((d) => path.join(d, 'projects'));
  }
  if (!codex.length) codex = [path.join(env.CODEX_HOME ? expandHome(env.CODEX_HOME, home) : path.join(home, '.codex'), 'sessions')];
  return { claude: [...new Set(claude)], codex: [...new Set(codex)] };
}

async function readdirSafe(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
}
async function statSafe(file) {
  try { return await fs.promises.stat(file); } catch { return null; }
}

const MAX_META_BYTES = 64 * 1024;

/** Reads a small JSON file (a subagent's .meta.json). Returns null when missing, too big or not JSON. */
async function readSmallJson(file) {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_META_BYTES) return null;
    const v = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// Claude Code 2026 writes each subagent run to <project>/<session-id>/subagents/agent-<id>.jsonl, with an
// agent-<id>.meta.json beside it ({agentType, description, toolUseId, ...}).
async function listClaudeSubagents(dir, sessionFile, projectDir, out) {
  const sub = path.join(dir, path.basename(sessionFile, '.jsonl'), 'subagents');
  for (const f of await readdirSafe(sub)) {
    if (!f.isFile() || !/^agent-.*\.jsonl$/.test(f.name)) continue;
    const file = path.join(sub, f.name);
    const st = await statSafe(file);
    if (!st || st.size === 0) continue;
    const m = await readSmallJson(file.replace(/\.jsonl$/, '.meta.json'));
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    out.push({ file, source: 'claude', projectDir, mtimeMs: st.mtimeMs, size: st.size, parentFile: sessionFile,
      agentType: m ? str(m.agentType, 80) : '', agentDescription: m ? str(m.description, 200) : '' });
  }
}

async function listClaude(root, out, isCancelled) {
  for (const d of await readdirSafe(root)) {
    if (isCancelled()) return;
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const names = await readdirSafe(dir);
    const subdirs = new Set(names.filter((f) => f.isDirectory()).map((f) => f.name));
    for (const f of names) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.startsWith('agent-')) continue;
      const file = path.join(dir, f.name);
      const st = await statSafe(file);
      if (st && st.size > 0) out.push({ file, source: 'claude', projectDir: d.name, mtimeMs: st.mtimeMs, size: st.size });
      if (st && subdirs.has(f.name.slice(0, -6))) await listClaudeSubagents(dir, file, d.name, out);
    }
  }
}

/**
 * Codex keeps thread names (including ones the user renamed) in <CODEX_HOME>/session_index.jsonl:
 * one {id, thread_name, updated_at} per line, newest last. Returns Map id -> name. Read-only, streamed.
 */
async function readCodexTitles(codexRoots, maxBytes = 8 * 1024 * 1024) {
  const { streamLines, parseLine } = require('./lines');
  const titles = new Map();
  const seen = new Set();
  for (const r of codexRoots || []) {
    const file = path.join(path.dirname(r), 'session_index.jsonl');
    if (seen.has(file)) continue;
    seen.add(file);
    const st = await statSafe(file);
    if (!st || !st.isFile()) continue;
    try {
      await streamLines(file, (line) => {
        const v = parseLine(line);
        if (v && typeof v.id === 'string' && typeof v.thread_name === 'string' && v.thread_name.trim()) titles.set(v.id, v.thread_name.trim().slice(0, 200));
      }, { maxBytes });
    } catch { /* unreadable index: titles come from the sessions */ }
  }
  return titles;
}

async function listCodex(root, out, isCancelled, depth = 0) {
  if (depth > 5) return;
  for (const d of await readdirSafe(root)) {
    if (isCancelled()) return;
    const p = path.join(root, d.name);
    if (d.isDirectory()) await listCodex(p, out, isCancelled, depth + 1);
    else if (d.isFile() && /^rollout-.*\.jsonl$/.test(d.name)) {
      const st = await statSafe(p);
      if (st && st.size > 0) out.push({ file: p, source: 'codex', mtimeMs: st.mtimeMs, size: st.size });
    }
  }
}

/** Lists session files, newest first, at most `max`. */
async function listSessions(roots, opts = {}) {
  const isCancelled = opts.isCancelled || (() => false);
  const out = [];
  for (const r of roots.claude || []) await listClaude(r, out, isCancelled);
  for (const r of roots.codex || []) await listCodex(r, out, isCancelled);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set();
  const uniq = out.filter((e) => (seen.has(e.file) ? false : (seen.add(e.file), true)));
  return opts.max ? uniq.slice(0, opts.max) : uniq;
}

/** Decodes a Claude project folder name ("-Users-me-repo") into a readable fallback label. */
function projectLabelFromDir(name) {
  return typeof name === 'string' ? name.replace(/^-/, '/').replace(/-/g, '/') : '';
}

module.exports = { resolveRoots, listSessions, expandHome, projectLabelFromDir, readCodexTitles, readSmallJson };
