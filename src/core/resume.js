'use strict';
// Builds the shell command that resumes a session in its own tool. Nothing is run.

function shQuote(s) {
  if (/^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s)) return s;
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function resumeCommand(meta, opts = {}) {
  if (!meta || !meta.id || !SAFE_ID.test(meta.id)) return '';
  const base = meta.format === 'codex' ? `codex resume ${meta.id}` : meta.format === 'claude' ? `claude --resume ${meta.id}` : '';
  if (!base) return '';
  const withCd = opts.withCd !== false && meta.cwd && typeof meta.cwd === 'string';
  return withCd ? `cd ${shQuote(meta.cwd)} && ${base}` : base;
}

module.exports = { resumeCommand, shQuote };
