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
  assert.deepStrictEqual(roots.map((r) => [r.item.label, r.item.description]), [['Claude Code', '3 sessions'], ['Codex', '1 session']]);
  const projects = tree.getChildren(roots[0]);
  assert.deepStrictEqual(projects.map((p) => p.item.label), ['demo']);
  const sessions = tree.getChildren(projects[0]);
  assert.strictEqual(sessions.length, 3);
  const qa = sessions.find((s) => s.item.label === 'Explain the forecast cache');
  assert.ok(qa, 'title from summary record');
  assert.match(qa.item.description, /2 turns/);
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
});

test('the session-folder watchers react to new, changed and deleted session files', () => {
  assert.ok(watchers.length >= 1, 'a watcher per root');
  for (const a of watcherArgs) assert.strictEqual(a[3], false, 'delete events are not ignored');
  for (const w of watchers) for (const k of ['onDidCreate', 'onDidChange', 'onDidDelete']) assert.strictEqual(typeof w.on[k], 'function', k);
});
