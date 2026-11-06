'use strict';
// Codex CLI session parser (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
// Handles the {type, payload} format and the older format with bare items. Unknown types are counted and skipped.
const { clip, pretty, num, textOf, newMeta, touchTime, addModel, skip } = require('./util');
const { toolDiff, parseApplyPatch } = require('./diff');

const ITEM_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
  'custom_tool_call_output', 'local_shell_call', 'local_shell_call_output', 'web_search_call', 'agent_message', 'additional_tools']);
const QUIET = new Set(['world_state', 'inter_agent_communication_metadata', 'token_usage_record', 'state']);
const CONTEXT_RE = /^\s*(<(environment_context|user_instructions|permissions|turn_aborted|user_shell_command|subagent_notification|collaboration_mode|developer_instructions)\b|# AGENTS\.md instructions|<INSTRUCTIONS>)/;

function parseJsonMaybe(s) {
  if (typeof s !== 'string') return s;
  const c = s.trim()[0];
  if (c !== '{' && c !== '[') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function commandText(args) {
  if (!args || typeof args !== 'object') return typeof args === 'string' ? args : '';
  const c = args.command ?? args.cmd;
  if (Array.isArray(c)) {
    const parts = c.filter((x) => typeof x === 'string');
    if (parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(' ');
    return parts.join(' ');
  }
  return typeof c === 'string' ? c : '';
}

function outputText(o) {
  const v = parseJsonMaybe(o);
  if (typeof v === 'string') return { text: v, isError: false };
  if (Array.isArray(v)) return { text: textOf(v), isError: false };
  if (v && typeof v === 'object') {
    const code = v.metadata && typeof v.metadata.exit_code === 'number' ? v.metadata.exit_code : (typeof v.exit_code === 'number' ? v.exit_code : 0);
    const text = typeof v.output === 'string' ? v.output : (typeof v.content === 'string' ? v.content : pretty(v));
    return { text, isError: code !== 0 || v.success === false };
  }
  return { text: '', isError: false };
}

function createCodexParser() {
  const meta = newMeta('codex');
  let lastTotal = null;

  function item(p, rec, line, items) {
    const ts = rec.timestamp;
    switch (p.type) {
      case 'message': {
        const text = textOf(p.content);
        if (!text.trim()) return;
        if (p.role === 'user') {
          if (CONTEXT_RE.test(text)) { items.push({ k: 'context', label: 'Context', text: clip(text, 20000), line }); return; }
          meta.turns++;
          if (!meta.firstPrompt) meta.firstPrompt = text.trim().slice(0, 300);
          items.push({ k: 'user', text: clip(text), line, ts });
        } else if (p.role === 'assistant') {
          items.push({ k: 'assistant', text: clip(text), line, ts });
        } else {
          items.push({ k: 'context', label: p.role === 'developer' ? 'Developer instructions' : 'System', text: clip(text, 20000), line });
        }
        return;
      }
      case 'reasoning': {
        const parts = [];
        if (Array.isArray(p.summary)) for (const s of p.summary) if (s && typeof s.text === 'string') parts.push(s.text);
        if (Array.isArray(p.content)) for (const s of p.content) if (s && typeof s.text === 'string') parts.push(s.text);
        if (parts.length) items.push({ k: 'thinking', text: clip(parts.join('\n\n')), line });
        else meta.hiddenReasoning = (meta.hiddenReasoning || 0) + 1;
        return;
      }
      case 'function_call': {
        const name = String(p.name || 'function');
        const args = parseJsonMaybe(p.arguments);
        const cmd = commandText(args);
        let diff = toolDiff(name, args);
        if (!diff && cmd.includes('*** Begin Patch')) diff = parseApplyPatch(cmd);
        items.push({ k: 'tool', id: String(p.call_id || p.id || ''), name, summary: (cmd || (args && (args.path || args.file_path)) || '').toString().split('\n')[0].slice(0, 160), input: clip(cmd || pretty(args), 20000), diff: diff && diff.length ? diff : null, line });
        return;
      }
      case 'custom_tool_call': {
        const name = String(p.name || 'tool');
        const input = typeof p.input === 'string' ? p.input : pretty(p.input);
        const diff = input.includes('*** Begin Patch') ? parseApplyPatch(input) : null;
        const files = diff ? diff.map((f) => f.file).join(', ') : '';
        items.push({ k: 'tool', id: String(p.call_id || p.id || ''), name, summary: files || input.split('\n')[0].slice(0, 160), input: clip(input, 20000), diff: diff && diff.length ? diff : null, line });
        return;
      }
      case 'local_shell_call': {
        const cmd = p.action ? commandText(p.action) : '';
        items.push({ k: 'tool', id: String(p.call_id || p.id || ''), name: 'shell', summary: cmd.split('\n')[0].slice(0, 160), input: clip(cmd || pretty(p.action), 20000), diff: null, line });
        return;
      }
      case 'web_search_call': {
        const q = p.action && typeof p.action.query === 'string' ? p.action.query : '';
        items.push({ k: 'tool', id: String(p.call_id || p.id || ''), name: 'web_search', summary: q.slice(0, 160), input: clip(pretty(p.action), 4000), diff: null, line });
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const o = outputText(p.output);
        items.push({ k: 'result', id: String(p.call_id || ''), text: clip(o.text), isError: o.isError, line });
        return;
      }
      case 'agent_message': {
        const text = textOf(p.content);
        if (text.trim()) items.push({ k: 'note', label: [p.author, p.recipient].filter((x) => typeof x === 'string' && x).join(' → ') || 'agent message', text: clip(text, 20000), line });
        return;
      }
      case 'additional_tools':
        return;
      default:
        skip(meta, 'response_item:' + p.type);
    }
  }

  function push(rec, line) {
    const items = [];
    if (!rec || typeof rec !== 'object') return items;
    const t = rec.type;
    touchTime(meta, rec.timestamp);
    // Older format: first line {id, timestamp, instructions}, then bare items.
    if (t === undefined && typeof rec.id === 'string' && 'instructions' in rec) {
      if (!meta.id) meta.id = rec.id;
      if (rec.git && typeof rec.git.branch === 'string') meta.branch = rec.git.branch;
      return items;
    }
    if (t === undefined && rec.record_type) return items;
    if (typeof t === 'string' && ITEM_TYPES.has(t) && !('payload' in rec)) { item(rec, rec, line, items); return items; }
    const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
    if (t === 'session_meta' && p) {
      if (typeof p.id === 'string' && !meta.id) meta.id = p.id;
      if (typeof p.cwd === 'string' && !meta.cwd) meta.cwd = p.cwd;
      if (typeof p.cli_version === 'string') meta.version = p.cli_version;
      if (p.git && typeof p.git.branch === 'string') meta.branch = p.git.branch;
      if (p.source && typeof p.source === 'object' && p.source.subagent) meta.subagent = true;
      if (typeof p.agent_nickname === 'string' && p.agent_nickname) meta.agent = p.agent_nickname;
      touchTime(meta, p.timestamp);
      return items;
    }
    if (t === 'turn_context' && p) {
      addModel(meta, p.model);
      if (typeof p.cwd === 'string' && !meta.cwd) meta.cwd = p.cwd;
      return items;
    }
    if (t === 'response_item' && p) { item(p, rec, line, items); return items; }
    if (t === 'event_msg' && p) {
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) lastTotal = p.info.total_token_usage;
      else if (p.type === 'thread_settings_applied' && p.thread_settings) addModel(meta, p.thread_settings.model);
      else if (p.type === 'turn_aborted') items.push({ k: 'note', text: 'Turn aborted' + (p.reason ? ': ' + String(p.reason) : ''), line });
      return items;
    }
    if (t === 'compacted') { items.push({ k: 'note', text: 'Context compacted', line }); return items; }
    if (typeof t === 'string' && QUIET.has(t)) return items;
    skip(meta, t);
    return items;
  }

  function finish() {
    if (lastTotal) {
      const tk = meta.tokens;
      const cached = num(lastTotal.cached_input_tokens);
      tk.input = Math.max(0, num(lastTotal.input_tokens) - cached);
      tk.cacheRead = cached;
      tk.cacheWrite = num(lastTotal.cache_write_input_tokens);
      tk.output = num(lastTotal.output_tokens);
      tk.reasoning = num(lastTotal.reasoning_output_tokens);
      tk.total = num(lastTotal.total_tokens) || (num(lastTotal.input_tokens) + tk.output);
    }
    return meta;
  }

  return { meta, push, finish };
}

function looksLikeCodex(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (typeof rec.type === 'string' && 'payload' in rec && ['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted'].includes(rec.type)) return true;
  if (rec.type === undefined && typeof rec.id === 'string' && 'instructions' in rec && 'timestamp' in rec) return true;
  return false;
}

module.exports = { createCodexParser, looksLikeCodex, commandText, outputText };
