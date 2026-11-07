'use strict';
// Drives activate(), the tree and the custom editor against a small mock of the VS Code API.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const h = require('./helpers');

const commands = new Map();
const providers = new Map();
const watchers = [];
const watcherArgs = [];
const clipboard = [];
const config = {
  claudeRoots: [path.join(h.FIX, 'claude', 'projects')],
  codexRoots: [path.join(h.FIX, 'codex', 'sessions')],
};
class Uri {
  constructor(p) { this.fsPath = p; this.path = p; }
  static file(p) { return new Uri(p); }
  static joinPath(u, ...a) { return new Uri(path.join(u.fsPath, ...a)); }
  toString() { return 'file://' + this.fsPath; }
}
class EventEmitter { constructor() { this.l = []; this.event = (f) => this.l.push(f); } fire(x) { this.l.forEach((f) => f(x)); } }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
const disp = { dispose() {} };
const vscode = {
  Uri, EventEmitter, TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: Object.assign(class { constructor(id) { this.id = id; } }, { Folder: 'folder' }),
  RelativePattern: class { constructor(b, p) { this.b = b; this.p = p; } },
  ProgressLocation: { Notification: 15 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
    onDidChangeConfiguration: () => disp,
    createFileSystemWatcher: (...args) => { watcherArgs.push(args); const w = { on: {}, dispose() {} }; for (const k of ['onDidCreate', 'onDidChange', 'onDidDelete']) w[k] = (f) => { w.on[k] = f; }; watchers.push(w); return w; },
    fs: { writeFile: async () => { throw new Error('no writes in this test'); } },
  },
  window: {
    createTreeView: (id, o) => ({ ...disp, visible: false, onDidChangeVisibility: () => disp, provider: o.treeDataProvider }),
    registerCustomEditorProvider: (id, p) => { providers.set(id, p); return disp; },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  commands: { registerCommand: (id, f) => { commands.set(id, f); return disp; }, executeCommand: async () => undefined },
  env: { clipboard: { writeText: async (t) => { clipboard.push(t); } } },
};
const origLoad = Module._load;
Module._load = function (req, ...a) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...a); };
const ext = require('../src/extension');
Module._load = origLoad;

function fakePanel() {
  const posted = [];
  let onMsg = null;
  const panel = {
    active: true,
    visible: true,
    webview: { options: null, html: '', cspSource: 'vscode-webview:', asWebviewUri: (u) => u, postMessage: (m) => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { onMsg = f; return disp; } },
    onDidChangeViewState: () => disp,
    onDidDispose: () => disp,
  };
  return { panel, posted, send: (m) => onMsg(m) };
}
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('activate registers commands and both custom editors', () => {
  ext.activate({ subscriptions: [], extensionUri: Uri.file(path.join(__dirname, '..')) });
  for (const c of ['agentSessionViewer.refresh', 'agentSessionViewer.search', 'agentSessionViewer.copyResume', 'agentSessionViewer.exportMarkdown', 'agentSessionViewer.openFile']) assert.ok(commands.has(c), c);
  assert.ok(providers.has('agentSessionViewer.session'));
  assert.ok(providers.has('agentSessionViewer.anyJsonl'));
});

test('tree groups sessions by tool and project', async () => {
  const tree = new ext.SessionTree();
  await tree.refresh();
  const roots = tree.getChildren();
  assert.deepStrictEqual(roots.map((r) => [r.item.label, r.item.description]), [['Claude Code', '3 sessions · 1 subagent'], ['Codex', '1 session · 1 subagent']]);
  const projects = tree.getChildren(roots[0]);
  assert.deepStrictEqual(projects.map((p) => p.item.label), ['demo']);
  const sessions = tree.getChildren(projects[0]);
  assert.strictEqual(sessions.length, 3, 'the subagent file is not a top-level session');
  const qa = sessions.find((s) => s.item.label === 'Explain the forecast cache');
  assert.ok(qa, 'title from summary record');
  assert.match(qa.item.description, /2 turns/);
});

test('a Codex subagent thread sits under the session that started it, with its nickname and task', async () => {
  const tree = new ext.SessionTree();
  await tree.refresh();
  const codex = tree.getChildren()[1];
  const [project] = tree.getChildren(codex);
  const top = tree.getChildren(project);
  assert.strictEqual(top.length, 1, 'only the main thread at the top');
  assert.strictEqual(top[0].item.label, 'Flag rename: --city to --place', 'thread name from session_index.jsonl, last line wins');
  assert.strictEqual(top[0].item.collapsibleState, 1, 'parent can be expanded');
  assert.match(top[0].item.description, /1 subagent/);
  const kids = tree.getChildren(top[0]);
  assert.strictEqual(kids.length, 1);
  assert.strictEqual(kids[0].item.label, 'Subagent Hume: Check that docs/flags.md lists every flag in src/cli.js.');
  assert.strictEqual(kids[0].item.contextValue, 'session');
  assert.deepStrictEqual(tree.getChildren(kids[0]), []);
});

test('a Claude Code subagent file sits under its session, named from its .meta.json', async () => {
  const tree = new ext.SessionTree();
  await tree.refresh();
  const [project] = tree.getChildren(tree.getChildren()[0]);
  const top = tree.getChildren(project);
  const parent = top.find((s) => s.entry.file === h.TOOLS);
  assert.ok(parent);
  assert.strictEqual(parent.item.collapsibleState, 1);
  assert.match(parent.item.description, /1 subagent$/);
  const [kid] = tree.getChildren(parent);
  assert.strictEqual(kid.item.label, 'Subagent Explore: Check error handling of callers');
  assert.match(kid.entry.file, /subagents[\\/]agent-a7c41d2e9b\.jsonl$/);
  for (const s of top.filter((x) => x !== parent)) assert.strictEqual(s.item.collapsibleState, 0);
});

test('a Claude Code subagent file opens as its own session, not indented, with the parent id for resume', async () => {
  const f = path.join(path.dirname(h.TOOLS), '22222222-2222-4222-8222-222222222222', 'subagents', 'agent-a7c41d2e9b.jsonl');
  const { meta, items } = await h.load(f);
  assert.strictEqual(meta.subagent, true);
  assert.strictEqual(meta.agentId, 'a7c41d2e9b');
  assert.strictEqual(meta.turns, 1);
  assert.strictEqual(meta.firstPrompt, 'Check that every caller of fetchForecast handles the new error.');
  assert.ok(items.every((x) => !x.side), 'not drawn as a sidechain');
  assert.strictEqual(meta.id, '22222222-2222-4222-8222-222222222222');
  assert.deepStrictEqual(meta.models, ['claude-haiku-4-5']);
  // the main session still indents its in-file sidechain turns
  const main = await h.load(h.TOOLS);
  assert.ok(main.items.some((x) => x.side));
  assert.ok(!main.meta.subagent);
});

test('the session view of a Codex thread uses its name from session_index.jsonl', async () => {
  const p = providers.get('agentSessionViewer.session');
  const fp = fakePanel();
  await p.resolveCustomEditor(p.openCustomDocument(Uri.file(h.CODEX)), fp.panel);
  fp.send({ type: 'ready' });
  await until(() => fp.posted.some((m) => m.type === 'done'));
  assert.strictEqual(fp.posted.find((m) => m.type === 'done').meta.title, 'Flag rename: --city to --place');
});

test('Resume in terminal opens a terminal in the project folder and types only the resume command', async () => {
  const fs = require('fs');
  const os = require('os');
  const terms = [];
  const warnings = [];
  const savedWarn = vscode.window.showWarningMessage;
  vscode.window.createTerminal = (o) => { const t = { o, shown: false, sent: [], show() { this.shown = true; }, sendText(x, nl) { this.sent.push([x, nl]); } }; terms.push(t); return t; };
  vscode.window.showWarningMessage = async (m) => { warnings.push(m); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asv-term-'));
  try {
    // A copy of the Codex fixture whose cwd is a real folder.
    const src = fs.readFileSync(h.CODEX, 'utf8').split('/tmp/demo').join(dir);
    const f = path.join(dir, 'rollout-2026-11-06T09-12-00-0199aa00-1111-7222-8333-444455556666.jsonl');
    fs.writeFileSync(f, src);
    const r = await commands.get('agentSessionViewer.resumeInTerminal')(Uri.file(f));
    assert.strictEqual(terms.length, 1);
    assert.strictEqual(terms[0].o.cwd, dir);
    assert.match(terms[0].o.name, /^Codex: Rename the --city flag/);
    assert.deepStrictEqual(terms[0].sent, [['codex resume 0199aa00-1111-7222-8333-444455556666', true]]);
    assert.ok(terms[0].shown);
    assert.strictEqual(r.cmd, 'codex resume 0199aa00-1111-7222-8333-444455556666');
    assert.strictEqual(warnings.length, 0);
    // The Claude fixture's folder /tmp/demo does not exist: default folder plus a warning, never a failure.
    await commands.get('agentSessionViewer.resumeInTerminal')(Uri.file(h.TOOLS));
    assert.strictEqual(terms.length, 2);
    assert.strictEqual(terms[1].o.cwd, undefined);
    assert.deepStrictEqual(terms[1].sent, [['claude --resume 22222222-2222-4222-8222-222222222222', true]]);
    assert.match(warnings[0], /does not exist any more/);
    // From the webview button.
    const p = providers.get('agentSessionViewer.session');
    const fp = fakePanel();
    await p.resolveCustomEditor(p.openCustomDocument(Uri.file(f)), fp.panel);
    assert.match(fp.panel.webview.html, /id="btn-term"/);
    fp.send({ type: 'ready' });
    await until(() => fp.posted.some((m) => m.type === 'done'));
    fp.send({ type: 'resumeTerminal' });
    await until(() => terms.length === 3);
    assert.deepStrictEqual(terms[2].sent, [['codex resume 0199aa00-1111-7222-8333-444455556666', true]]);
  } finally {
    vscode.window.showWarningMessage = savedWarn;
    delete vscode.window.createTerminal;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('custom editor streams a session to the webview and ignores bad messages', async () => {
  const p = providers.get('agentSessionViewer.session');
  const fp = fakePanel();
  await p.resolveCustomEditor(p.openCustomDocument(Uri.file(h.TOOLS)), fp.panel);
  assert.match(fp.panel.webview.html, /Content-Security-Policy/);
  assert.strictEqual(fp.panel.webview.options.enableScripts, true);
  fp.send({ type: 'evil', path: '/etc/passwd' });
  fp.send({ type: 'ready' });
  await until(() => fp.posted.some((m) => m.type === 'done'));
  const types = fp.posted.map((m) => m.type);
  assert.strictEqual(types[0], 'init');
  assert.ok(types.includes('items'));
  const done = fp.posted.find((m) => m.type === 'done');
  assert.strictEqual(done.resume, 'cd /tmp/demo && claude --resume 22222222-2222-4222-8222-222222222222');
  fp.send({ type: 'copyResume' });
  await until(() => clipboard.length);
  assert.strictEqual(clipboard[0], done.resume);
  // reload replays from memory
  const before = fp.posted.length;
  fp.send({ type: 'ready' });
  await until(() => fp.posted.slice(before).some((m) => m.type === 'done'));
});

test('custom editor explains when a .jsonl is not a session', async () => {
  const p = providers.get('agentSessionViewer.anyJsonl');
  const fp = fakePanel();
  await p.resolveCustomEditor(p.openCustomDocument(Uri.file(h.OTHER)), fp.panel);
  fp.send({ type: 'ready' });
  await until(() => fp.posted.some((m) => m.type === 'error'));
  assert.match(fp.posted.find((m) => m.type === 'error').message, /does not look like a Claude Code or Codex session/);
});

test('a search hit in a hidden session tab is shown after the webview reloads', async () => {
  const p = providers.get('agentSessionViewer.session');
  const fp = fakePanel();
  await p.resolveCustomEditor(p.openCustomDocument(Uri.file(h.TOOLS)), fp.panel);
  fp.send({ type: 'ready' });
  await until(() => fp.posted.some((m) => m.type === 'done'));
  // the tab goes to the background: its webview is gone, so a focus message must wait for the reload
  fp.panel.visible = false;
  const before = fp.posted.length;
  p.focus(Uri.file(h.TOOLS), 3);
  assert.ok(!fp.posted.slice(before).some((m) => m.type === 'focus'), 'nothing posted to a hidden webview');
  fp.panel.visible = true;
  fp.send({ type: 'ready' });
  await until(() => fp.posted.slice(before).some((m) => m.type === 'focus'));
  const after = fp.posted.slice(before).map((m) => m.type);
  assert.ok(after.indexOf('focus') > after.indexOf('done'), 'focus comes after the replay');
  assert.strictEqual(fp.posted.slice(before).find((m) => m.type === 'focus').line, 3);
  // a visible panel gets the focus message at once
  const n = fp.posted.length;
  p.focus(Uri.file(h.TOOLS), 5);
  assert.strictEqual(fp.posted.slice(n).find((m) => m.type === 'focus').line, 5);
  // a Search Sessions query travels with the jump, so the session's find box shows it
  const k = fp.posted.length;
  p.focus(Uri.file(h.TOOLS), 7, 'backoff');
  assert.deepStrictEqual(fp.posted.slice(k).find((m) => m.type === 'focus'), { type: 'focus', line: 7, query: 'backoff' });
  fp.panel.visible = false;
  p.focus(Uri.file(h.TOOLS), 9, '  ');
  fp.panel.visible = true;
  const j = fp.posted.length;
  fp.send({ type: 'ready' });
  await until(() => fp.posted.slice(j).some((m) => m.type === 'focus'));
  assert.deepStrictEqual(fp.posted.slice(j).find((m) => m.type === 'focus'), { type: 'focus', line: 9 }, 'blank query is dropped');
});

test('the session-folder watchers react to new, changed and deleted session files', () => {
  assert.ok(watchers.length >= 1, 'a watcher per root');
  for (const a of watcherArgs) assert.strictEqual(a[3], false, 'delete events are not ignored');
  for (const w of watchers) for (const k of ['onDidCreate', 'onDidChange', 'onDidDelete']) assert.strictEqual(typeof w.on[k], 'function', k);
});

test('export through the simple save dialog writes one .md and never a .jsonl name', async () => {
  const dir = path.join(h.FIX, 'claude', 'projects', '-tmp-demo');
  const writes = [];
  const errors = [];
  const saved = { save: vscode.window.showSaveDialog, warn: vscode.window.showWarningMessage, err: vscode.window.showErrorMessage, write: vscode.workspace.fs.writeFile };
  let answer;
  vscode.window.showSaveDialog = async () => answer;
  vscode.window.showWarningMessage = async () => 'Export';
  vscode.window.showErrorMessage = async (m) => { errors.push(m); };
  vscode.workspace.fs.writeFile = async (u, b) => { writes.push([u.fsPath, b.length]); };
  try {
    const run = () => commands.get('agentSessionViewer.exportMarkdown')(Uri.file(h.TOOLS));
    answer = Uri.file(path.join(dir, 'notes.md.md'));
    await run();
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], path.join(dir, 'notes.md'));
    assert.ok(writes[0][1] > 100);
    for (const name of ['evil.jsonl.md', 'evil.jsonl', path.basename(h.TOOLS)]) {
      answer = Uri.file(path.join(dir, name));
      await run();
    }
    assert.equal(writes.length, 1, 'no write for a .jsonl name');
    assert.equal(errors.length, 3);
  } finally {
    vscode.window.showSaveDialog = saved.save; vscode.window.showWarningMessage = saved.warn;
    vscode.window.showErrorMessage = saved.err; vscode.workspace.fs.writeFile = saved.write;
  }
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = require('../package.json');
  const support = require('../src/support');
  assert.strictEqual(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.strictEqual(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('agentSessionViewer.supportDeveloper') && ids.includes('agentSessionViewer.moreViewers'));
  const props = Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties));
  assert.strictEqual(props['agentSessionViewer.showSupportLinks'].default, true);
  assert.ok(commands.has('agentSessionViewer.supportDeveloper') && commands.has('agentSessionViewer.moreViewers'));
  assert.ok(support.otherProducts('zovo.agent-session-viewer').every((x) => x.id !== 'zovo.agent-session-viewer'));
});

test('support: the footer shows by default and agentSessionViewer.showSupportLinks=false hides it', async () => {
  const p = providers.get('agentSessionViewer.session');
  try {
    for (const [value, shown] of [[undefined, true], [false, false]]) {
      if (value === undefined) delete config.showSupportLinks; else config.showSupportLinks = value;
      const fp = fakePanel();
      await p.resolveCustomEditor(p.openCustomDocument(Uri.file(h.TOOLS)), fp.panel);
      const html = fp.panel.webview.html;
      assert.strictEqual(/id="zovo-support"/.test(html), shown, String(value));
      assert.strictEqual(html.includes('command:agentSessionViewer.supportDeveloper'), shown);
      assert.deepStrictEqual(fp.panel.webview.options.enableCommandUris, ['agentSessionViewer.supportDeveloper', 'agentSessionViewer.moreViewers', 'workbench.action.openSettings']);
      assert.strictEqual((html.match(/<script/g) || []).length, 1);
    }
  } finally { delete config.showSupportLinks; }
});

test('Resume in terminal on a Claude Code subagent names the terminal for the parent session it resumes', async () => {
  const terms = [];
  const savedWarn = vscode.window.showWarningMessage;
  vscode.window.createTerminal = (o) => { const t = { o, sent: [], show() {}, sendText(x, nl) { this.sent.push([x, nl]); } }; terms.push(t); return t; };
  vscode.window.showWarningMessage = async () => {};
  try {
    const sub = path.join(path.dirname(h.TOOLS), '22222222-2222-4222-8222-222222222222', 'subagents', 'agent-a7c41d2e9b.jsonl');
    await commands.get('agentSessionViewer.resumeInTerminal')(Uri.file(sub));
    assert.strictEqual(terms.length, 1);
    assert.match(terms[0].o.name, /^Claude Code \(parent session\): /);
    assert.deepStrictEqual(terms[0].sent, [['claude --resume 22222222-2222-4222-8222-222222222222', true]]);
  } finally { vscode.window.showWarningMessage = savedWarn; }
});
