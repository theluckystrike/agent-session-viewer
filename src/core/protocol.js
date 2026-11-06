'use strict';
// Message protocol between the session webview and the extension host.
// Webview -> host messages are checked here; anything else is dropped.

const MAX_COPY = 1024 * 1024;

function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready':
    case 'copyResume':
    case 'openRaw':
      return { type: m.type };
    case 'export':
      if (m.stripToolOutputs !== undefined && typeof m.stripToolOutputs !== 'boolean') return null;
      return { type: 'export', stripToolOutputs: m.stripToolOutputs === true };
    case 'copy':
      if (typeof m.text !== 'string' || m.text.length > MAX_COPY) return null;
      return { type: 'copy', text: m.text };
    default:
      return null;
  }
}

const HOST_TYPES = new Set(['init', 'items', 'done', 'error', 'focus']);

/** Builds a host -> webview message. Throws on an unknown type so mistakes show up in tests. */
function hostMessage(type, body = {}) {
  if (!HOST_TYPES.has(type)) throw new Error('unknown host message ' + type);
  return { type, ...body };
}

module.exports = { validateWebviewMessage, hostMessage, MAX_COPY };
