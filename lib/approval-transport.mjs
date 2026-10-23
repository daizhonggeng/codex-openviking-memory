// Preloaded into the unchanged upstream hooks: only the approved session and
// exact selected summary can cross this process's fetch boundary.
import {appendFileSync} from 'node:fs';

function reject() { throw Error('Request rejected by approved-summary transport'); }
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateEnvelope(envelope) {
  if (!plainObject(envelope)) throw Error('Missing approved-summary envelope');
  let url;
  try { url = new URL(envelope.origin); } catch { throw Error('Invalid approved origin'); }
  if (url.origin !== envelope.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('Invalid approved origin');
  if (!/^cx-confirmed-[a-f0-9]{16}$/.test(envelope.sessionId) || typeof envelope.text !== 'string' || envelope.text.length < 2 || envelope.text.length > 6004 || !identityPattern.test(envelope.account) || !identityPattern.test(envelope.user)) throw Error('Invalid approved-summary envelope');
  return envelope;
}

function checkMessage(message, text) {
  if (!plainObject(message) || message.role !== 'user' || Object.keys(message).some(key => !['role', 'content', 'parts'].includes(key)) || ('content' in message) === ('parts' in message)) reject();
  if ('content' in message) {
    if (typeof message.content !== 'string' || message.content !== text) reject();
  } else {
    if (!Array.isArray(message.parts) || message.parts.length !== 1) reject();
    const part = message.parts[0];
    if (!plainObject(part) || Object.keys(part).length !== 2 || Object.keys(part).some(key => !['type', 'text'].includes(key)) || !['text', 'input_text'].includes(part.type) || part.text !== text) reject();
  }
}

export function createApprovedFetch({envelope, apiKey, fetchImpl = globalThis.fetch, journalWriter = value => appendFileSync(envelope.journal, JSON.stringify(value) + '\n', {mode: 0o600})}) {
  validateEnvelope(envelope);
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || typeof fetchImpl !== 'function') throw Error('Missing approved transport credentials');
  const prefix = '/api/v1/sessions/' + encodeURIComponent(envelope.sessionId);
  return async (input, options = {}) => {
    const request = input instanceof Request ? input : null;
    let url;
    try { url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : request?.url); } catch { reject(); }
    if (url.origin !== envelope.origin || url.username || url.password || url.search || url.hash) reject();
    const method = String(options.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers ?? request?.headers);
    if (headers.get('authorization') !== `Bearer ${apiKey}`) reject();
    for (const [name, value] of headers) {
      if (!['authorization', 'content-type', 'accept', 'user-agent', 'x-openviking-account', 'x-openviking-user'].includes(name)) reject();
      if (name === 'x-openviking-account' && value !== envelope.account) reject();
      if (name === 'x-openviking-user' && value !== envelope.user) reject();
    }
    const path = url.pathname;
    if (method === 'GET') {
      if (path !== '/health' && path !== prefix) reject();
      if (options.body !== undefined) reject();
    } else if (method === 'POST') {
      let body;
      try { body = JSON.parse(options.body ?? (request ? await request.clone().text() : 'null')); } catch { reject(); }
      if (!plainObject(body)) reject();
      if (path === prefix + '/messages' || path === prefix + '/messages/batch') {
        let messages;
        if (path.endsWith('/batch')) {
          if (Object.keys(body).length !== 1 || !('messages' in body)) reject();
          messages = body.messages;
        } else messages = [body];
        if (!Array.isArray(messages) || messages.length !== 1) reject();
        checkMessage(messages[0], envelope.text);
      } else if (path === prefix + '/commit') {
        if (Object.keys(body).some(key => key !== 'keep_recent_count') || ('keep_recent_count' in body && (!Number.isSafeInteger(body.keep_recent_count) || body.keep_recent_count < 0 || body.keep_recent_count > 100))) reject();
      } else reject();
    } else reject();
    const response = await fetchImpl(input, {...options, redirect: 'error'});
    if (method === 'GET' && path === '/health' && response.ok) {
      let health;
      try { health = await response.clone().json(); } catch { reject(); }
      const identity = health?.result ?? health;
      if (health?.status !== 'ok' || identity?.healthy !== true || identity?.account_id !== envelope.account || identity?.user_id !== envelope.user || identity?.role !== 'user') reject();
    }
    if (method === 'POST' && path === prefix + '/commit' && response.ok) {
      let result;
      try { result = await response.clone().json(); } catch { reject(); }
      if (result?.status !== 'error') {
        const taskId = result?.result?.task_id;
        journalWriter({event: 'approved-commit', sessionId: envelope.sessionId, taskId: typeof taskId === 'string' ? taskId : null, status: response.status});
      }
    }
    return response;
  };
}

if (process.env.OVCM_APPROVED_ENVELOPE) {
  let envelope;
  try { envelope = JSON.parse(process.env.OVCM_APPROVED_ENVELOPE); } catch { throw Error('Invalid approved-summary envelope'); }
  globalThis.fetch = createApprovedFetch({envelope, apiKey: process.env.OPENVIKING_API_KEY});
}
