'use strict';
// Streams a file line by line. It reads at most maxBytes, never loads the whole file and never writes.
const fs = require('fs');

const NL = 10;

/**
 * @param {string} file
 * @param {(line: string, lineNo: number) => (void | boolean)} onLine return false to stop early
 * @param {{ maxBytes?: number, isCancelled?: () => boolean, chunkSize?: number, maxLineBytes?: number }} [opts]
 * @returns {Promise<{ lines: number, bytes: number, truncated: boolean, stopped: boolean, cancelled: boolean, longLines: number }>}
 */
function streamLines(file, onLine, opts = {}) {
  const maxBytes = opts.maxBytes || Infinity;
  const maxLineBytes = opts.maxLineBytes || 64 * 1024 * 1024;
  const isCancelled = opts.isCancelled || (() => false);
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { highWaterMark: opts.chunkSize || 1024 * 1024, flags: 'r' });
    let parts = [], partLen = 0, lineNo = 0, bytes = 0, done = false, longLines = 0, skipping = false;
    const res = { lines: 0, bytes: 0, truncated: false, stopped: false, cancelled: false, longLines: 0 };
    const finish = () => {
      if (done) return;
      done = true;
      res.lines = lineNo; res.bytes = bytes; res.longLines = longLines;
      stream.destroy();
      resolve(res);
    };
    const emit = (buf) => {
      lineNo++;
      if (skipping) { skipping = false; return true; }
      let s = buf.toString('utf8');
      if (s.endsWith('\r')) s = s.slice(0, -1);
      if (s.length === 0) return true;
      return onLine(s, lineNo) !== false;
    };
    stream.on('data', (chunk) => {
      if (done) return;
      if (isCancelled()) { res.cancelled = true; return finish(); }
      if (bytes + chunk.length > maxBytes) {
        chunk = chunk.subarray(0, Math.max(0, maxBytes - bytes));
        res.truncated = true;
      }
      bytes += chunk.length;
      let start = 0, idx;
      while ((idx = chunk.indexOf(NL, start)) !== -1) {
        let line;
        if (partLen) { parts.push(chunk.subarray(start, idx)); line = Buffer.concat(parts); parts = []; partLen = 0; }
        else line = chunk.subarray(start, idx);
        start = idx + 1;
        if (!emit(line)) { res.stopped = true; return finish(); }
      }
      if (start < chunk.length) {
        if (!skipping) { parts.push(chunk.subarray(start)); partLen += chunk.length - start; }
        if (partLen > maxLineBytes) { parts = []; partLen = 0; skipping = true; longLines++; }
      }
      if (res.truncated) return finish();
    });
    stream.on('end', () => {
      if (done) return;
      // A truncated last line is dropped: it would only be a bad JSON line.
      if (partLen && !res.truncated) { if (!emit(Buffer.concat(parts))) res.stopped = true; }
      finish();
    });
    stream.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

/** Parses one JSONL line. Returns undefined for a bad line. */
function parseLine(s) {
  const c = s.charCodeAt(0);
  if (c !== 123 /* { */ && c !== 32 && c !== 9) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

module.exports = { streamLines, parseLine };
