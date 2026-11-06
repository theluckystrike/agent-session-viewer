'use strict';
// Markdown export of a normalized session. Output is plain text; nothing here touches the session file.

function fence(s) {
  const text = String(s ?? '');
  let f = '```';
  while (text.includes(f)) f += '`';
  return f + '\n' + text + (text.endsWith('\n') ? '' : '\n') + f;
}

function quote(s) { return String(s).split('\n').map((l) => '> ' + l).join('\n'); }

function fmtTokens(tk) {
  const parts = [`input ${tk.input}`, `output ${tk.output}`];
  if (tk.cacheRead) parts.push(`cache read ${tk.cacheRead}`);
  if (tk.cacheWrite) parts.push(`cache write ${tk.cacheWrite}`);
  if (tk.reasoning) parts.push(`reasoning ${tk.reasoning}`);
  return parts.join(', ');
}

function diffText(diff) {
  const out = [];
  for (const f of diff) {
    out.push(`--- ${f.op === 'add' ? '/dev/null' : f.file}`);
    out.push(`+++ ${f.op === 'delete' ? '/dev/null' : (f.moveTo || f.file)}`);
    for (const l of f.lines) out.push(l.t === '@' ? l.s : l.t + l.s);
    if (f.more) out.push(`… ${f.more} more lines`);
  }
  return out.join('\n');
}

/**
 * @param {object} meta
 * @param {object[]} items normalized items in file order
 * @param {{ stripToolOutputs?: boolean, includeThinking?: boolean }} opts
 */
function toMarkdown(meta, items, opts = {}) {
  const strip = !!opts.stripToolOutputs;
  const thinking = opts.includeThinking !== false;
  const tool = meta.format === 'codex' ? 'Codex' : 'Claude Code';
  const out = [];
  out.push(`# ${meta.title || meta.firstPrompt.split('\n')[0].slice(0, 80) || 'Session ' + meta.id}`);
  out.push('');
  const rows = [['Tool', tool], ['Session', meta.id], ['Project', meta.cwd], ['Branch', meta.branch], ['Model', meta.models.join(', ')],
    ['Started', meta.start], ['Ended', meta.end], ['Tokens', fmtTokens(meta.tokens)]];
  if (typeof meta.costUSD === 'number') rows.push(['Cost (recorded)', '$' + meta.costUSD.toFixed(2)]);
  for (const [k, v] of rows) if (v) out.push(`- **${k}:** ${String(v).replace(/\n/g, ' ')}`);
  if (strip) out.push('- Tool outputs removed from this export.');
  out.push('');
  const results = new Map();
  for (const it of items) if (it.k === 'result' && it.id) results.set(it.id, it);
  const used = new Set();
  for (const it of items) {
    const block = (s) => (it.side ? quote(s) : s);
    switch (it.k) {
      case 'user': out.push(block(`## User${it.side ? ' (subagent)' : ''}\n\n${it.text}`)); break;
      case 'assistant': out.push(block(`## Assistant${it.side ? ' (subagent)' : ''}\n\n${it.text}`)); break;
      case 'thinking': if (thinking) out.push(block(`<details><summary>Thinking</summary>\n\n${it.text}\n\n</details>`)); break;
      case 'context': out.push(block(`<details><summary>${it.label || 'Context'}</summary>\n\n${fence(it.text)}\n\n</details>`)); break;
      case 'note': out.push(block(`_${(it.label ? it.label + ': ' : '') + it.text.split('\n')[0].slice(0, 300)}_`)); break;
      case 'tool': {
        const parts = [`**Tool: ${it.name}**${it.summary ? ' `' + it.summary.replace(/`/g, "'") + '`' : ''}`];
        if (it.diff && it.diff.length) parts.push(fence(diffText(it.diff)).replace(/^(`+)\n/, '$1diff\n'));
        else if (it.input) parts.push(fence(it.input));
        const r = results.get(it.id);
        if (r) {
          used.add(it.id);
          if (!strip) parts.push(`Output${r.isError ? ' (error)' : ''}:\n\n` + fence(r.text));
        }
        out.push(block(parts.join('\n\n')));
        break;
      }
      case 'result':
        if (!it.id || !used.has(it.id)) { if (!strip) out.push(block('Tool output:\n\n' + fence(it.text))); }
        break;
      default: break;
    }
    if (it.k !== 'result' || !strip) out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { toMarkdown, fence, diffText };
