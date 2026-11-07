'use strict';
// Agent Session Viewer: read-only viewer for local Claude Code and Codex sessions.
// This extension never writes, moves or deletes a session file. The only file it writes is a Markdown
// export, at a path the user picks in a save dialog, and never over a .jsonl file.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { buildHtml } = require('./html');
const { loadSession, summarizeFile, detectFile } = require('./core/session');
const { resolveRoots, listSessions, projectLabelFromDir, readCodexTitles } = require('./core/roots');
const { searchSessions } = require('./core/search');
const { toMarkdown, exportFileName } = require('./core/markdown');
const { resumeCommand } = require('./core/resume');
const { validateWebviewMessage, hostMessage } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

let rating = { success() {} };
// Codex thread names from session_index.jsonl (id -> name). Memory only; refreshed with the tree.
let codexTitles = null;
async function codexTitleFor(id) {
  if (!id) return '';
  if (!codexTitles) { try { codexTitles = await readCodexTitles(resolveRoots(cfg()).codex); } catch { codexTitles = new Map(); } }
  return codexTitles.get(id) || '';
}

const VIEW_SESSION = 'agentSessionViewer.session';
const VIEW_ANY = 'agentSessionViewer.anyJsonl';

function cfg() {
  const c = vscode.workspace.getConfiguration('agentSessionViewer');
  return {
    claudeRoots: c.get('claudeRoots', []),
    codexRoots: c.get('codexRoots', []),
    maxFileSizeMB: Math.max(1, c.get('maxFileSizeMB', 256)),
    maxSessions: Math.max(10, c.get('maxSessions', 2000)),
    expandEdits: c.get('expandEdits', true),
    resumeWithCd: c.get('resumeWithCd', true),
  };
}

function shortDate(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function sizeLabel(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
function oneLine(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------------------------------------------------------------- tree

class SessionTree {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.entries = [];
    this.summaries = new Map(); // key file|mtime|size -> meta (memory only, never stored on disk)
    this.loading = false;
    this.gen = 0;
    this.view = null;
  }
  key(e) { return e.file + '|' + e.mtimeMs + '|' + e.size; }
  isSubagent(e) { if (e.parentFile) return true; const m = this.summaryOf(e); return !!(m && m.subagent); }
  summaryOf(e) { return this.summaries.get(this.key(e)); }

  async refresh() {
    const gen = ++this.gen;
    this.loading = true;
    if (this.view) this.view.message = 'Reading session folders…';
    const c = cfg();
    const roots = resolveRoots(c);
    this.roots = roots;
    let entries = [];
    try { entries = await listSessions(roots, { max: c.maxSessions }); } catch { entries = []; }
    try { codexTitles = await readCodexTitles(roots.codex); } catch { codexTitles = new Map(); }
    if (gen !== this.gen) return;
    this.entries = entries;
    // Pass 1: first 256 KB of each file for project, title and first prompt.
    const todo = entries.filter((e) => !this.summaryOf(e));
    let i = 0;
    const worker = async () => {
      while (i < todo.length && gen === this.gen) {
        const e = todo[i++];
        try { const m = await summarizeFile(e.file, { format: e.source }); if (m) this.summaries.set(this.key(e), m); } catch { /* unreadable */ }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (gen !== this.gen) return;
    this.loading = false;
    if (this.view) this.view.message = entries.length ? undefined : 'No sessions found. Check the folder settings.';
    this._emitter.fire();
    // Pass 2: full read of partly read files (for turn counts and late titles), one at a time.
    const limit = c.maxFileSizeMB * 1048576;
    const partial = entries.filter((e) => { const m = this.summaryOf(e); return m && m.partial && e.size <= limit; });
    let last = Date.now();
    for (const e of partial) {
      if (gen !== this.gen) return;
      try { const m = await summarizeFile(e.file, { format: e.source, maxBytes: limit }); if (m) this.summaries.set(this.key(e), m); } catch { /* skip */ }
      if (Date.now() - last > 1500) { last = Date.now(); this._emitter.fire(); }
    }
    if (gen === this.gen) this._emitter.fire();
  }

  getTreeItem(n) { return n.item; }

  getChildren(n) {
    if (!n) {
      if (this.loading && !this.entries.length) return [];
      const out = [];
      for (const [source, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
        const es = this.entries.filter((e) => e.source === source);
        const subs = es.filter((e) => this.isSubagent(e)).length;
        const main = es.length - subs;
        const it = new vscode.TreeItem(label, es.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        it.description = es.length ? `${main} session${main === 1 ? '' : 's'}` + (subs ? ` · ${subs} subagent${subs === 1 ? '' : 's'}` : '') : 'no sessions found';
        it.iconPath = new vscode.ThemeIcon(source === 'claude' ? 'sparkle' : 'terminal');
        it.contextValue = 'source';
        it.tooltip = (this.roots ? this.roots[source] : []).join('\n');
        out.push({ kind: 'source', source, item: it, entries: es });
      }
      return out;
    }
    if (n.kind === 'source') {
      const groups = new Map();
      const keyOf = new Map();
      const keyFor = (e) => { const m = this.summaryOf(e); return (m && m.cwd) || (e.projectDir ? projectLabelFromDir(e.projectDir) : '(unknown folder)'); };
      for (const e of n.entries) if (!e.parentFile) keyOf.set(e.file, keyFor(e));
      for (const e of n.entries) {
        // A Claude Code subagent file goes in the same folder group as the session that started it.
        const key = (e.parentFile && keyOf.get(e.parentFile)) || keyOf.get(e.file) || keyFor(e);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      return [...groups.entries()].map(([cwd, es]) => {
        const it = new vscode.TreeItem(path.basename(cwd) || cwd, vscode.TreeItemCollapsibleState.Collapsed);
        it.description = `${es.length} · ${shortDate(es[0].mtimeMs)}`;
        it.tooltip = cwd;
        it.iconPath = vscode.ThemeIcon.Folder;
        it.contextValue = 'project';
        it.id = n.source + ':' + cwd;
        return { kind: 'project', item: it, entries: es, latest: es[0].mtimeMs };
      }).sort((a, b) => b.latest - a.latest);
    }
    if (n.kind === 'project') {
      // Codex subagent threads sit under the session that started them when that session is in the same folder.
      const byId = new Map();
      const byFile = new Map();
      for (const e of n.entries) { const m = this.summaryOf(e); if (m && m.id && !m.parentId && !e.parentFile && e.source === 'codex') byId.set(m.id, e); if (!e.parentFile) byFile.set(e.file, e); }
      const kids = new Map();
      const top = [];
      for (const e of n.entries) {
        const m = this.summaryOf(e);
        const parent = e.parentFile ? byFile.get(e.parentFile) : (m && m.parentId ? byId.get(m.parentId) : null);
        if (parent && parent !== e) { if (!kids.has(parent.file)) kids.set(parent.file, []); kids.get(parent.file).push(e); }
        else top.push(e);
      }
      return top.map((e) => this.sessionNode(e, kids.get(e.file) || []));
    }
    if (n.kind === 'session' && n.children) return n.children.map((e) => this.sessionNode(e, []));
    return [];
  }

  sessionNode(e, children = []) {
    const m = this.summaryOf(e);
    const title = m ? ((e.source === 'codex' && codexTitles && codexTitles.get(m.id)) || m.title) : '';
    let label = m ? oneLine(title || m.firstPrompt || path.basename(e.file), 70) : path.basename(e.file);
    if (this.isSubagent(e)) {
      const who = e.agentType || (m && m.agent) || '';
      const what = e.agentDescription || title || (m && m.firstPrompt) || '';
      label = oneLine('Subagent' + (who ? ' ' + who : '') + (what ? ': ' + what : ''), 90);
    }
    const it = new vscode.TreeItem(label || path.basename(e.file), children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const turns = m ? `${m.turns}${m.partial ? '+' : ''} turn${m.turns === 1 ? '' : 's'}` : '';
    it.description = [shortDate(e.mtimeMs), turns, sizeLabel(e.size), children.length ? `${children.length} subagent${children.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    it.tooltip = [m && m.firstPrompt ? oneLine(m.firstPrompt, 300) : '', e.file].filter(Boolean).join('\n\n');
    it.resourceUri = vscode.Uri.file(e.file);
    it.iconPath = new vscode.ThemeIcon(this.isSubagent(e) ? 'symbol-namespace' : 'comment-discussion');
    it.contextValue = 'session';
    it.id = e.file;
    it.command = { command: 'agentSessionViewer.open', title: 'Open Session', arguments: [vscode.Uri.file(e.file)] };
    return { kind: 'session', item: it, entry: e, children };
  }
}

// ---------------------------------------------------------------- custom editor

class SessionEditor {
  constructor(context) {
    this.context = context;
    this.panels = new Map(); // fsPath -> state
    this.pendingFocus = new Map();
    this.active = null;
  }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(doc, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, enableCommandUris: commandUris('agentSessionViewer'), localResourceRoots: [media] };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'session.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'session.css')).toString(),
      title: path.basename(doc.uri.fsPath),
      showSupportLinks: showLinks(vscode, 'agentSessionViewer'),
    });
    const st = { uri: doc.uri, panel, items: [], meta: null, format: null, loading: null, cancelled: false, error: null };
    this.panels.set(doc.uri.fsPath, st);
    this.active = st;
    panel.onDidChangeViewState(() => { if (panel.active) this.active = st; });
    panel.onDidDispose(() => { st.cancelled = true; st.items = []; this.panels.delete(doc.uri.fsPath); if (this.active === st) this.active = null; });
    panel.webview.onDidReceiveMessage((raw) => {
      const m = validateWebviewMessage(raw);
      if (!m) return;
      if (m.type === 'ready') this.send(st);
      else if (m.type === 'copyResume') copyResume(st.meta);
      else if (m.type === 'resumeTerminal') resumeInTerminal(st.meta);
      else if (m.type === 'export') exportMarkdown(st.uri, st);
      else if (m.type === 'openRaw') openRaw(st.uri);
      else if (m.type === 'copy') vscode.env.clipboard.writeText(m.text);
    });
  }

  post(st, type, body) { if (!st.cancelled) st.panel.webview.postMessage(hostMessage(type, body)); }

  async send(st) {
    const c = cfg();
    this.post(st, 'init', { fileName: path.basename(st.uri.fsPath), expandEdits: c.expandEdits });
    if (st.meta) {
      // Webview was reloaded: replay from memory.
      for (let i = 0; i < st.items.length; i += 500) this.post(st, 'items', { items: st.items.slice(i, i + 500) });
      this.finish(st);
      return;
    }
    if (st.error) { this.post(st, 'error', { message: st.error }); return; }
    if (st.loading) return;
    st.loading = this.load(st, c).finally(() => { st.loading = null; });
  }

  async load(st, c) {
    const file = st.uri.fsPath;
    try {
      const stat = await fs.promises.stat(file);
      const limit = c.maxFileSizeMB * 1048576;
      const format = await detectFile(file);
      if (!format) {
        st.error = 'This file does not look like a Claude Code or Codex session (checked the first 20 records). Use "Open as text" to read it.';
        this.post(st, 'error', { message: st.error });
        return;
      }
      const { meta } = await loadSession(file, {
        format,
        maxBytes: limit,
        isCancelled: () => st.cancelled,
        onItems: (batch) => { st.items.push(...batch); this.post(st, 'items', { items: batch }); },
      });
      meta.fileBytes = stat.size;
      if (format === 'codex') { const name = await codexTitleFor(meta.id); if (name) meta.title = name; }
      st.meta = meta;
      this.finish(st);
      if (!st.cancelled) rating.success(); // once per tab: a reload replays from memory and does not come here
    } catch (err) {
      st.error = 'Could not read this session: ' + (err && err.message ? err.message : String(err));
      this.post(st, 'error', { message: st.error });
    }
  }

  finish(st) {
    const c = cfg();
    this.post(st, 'done', { meta: st.meta, resume: resumeCommand(st.meta, { withCd: c.resumeWithCd }) });
    const f = this.pendingFocus.get(st.uri.fsPath);
    if (f) { this.pendingFocus.delete(st.uri.fsPath); this.post(st, 'focus', f); }
  }

  /** Jumps to a line; `query` (from Search Sessions) is put in the session's find box and its matches are counted. */
  focus(uri, line, query) {
    const st = this.panels.get(uri.fsPath);
    const f = { line };
    if (typeof query === 'string' && query.trim()) f.query = query.slice(0, 200);
    // A hidden panel has no live webview (retainContextWhenHidden is off): a message posted now is lost.
    // Keep the line and send it after the webview reloads and the session is replayed (see finish).
    if (st && st.meta && st.panel.visible) this.post(st, 'focus', f);
    else this.pendingFocus.set(uri.fsPath, f);
  }
}

// ---------------------------------------------------------------- actions

function uriFrom(arg, editor) {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && arg.entry) return vscode.Uri.file(arg.entry.file);
  if (arg && arg.resourceUri) return arg.resourceUri;
  if (editor && editor.active) return editor.active.uri;
  return null;
}

async function metaFor(uri, editor) {
  const st = editor.panels.get(uri.fsPath);
  if (st && st.meta) return { meta: st.meta, items: st.items };
  const items = [];
  const { meta } = await loadSession(uri.fsPath, { maxBytes: cfg().maxFileSizeMB * 1048576, onItems: (b) => items.push(...b) });
  return { meta, items };
}

async function copyResume(meta) {
  const cmd = resumeCommand(meta, { withCd: cfg().resumeWithCd });
  if (!cmd) { vscode.window.showWarningMessage('No session id found in this file, so there is no resume command.'); return; }
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage('Copied: ' + cmd);
}

/** Opens a terminal in the session's project folder and types the resume command. Nothing else is run. */
async function resumeInTerminal(meta) {
  const cmd = resumeCommand(meta, { withCd: false });
  if (!cmd) { vscode.window.showWarningMessage('No session id found in this file, so there is no resume command.'); return null; }
  let cwd;
  if (meta.cwd) { try { if ((await fs.promises.stat(meta.cwd)).isDirectory()) cwd = meta.cwd; } catch { /* folder gone */ } }
  const label = oneLine(meta.title || meta.firstPrompt || meta.id, 32);
  const term = vscode.window.createTerminal({ name: (meta.format === 'codex' ? 'Codex: ' : 'Claude Code: ') + label, cwd });
  term.show();
  term.sendText(cmd, true);
  if (meta.cwd && !cwd) vscode.window.showWarningMessage(`The project folder ${meta.cwd} does not exist any more, so the terminal opened in the default folder. ${meta.format === 'codex' ? 'Codex' : 'Claude Code'} may not find the session from there.`);
  return { cmd, cwd };
}

async function exportMarkdown(uri, st, editor) {
  const pick = await vscode.window.showWarningMessage(
    'Session transcripts can hold secrets, tokens and private paths. Check the Markdown file before you share it.',
    { modal: true }, 'Export', 'Export without tool outputs');
  if (!pick) return;
  let data;
  try { data = st && st.meta ? { meta: st.meta, items: st.items } : await metaFor(uri, editor); }
  catch (e) { vscode.window.showErrorMessage('Could not read the session: ' + e.message); return; }
  const base = path.basename(uri.fsPath).replace(/\.jsonl$/i, '');
  const defaultDir = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri) || vscode.Uri.file(require('os').homedir());
  const picked = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(defaultDir, base + '.md'), filters: { Markdown: ['md'] }, saveLabel: 'Export' });
  if (!picked) return;
  // The simple save dialog appends ".md" to what was typed: fix "x.md.md" and refuse "x.jsonl.md".
  const fixed = exportFileName(path.posix.basename(picked.path));
  if (fixed.error) { vscode.window.showErrorMessage(fixed.error); return; }
  const target = vscode.Uri.joinPath(picked, '..', fixed.name);
  if (path.resolve(target.fsPath) === path.resolve(uri.fsPath)) {
    vscode.window.showErrorMessage('Pick a .md file. Agent Session Viewer never writes over a session file.');
    return;
  }
  const md = toMarkdown(data.meta, data.items, { stripToolOutputs: pick === 'Export without tool outputs' });
  await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
  const open = await vscode.window.showInformationMessage('Exported ' + path.basename(target.fsPath), 'Open');
  if (open) vscode.window.showTextDocument(target);
}

async function openRaw(uri) {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  // Keep the raw view read-only so a stray keystroke cannot change the session file.
  try { await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession'); } catch { /* older VS Code */ }
}

async function runSearch(tree, editor) {
  const query = await vscode.window.showInputBox({ prompt: 'Search all sessions (prompts, replies, tool calls and outputs)', placeHolder: 'text to find' });
  if (!query || !query.trim()) return;
  if (!tree.entries.length) await tree.refresh();
  const c = cfg();
  const hits = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Searching sessions for "${oneLine(query, 40)}"`, cancellable: true }, async (progress, token) => {
    let lastPct = 0;
    const res = await searchSessions(tree.entries, query, {
      isCancelled: () => token.isCancellationRequested,
      maxBytes: c.maxFileSizeMB * 1048576,
      onProgress: (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct > lastPct) { progress.report({ increment: pct - lastPct, message: `${done} of ${total} files` }); lastPct = pct; }
      },
    });
    if (res.cancelled) vscode.window.showInformationMessage(`Search cancelled after ${res.files} files. Showing ${res.hits.length} results found so far.`);
    return res.hits;
  });
  if (!hits.length) { vscode.window.showInformationMessage(`No session contains "${oneLine(query, 60)}".`); return; }
  const picks = hits.map((h) => {
    const e = tree.entries.find((x) => x.file === h.file);
    const m = e ? tree.summaryOf(e) : null;
    return {
      label: oneLine(h.snippet, 140),
      description: `${h.source === 'codex' ? 'Codex' : 'Claude Code'} · ${h.kind} · ${path.basename(h.cwd || '') || ''}`,
      detail: oneLine((m && (m.title || m.firstPrompt)) || path.basename(h.file), 120) + (e ? ' · ' + shortDate(e.mtimeMs) : ''),
      hit: h,
    };
  });
  const sel = await vscode.window.showQuickPick(picks, { matchOnDescription: true, matchOnDetail: true, placeHolder: `${hits.length} result${hits.length === 1 ? '' : 's'}${hits.length >= 300 ? ' (first 300)' : ''}` });
  if (!sel) return;
  const uri = vscode.Uri.file(sel.hit.file);
  editor.focus(uri, sel.hit.line, query.trim());
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_SESSION);
}

// ---------------------------------------------------------------- activate

function activate(context) {
  registerSupport({ vscode, context, prefix: 'agentSessionViewer', selfId: 'zovo.agent-session-viewer' });
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.agent-session-viewer', section: 'agentSessionViewer', message: (n) => `Agent Session Viewer has opened ${n} sessions for you. A rating helps other people find it.` });
  const tree = new SessionTree();
  const view = vscode.window.createTreeView('agentSessionViewer.sessions', { treeDataProvider: tree, showCollapseAll: true });
  tree.view = view;
  const editor = new SessionEditor(context);
  const opts = { webviewOptions: { enableFindWidget: true, retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: true };
  context.subscriptions.push(
    view,
    vscode.window.registerCustomEditorProvider(VIEW_SESSION, editor, opts),
    vscode.window.registerCustomEditorProvider(VIEW_ANY, editor, opts),
    vscode.commands.registerCommand('agentSessionViewer.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('agentSessionViewer.open', (arg) => {
      const uri = uriFrom(arg);
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_SESSION);
    }),
    vscode.commands.registerCommand('agentSessionViewer.openFile', async () => {
      const r = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Session files': ['jsonl'] }, openLabel: 'Open Session' });
      if (r && r[0]) return vscode.commands.executeCommand('vscode.openWith', r[0], VIEW_SESSION);
    }),
    vscode.commands.registerCommand('agentSessionViewer.search', () => runSearch(tree, editor)),
    vscode.commands.registerCommand('agentSessionViewer.copyResume', async (arg) => {
      const uri = uriFrom(arg, editor);
      if (!uri) return;
      try {
        const st = editor.panels.get(uri.fsPath);
        const meta = st && st.meta ? st.meta : await summarizeFile(uri.fsPath, { maxBytes: 1024 * 1024 });
        await copyResume(meta);
      } catch (e) { vscode.window.showErrorMessage(e.message); }
    }),
    vscode.commands.registerCommand('agentSessionViewer.resumeInTerminal', async (arg) => {
      const uri = uriFrom(arg, editor);
      if (!uri) return;
      try {
        const st = editor.panels.get(uri.fsPath);
        const meta = st && st.meta ? st.meta : await summarizeFile(uri.fsPath, { maxBytes: 1024 * 1024 });
        return await resumeInTerminal(meta);
      } catch (e) { vscode.window.showErrorMessage(e.message); }
    }),
    vscode.commands.registerCommand('agentSessionViewer.exportMarkdown', (arg) => {
      const uri = uriFrom(arg, editor);
      if (uri) return exportMarkdown(uri, editor.panels.get(uri.fsPath), editor);
    }),
    vscode.commands.registerCommand('agentSessionViewer.openRaw', (arg) => { const uri = uriFrom(arg, editor); if (uri) return openRaw(uri); }),
    vscode.commands.registerCommand('agentSessionViewer.reveal', (arg) => { const uri = uriFrom(arg, editor); if (uri) return vscode.commands.executeCommand('revealFileInOS', uri); }),
    vscode.commands.registerCommand('agentSessionViewer.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'agentSessionViewer')),
    vscode.commands.registerCommand('agentSessionViewer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.agent-session-viewer#agentSessionViewer.start', false)),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('agentSessionViewer')) tree.refresh(); }),
  );
  // Watch the roots and refresh the tree a few seconds after a change. Watching is read-only.
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (view.visible) tree.refresh(); else tree.stale = true; }, 4000); };
  const watchers = [];
  const rewatch = () => {
    watchers.splice(0).forEach((w) => w.dispose());
    const roots = resolveRoots(cfg());
    for (const r of [...roots.claude, ...roots.codex]) {
      try {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(r), '**/*.jsonl'), false, false, false);
        // Deletes too: a session removed by the user or by the tool's own cleanup must leave the tree.
        w.onDidCreate(later); w.onDidChange(later); w.onDidDelete(later);
        watchers.push(w);
      } catch { /* root missing */ }
    }
  };
  rewatch();
  context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.dispose()) });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('agentSessionViewer')) rewatch(); }));
  context.subscriptions.push(view.onDidChangeVisibility(() => { if (view.visible && (tree.stale || !tree.entries.length)) { tree.stale = false; tree.refresh(); } }));
  if (view.visible) tree.refresh();
}

function deactivate() {}

module.exports = { activate, deactivate, SessionTree, SessionEditor };
