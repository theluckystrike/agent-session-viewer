'use strict';
// Format detection, streamed loading and quick summaries. Everything here only reads files.
const fs = require('fs');
const { streamLines, parseLine } = require('./lines');
const { createClaudeParser, looksLikeClaude } = require('./claude');
const { createCodexParser, looksLikeCodex } = require('./codex');

const DETECT_RECORDS = 20;
const DETECT_BYTES = 2 * 1024 * 1024;

function detectFromRecords(records) {
  for (const r of records.slice(0, DETECT_RECORDS)) {
    if (looksLikeCodex(r)) return 'codex';
    if (looksLikeClaude(r)) return 'claude';
  }
  return null;
}

function makeParser(format) {
  if (format === 'claude') return createClaudeParser();
  if (format === 'codex') return createCodexParser();
  throw new Error('unknown format');
}

/** Reads the first records of a file and says which tool wrote it: 'claude', 'codex' or null. */
async function detectFile(file) {
  const records = [];
  await streamLines(file, (line) => {
    const r = parseLine(line);
    if (r) records.push(r);
    return records.length < DETECT_RECORDS;
  }, { maxBytes: DETECT_BYTES, maxLineBytes: DETECT_BYTES });
  return detectFromRecords(records);
}

/**
 * Streams a session file through the right parser.
 * onItems(items) is called with batches; the first batch is sent as soon as `firstBatch` items exist.
 * @returns {Promise<{meta, format, stats}>}
 */
async function loadSession(file, opts = {}) {
  const format = opts.format || (await detectFile(file));
  if (!format) { const e = new Error('This file does not look like a Claude Code or Codex session.'); e.code = 'NOT_SESSION'; throw e; }
  const parser = makeParser(format);
  const batchSize = opts.batchSize || 400;
  const first = opts.firstBatch || 120;
  let buf = [], sent = 0, bad = 0;
  const flush = () => { if (buf.length && opts.onItems) { opts.onItems(buf); sent += buf.length; } buf = []; };
  const stats = await streamLines(file, (line, lineNo) => {
    const r = parseLine(line);
    if (!r) { bad++; return; }
    let items;
    try { items = parser.push(r, lineNo); } catch { bad++; return; }
    if (items.length) {
      buf.push(...items);
      parser.meta.items += items.length;
      if (buf.length >= (sent === 0 ? first : batchSize)) flush();
    }
  }, { maxBytes: opts.maxBytes, isCancelled: opts.isCancelled });
  flush();
  const meta = parser.finish();
  meta.badLines = bad + stats.longLines;
  meta.truncated = stats.truncated;
  meta.bytes = stats.bytes;
  if (!meta.id) meta.id = idFromName(file, format);
  return { meta, format, stats };
}

/** Quick summary for the tree: reads at most maxBytes (default 256 KB). */
async function summarizeFile(file, opts = {}) {
  const maxBytes = opts.maxBytes || 256 * 1024;
  let format = opts.format || null;
  let parser = format ? makeParser(format) : null;
  const pending = [];
  let bad = 0;
  const stats = await streamLines(file, (line, lineNo) => {
    const r = parseLine(line);
    if (!r) { bad++; return; }
    if (!parser) {
      pending.push(r);
      format = detectFromRecords([r]);
      if (format) { parser = makeParser(format); for (const p of pending) safePush(parser, p, lineNo); pending.length = 0; }
      else if (pending.length >= DETECT_RECORDS) return false;
      return;
    }
    const items = safePush(parser, r, lineNo);
    parser.meta.items += items.length;
    if (opts.stopAtFirstPrompt && parser.meta.firstPrompt && parser.meta.cwd) return false;
  }, { maxBytes, maxLineBytes: maxBytes });
  if (!parser) return null;
  const meta = parser.finish();
  meta.badLines = bad;
  meta.partial = stats.truncated || stats.stopped;
  if (!meta.id) meta.id = idFromName(file, format);
  return meta;
}

function safePush(parser, r, lineNo) {
  try { return parser.push(r, lineNo); } catch { return []; }
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function idFromName(file, format) {
  const base = require('path').basename(file).replace(/\.jsonl$/i, '');
  const m = UUID_RE.exec(base);
  if (m) return m[1];
  return format === 'claude' ? base : '';
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}

module.exports = { detectFile, detectFromRecords, loadSession, summarizeFile, makeParser, idFromName, fileSize };
