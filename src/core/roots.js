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

async function listClaude(root, out, isCancelled) {
  for (const d of await readdirSafe(root)) {
    if (isCancelled()) return;
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const f of await readdirSafe(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.startsWith('agent-')) continue;
      const file = path.join(dir, f.name);
      const st = await statSafe(file);
      if (st && st.size > 0) out.push({ file, source: 'claude', projectDir: d.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
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

module.exports = { resolveRoots, listSessions, expandHome, projectLabelFromDir };
