'use strict';
// Claude Code session parser (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl).
// push(record, lineNo) returns normalized items. Unknown record types are counted and skipped.
const { clip, pretty, num, textOf, newMeta, touchTime, addModel, skip } = require('./util');
const { toolDiff } = require('./diff');

const KNOWN_QUIET = new Set(['queue-operation', 'last-prompt', 'file-history-snapshot', 'attachment', 'session-owner',
  'atis-latch', 'api-request-shape', 'api-request-blob', 'api-request', 'tools-used', 'progress', 'custom-title',
  'tag', 'agent-name', 'pr-link', 'mode', 'permission-mode', 'file-history-delta', 'ai-title']);
const COMMAND_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|system-reminder)>/;

function stripTags(s) {
  return s.replace(/<\/?[a-z][a-z0-9-]*>/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function createClaudeParser() {
  const meta = newMeta('claude');
  const usageById = new Map();
  let anonUsage = 0;
  let costSum = 0, costSeen = false;
  let seenFirst = false;

  function userText(text, rec, line, side, items) {
    if (!text.trim()) return;
    if (rec.isMeta || COMMAND_RE.test(text)) {
      items.push({ k: 'note', text: clip(stripTags(text), 4000), line, side, ts: rec.timestamp });
      return;
    }
    if (/^\[Request interrupted/.test(text)) { items.push({ k: 'note', text: text.trim(), line, side }); return; }
    if (rec.isCompactSummary) { items.push({ k: 'context', label: 'Compact summary', text: clip(text), line, side }); return; }
    if (!side) {
      meta.turns++;
      if (!meta.firstPrompt) meta.firstPrompt = text.trim().slice(0, 300);
    }
    items.push({ k: 'user', text: clip(text), line, side, ts: rec.timestamp });
  }

  function push(rec, line) {
    const items = [];
    if (!rec || typeof rec !== 'object') return items;
    const t = rec.type;
    if (typeof rec.sessionId === 'string' && !meta.id) meta.id = rec.sessionId;
    if (typeof rec.cwd === 'string' && !meta.cwd) meta.cwd = rec.cwd;
    if (typeof rec.gitBranch === 'string' && rec.gitBranch && rec.gitBranch !== 'HEAD') meta.branch = rec.gitBranch;
    if (typeof rec.version === 'string' && rec.version) meta.version = rec.version;
    // A subagent file (<session>/subagents/agent-*.jsonl) is all sidechain: show it as its own session, not indented.
    if (!seenFirst && (t === 'user' || t === 'assistant')) {
      seenFirst = true;
      if (rec.isSidechain === true && typeof rec.agentId === 'string' && rec.agentId) { meta.subagent = true; meta.agentId = rec.agentId.slice(0, 80); }
    }
    const side = rec.isSidechain === true && !meta.subagent;
    if (side) meta.hasSidechain = true;

    if (t === 'summary') {
      if (typeof rec.summary === 'string' && !meta.title) meta.title = rec.summary.slice(0, 200);
      return items;
    }
    if (t === 'cost-state') {
      if (typeof rec.totalCostUSD === 'number') meta.recordedCost = rec.totalCostUSD;
      return items;
    }
    if (t === 'custom-title' && typeof rec.customTitle === 'string') { meta.title = rec.customTitle.slice(0, 200); meta.customTitle = true; return items; }
    if (t === 'ai-title' && typeof rec.aiTitle === 'string') { if (!meta.customTitle) meta.title = rec.aiTitle.slice(0, 200); return items; }
    if (t === 'user' || t === 'assistant') touchTime(meta, rec.timestamp);
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : null;

    if (t === 'user') {
      if (!msg) { skip(meta, 'user (no message)'); return items; }
      const c = msg.content;
      if (typeof c === 'string') { userText(c, rec, line, side, items); return items; }
      if (!Array.isArray(c)) { skip(meta, 'user (unknown content)'); return items; }
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') userText(b.text, rec, line, side, items);
        else if (b.type === 'tool_result') {
          items.push({ k: 'result', id: String(b.tool_use_id || ''), text: clip(textOf(b.content)), isError: b.is_error === true, line, side });
        } else if (b.type === 'image') items.push({ k: 'note', text: '[image]', line, side });
        else if (b.type === 'document') items.push({ k: 'note', text: '[document]', line, side });
      }
      return items;
    }

    if (t === 'assistant') {
      if (!msg) { skip(meta, 'assistant (no message)'); return items; }
      addModel(meta, msg.model);
      if (msg.usage && typeof msg.usage === 'object') {
        if (typeof msg.id === 'string' && msg.id) usageById.set(msg.id, msg.usage);
        else usageById.set('anon-' + (anonUsage++), msg.usage);
      }
      if (typeof rec.costUSD === 'number') { costSum += rec.costUSD; costSeen = true; }
      const c = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          if (b.text.trim()) items.push({ k: 'assistant', text: clip(b.text), line, side, ts: rec.timestamp, model: msg.model });
        } else if (b.type === 'thinking') {
          if (typeof b.thinking === 'string' && b.thinking.trim()) items.push({ k: 'thinking', text: clip(b.thinking), line, side });
        } else if (b.type === 'redacted_thinking') {
          items.push({ k: 'thinking', text: '(redacted)', line, side });
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const name = String(b.name || 'tool');
          const diff = toolDiff(name, b.input);
          const plain = name === 'Bash' && b.input && typeof b.input.command === 'string' ? b.input.command : null;
          items.push({ k: 'tool', id: String(b.id || ''), name, summary: toolSummary(name, b.input), input: clip(plain !== null ? plain : pretty(b.input), 20000), diff, line, side });
        } else if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') {
          items.push({ k: 'result', id: String(b.tool_use_id || ''), text: clip(pretty(b.content), 8000), line, side });
        }
      }
      return items;
    }

    if (t === 'system') {
      const text = typeof rec.content === 'string' ? rec.content : (rec.subtype ? String(rec.subtype) : '');
      if (rec.subtype === 'compact_boundary') items.push({ k: 'note', text: 'Context compacted', line, side });
      else if (text) items.push({ k: 'note', text: clip(stripTags(text), 2000), line, side });
      return items;
    }
    if (typeof t === 'string' && KNOWN_QUIET.has(t)) return items;
    skip(meta, t);
    return items;
  }

  function finish() {
    const tk = meta.tokens;
    for (const u of usageById.values()) {
      tk.input += num(u.input_tokens);
      tk.output += num(u.output_tokens);
      tk.cacheWrite += num(u.cache_creation_input_tokens);
      tk.cacheRead += num(u.cache_read_input_tokens);
      if (u.output_tokens_details) tk.reasoning += num(u.output_tokens_details.thinking_tokens);
    }
    tk.total = tk.input + tk.output + tk.cacheWrite + tk.cacheRead;
    if (typeof meta.recordedCost === 'number') meta.costUSD = meta.recordedCost;
    else if (costSeen) meta.costUSD = costSum;
    delete meta.recordedCost;
    return meta;
  }

  return { meta, push, finish };
}

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.file_path || input.path || input.notebook_path || input.command || input.pattern || input.url || input.query || input.description || input.prompt || '';
  return typeof pick === 'string' ? pick.split('\n')[0].slice(0, 160) : '';
}

/** True if a parsed record looks like a Claude Code session record. */
function looksLikeClaude(rec) {
  if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string') return false;
  if (rec.type === 'summary' && typeof rec.leafUuid === 'string') return true;
  if (typeof rec.sessionId !== 'string') return false;
  return 'uuid' in rec || 'parentUuid' in rec || KNOWN_QUIET.has(rec.type) || rec.type === 'cost-state';
}

module.exports = { createClaudeParser, looksLikeClaude, toolSummary };
