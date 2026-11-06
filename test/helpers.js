'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const FIX = path.join(__dirname, 'fixtures');
const fs = require('fs');
// Fixtures are synthetic and made by script; rebuild them if missing.
if (!fs.existsSync(path.join(FIX, 'codex'))) execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-fixtures.js'), FIX]);
const CL = path.join(FIX, 'claude', 'projects', '-tmp-demo');
module.exports = {
  FIX,
  QA: path.join(CL, '11111111-1111-4111-8111-111111111111.jsonl'),
  TOOLS: path.join(CL, '22222222-2222-4222-8222-222222222222.jsonl'),
  ODD: path.join(CL, '33333333-3333-4333-8333-333333333333.jsonl'),
  CODEX: path.join(FIX, 'codex', 'sessions', '2026', '11', '06', 'rollout-2026-11-06T09-12-00-0199aa00-1111-7222-8333-444455556666.jsonl'),
  OTHER: path.join(FIX, 'other', 'data.jsonl'),
  async load(file, opts) {
    const items = [];
    const { loadSession } = require('../src/core/session');
    const r = await loadSession(file, { ...opts, onItems: (b) => items.push(...b) });
    return { ...r, items };
  },
};
