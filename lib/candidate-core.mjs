// The local approval boundary stores summaries, never hook transcripts or prompts.
import {randomBytes, createCipheriv, createDecipheriv, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, open, unlink} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

const idPattern = /^(?:[a-f0-9]{16}|s-[a-f0-9]{32}|b-[a-f0-9]{16})$/;
const kinds = new Set(['profile', 'preference', 'current', 'knowledge']);
const lifetime = 7 * 86400000;

export class Vault {
  constructor(root, key) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw Error('Vault directory must be absolute');
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw Error('Invalid local vault key');
    this.root = root;
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== key) throw Error('Invalid local vault key');
  }

  path(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw Error('Invalid identifier');
    return join(this.root, id + '.bin');
  }

  async get(id) {
    const path = this.path(id);
    try {
      const payload = JSON.parse(await readFile(path, 'utf8'));
      if (payload.v !== 1) throw Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('Local candidate could not be verified');
    }
  }

  async put(id, value) {
    const path = this.path(id);
    await mkdir(this.root, {recursive: true, mode: 0o700});
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const temp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      await writeFile(temp, JSON.stringify({v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64')}), {flag: 'wx', mode: 0o600});
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  // A single exclusive lock covers both approval changes and submission. A stale
  // lock fails closed: never guess that another writer has stopped running.
  async withLock(operation) {
    await mkdir(this.root, {recursive: true, mode: 0o700});
    const path = join(this.root, 'approval.lock');
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const busy = Error('Another approval operation is in progress');
      busy.code = 'VAULT_BUSY';
      throw busy;
    }
    try { return await operation(); }
    finally { await handle.close(); await unlink(path); }
  }
}

const secretPattern = /-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_\-]{12,}|(?:api[_ -]?key|password|密码|token|令牌)\s*[:=：]\s*[^\s<>]{6,}|\b\d{15,19}[Xx]?\b/i;

export function validateCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 || Object.keys(input).some(key => !['summary', 'kind', 'source'].includes(key))) throw Error('Invalid candidate fields');
  if (input.source !== 'current-human-statement') throw Error('Candidate requires a current human statement');
  if (!kinds.has(input.kind)) throw Error('Invalid candidate kind');
  if (typeof input.summary !== 'string' || input.summary.trim().length < 2 || input.summary.length > 2000) throw Error('Candidate summary length is invalid');
  if (secretPattern.test(input.summary) || /transcript_path|response_item|event_msg|\[?(?:system|assistant|user)\]?\s*:/i.test(input.summary)) throw Error('Credentials and transcripts cannot become candidates');
  return {summary: input.summary.trim(), kind: input.kind, source: input.source};
}

export async function propose(vault, input, now = Date.now()) {
  const candidate = validateCandidate(input);
  const id = randomBytes(8).toString('hex');
  await vault.put(id, {...candidate, id, status: 'pending', createdAt: now, expiresAt: now + lifetime});
  return {id, status: 'pending', kind: candidate.kind};
}

const sessionKey = id => 's-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
const commandIds = prompt => /^(?:保存候选|save candidate)\s+([a-f0-9]{16}(?:[\s,，]+[a-f0-9]{16}){0,2})\s*$/i.exec(prompt.trim())?.[1].split(/[\s,，]+/).map(id => id.toLowerCase());

function decisionIds(prompt) {
  const direct = commandIds(prompt);
  if (direct) return direct;
  // Accept only the complete app envelope, never commands extracted from prose.
  const envelope = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(prompt.trim());
  if (!envelope) return;
  try {
    const replies = JSON.parse(envelope[1]);
    if (!Array.isArray(replies) || !replies.length || replies.length > 3) return;
    const ids = [];
    for (const item of replies) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3 || Object.keys(item).some(key => !['questionItemId', 'question', 'answer'].includes(key)) || typeof item.questionItemId !== 'string' || typeof item.question !== 'string' || !item.question.trim() || typeof item.answer !== 'string') return;
      const origin = JSON.parse(item.questionItemId);
      if (!Array.isArray(origin) || origin.length !== 3 || origin[0] !== 'request_user_input_async' || typeof origin[1] !== 'string' || !/^call_[a-z0-9_-]+$/i.test(origin[1]) || !Number.isSafeInteger(origin[2]) || origin[2] < 0) return;
      if (['暂不保存', 'Do not save', 'Not now'].includes(item.answer)) continue;
      const selected = commandIds(item.answer);
      if (!selected) return;
      ids.push(...selected);
    }
    if (ids.length && ids.length <= 3) return ids;
  } catch { /* Invalid envelopes are ordinary unapproved input. */ }
}

function assertCandidate(candidate, now) {
  if (!candidate || !['pending', 'approved'].includes(candidate.status) || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= now) throw Error('Candidate is missing, expired, or already submitted');
}

const queuedBatchIds = state => [...new Set([...(Array.isArray(state.batchIds) ? state.batchIds : []), ...(state.batchId ? [state.batchId] : [])])];

export async function acceptUserPrompt(vault, sessionId, prompt, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || typeof prompt !== 'string') throw Error('Invalid human prompt');
  const ids = decisionIds(prompt);
  if (!ids) return {approved: false};
  return vault.withLock(async () => {
    const key = sessionKey(sessionId);
    const state = await vault.get(key) || {};
    const unique = [...new Set(ids)];
    const candidates = await Promise.all(unique.map(id => vault.get(id)));
    candidates.forEach(candidate => assertCandidate(candidate, now));
    if (candidates.some(candidate => candidate.status === 'approved')) {
      const existingId = candidates[0].batchId;
      const existing = await vault.get(existingId);
      if (!existing || existing.status !== 'approved' || existing.sessionKey !== key || candidates.some(candidate => candidate.batchId !== existingId) || existing.ids.length !== unique.length || existing.ids.some(id => !unique.includes(id))) throw Error('Candidate is already approved in another batch');
      return {approved: true, batchId: existingId, count: unique.length};
    }
    const batchId = 'b-' + randomBytes(8).toString('hex');
    await vault.put(batchId, {id: batchId, ids: unique, status: 'approved', approvedAt: now, sessionKey: key});
    for (const candidate of candidates) await vault.put(candidate.id, {...candidate, status: 'approved', batchId, approvedAt: now});
    await vault.put(key, {...state, batchId, batchIds: [...queuedBatchIds(state), batchId]});
    return {approved: true, batchId, count: unique.length};
  });
}

async function readApprovedBatch(vault, batchId) {
  const batch = await vault.get(batchId);
  if (!batch || batch.status !== 'approved' || !Array.isArray(batch.ids) || !batch.ids.length || batch.ids.length > 3 || new Set(batch.ids).size !== batch.ids.length) throw Error('No pending human approval');
  const candidates = await Promise.all(batch.ids.map(id => vault.get(id)));
  if (candidates.some(candidate => !candidate || candidate.status !== 'approved' || candidate.batchId !== batchId || !Number.isFinite(candidate.expiresAt))) throw Error('Approval no longer matches candidates');
  return {batch, candidates};
}

export async function approvedBatch(vault, batchId, now = Date.now()) {
  const approved = await readApprovedBatch(vault, batchId);
  approved.candidates.forEach(candidate => assertCandidate(candidate, now));
  return approved;
}

function safeReceipt(receipt) {
  if (receipt?.submitted !== true) throw Error('Official hooks did not confirm submission');
  const result = {submitted: true};
  for (const key of ['sessionId', 'taskId', 'indexStatus']) {
    if (receipt[key] === null || (typeof receipt[key] === 'string' && receipt[key].length <= 256)) result[key] = receipt[key];
  }
  if (receipt.recoveredExistingCommit === true) result.recoveredExistingCommit = true;
  return result;
}

export async function handleHook({vault, event, input, primaryReady, writer, reviewContext = ''}) {
  const sessionId = typeof input?.session_id === 'string' ? input.session_id : '';
  if (!sessionId.trim()) return {};
  if (event === 'UserPromptSubmit') {
    const result = await acceptUserPrompt(vault, sessionId, typeof input.prompt === 'string' ? input.prompt : '');
    if (result.approved) return {hookSpecificOutput: {hookEventName: event, additionalContext: 'The human approved the selected local candidates. The local Stop hook will submit only their summaries. Do not upload a transcript or call a write tool. Do not claim saving succeeded before the submission receipt; extraction and indexing require separate verification.'}};
    return reviewContext ? {hookSpecificOutput: {hookEventName: event, additionalContext: reviewContext}} : {};
  }
  if (event !== 'Stop') return {};
  try {
    return await vault.withLock(async () => {
      const key = sessionKey(sessionId);
      const state = await vault.get(key) || {};
      let count = 0;
      let expired = 0;
      let readinessBlocked = false;
      for (const batchId of queuedBatchIds(state)) {
        const existing = await vault.get(batchId);
        if (existing?.status === 'submitted' || existing?.status === 'expired') continue;
        const approved = await readApprovedBatch(vault, batchId);
        if (approved.batch.sessionKey !== key) throw Error('Approval does not belong to this session');
        const now = Date.now();
        if (approved.candidates.some(candidate => candidate.expiresAt <= now)) {
          // A batch is one approval decision: expire it in full rather than
          // silently submitting only its still-fresh members. Integrity errors
          // above are never classified as ordinary expiry or skipped.
          await vault.put(batchId, {...approved.batch, status: 'expired', expiredAt: now});
          for (const candidate of approved.candidates) await vault.put(candidate.id, {...candidate, status: 'expired', expiredAt: now});
          expired += approved.candidates.length;
          continue;
        }
        if (!primaryReady) { readinessBlocked = true; continue; }
        const receipt = safeReceipt(await writer(approved));
        // Record the durable batch receipt first. A retry sees it even if a later
        // candidate status update is interrupted and never submits it twice.
        await vault.put(batchId, {...approved.batch, status: 'submitted', receipt});
        for (const candidate of approved.candidates) await vault.put(candidate.id, {...candidate, status: 'submitted', submittedAt: Date.now()});
        count += approved.candidates.length;
      }
      const notices = [];
      if (count) notices.push(`Submitted ${count} approved summaries to OpenViking. Extraction and indexing have not yet been verified; use status and read back the resulting memory.`);
      if (expired) notices.push(`Expired ${expired} approved candidates locally; they were not submitted. Propose fresh summaries and confirm them again.`);
      if (readinessBlocked) notices.push('Approved candidates remain encrypted locally. Readiness has not been verified; nothing was submitted.');
      return notices.length ? {systemMessage: notices.join(' ')} : {};
    });
  } catch (error) {
    if (error.code === 'VAULT_BUSY') return {systemMessage: 'An approval operation is in progress; this Stop hook did not submit a duplicate.'};
    throw error;
  }
}
