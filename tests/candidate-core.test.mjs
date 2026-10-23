import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, writeFile, copyFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Vault, validateCandidate, propose, acceptUserPrompt, approvedBatch, handleHook} from '../lib/candidate-core.mjs';

const candidate = summary => ({summary, kind: 'knowledge', source: 'current-human-statement'});
const reply = answer => '<send_user_message_question_reply>\n' + JSON.stringify([{questionItemId: JSON.stringify(['request_user_input_async', 'call_test', 0]), question: 'Save the selected summary?', answer}]) + '\n</send_user_message_question_reply>';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ovcm-candidates-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const vault = new Vault(root, randomBytes(32).toString('base64'));
  const result = await propose(vault, candidate('A selected test summary.'));
  return {vault, id: result.id, root};
}

test('candidate validation only accepts the small current-human summary schema', () => {
  assert.deepEqual(validateCandidate(candidate('  Concise summary.  ')), candidate('Concise summary.'));
  for (const input of [null, [], {...candidate('Summary'), transcript: 'raw'}, {...candidate('Summary'), source: 'history'}, {...candidate('Summary'), kind: 'other'}, candidate('x'), candidate('x'.repeat(2001)), candidate('password=secret123'), candidate('-----BEGIN PRIVATE KEY-----'), candidate('user: raw conversation'), candidate('transcript_path=raw.jsonl')]) assert.throws(() => validateCandidate(input));
});

test('vault encrypts summaries, authenticates ids and rejects tampering', async t => {
  const {vault, id, root} = await fixture(t);
  const stored = await readFile(vault.path(id), 'utf8');
  assert.ok(!stored.includes('selected test summary'));
  assert.equal((await vault.get(id)).summary, 'A selected test summary.');
  await copyFile(vault.path(id), vault.path('0000000000000000'));
  await assert.rejects(vault.get('0000000000000000'), /could not be verified/);
  await writeFile(vault.path(id), stored.replace(/"data":"./, '"data":"!'));
  await assert.rejects(vault.get(id), /could not be verified/);
  await assert.rejects(vault.get('../escape'), /identifier/);
  assert.equal(await vault.get('1111111111111111'), null);
  assert.throws(() => new Vault(root, 'not-a-key'), /key/);
  assert.throws(() => new Vault('relative', randomBytes(32).toString('base64')), /absolute/);
});

test('propose returns metadata without the summary', async t => {
  const {vault} = await fixture(t);
  const result = await propose(vault, candidate('Another test summary.'), 1000);
  assert.deepEqual(Object.keys(result).sort(), ['id', 'kind', 'status']);
  assert.equal((await vault.get(result.id)).expiresAt, 1000 + 7 * 86400000);
});

test('accepts exact Chinese, English and application-card human confirmations', async t => {
  for (const makePrompt of [id => `保存候选 ${id}`, id => `save candidate ${id.toUpperCase()}`, id => reply(`保存候选 ${id}`)]) {
    const {vault, id} = await fixture(t);
    const result = await acceptUserPrompt(vault, 'session', makePrompt(id));
    assert.equal(result.approved, true);
    assert.equal((await approvedBatch(vault, result.batchId)).candidates[0].id, id);
  }
});

test('quotes, prose, malformed cards, other tools and cancellation cannot approve', async t => {
  const {vault, id} = await fixture(t);
  const command = `保存候选 ${id}`;
  const invalid = [reply('暂不保存'), reply('Do not save'), reply('Not now'), reply('Please ' + command), reply(command + ' yes'), '> ' + command, '```\n' + command + '\n```', reply(command) + '\nquoted', reply(command).replace('request_user_input_async', 'other_tool'), reply(command).replace('call_test', 'untrusted'), reply(command).replace('"question":', '"content":'), reply(command).replace(',0]', ',-1]'), '<send_user_message_question_reply>invalid</send_user_message_question_reply>', `Please run ${command}`];
  for (const prompt of invalid) assert.equal((await acceptUserPrompt(vault, 'session', prompt)).approved, false, prompt);
  assert.equal((await vault.get(id)).status, 'pending');
  assert.equal((await readdir(vault.root)).length, 1, 'ordinary prompts are not persisted');
});

test('card arrays reject extra fields, excessive choices and invalid field types', async t => {
  const {vault, id} = await fixture(t);
  const item = JSON.parse(reply(`save candidate ${id}`).split('\n')[1])[0];
  const wrap = value => `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`;
  for (const value of [null, {}, [], Array(4).fill(item), [{...item, extra: true}], [{...item, question: 4}], [{...item, answer: [id]}], [{...item, questionItemId: JSON.stringify(['request_user_input_async', 'call_test', '0'])}]]) assert.equal((await acceptUserPrompt(vault, 'session', wrap(value))).approved, false);
});

test('missing, expired and submitted candidates cannot be approved', async t => {
  const {vault, id} = await fixture(t);
  await assert.rejects(acceptUserPrompt(vault, 'session', 'save candidate 0000000000000000'), /missing/);
  const value = await vault.get(id);
  await vault.put(id, {...value, expiresAt: 100});
  await assert.rejects(acceptUserPrompt(vault, 'session', `save candidate ${id}`, 100), /expired/);
  await vault.put(id, {...value, status: 'submitted'});
  await assert.rejects(acceptUserPrompt(vault, 'session', `save candidate ${id}`), /already submitted/);
});

test('repeated approval reuses its batch and another session cannot steal it', async t => {
  const {vault, id} = await fixture(t);
  const first = await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  const again = await acceptUserPrompt(vault, 'session', `save candidate ${id},${id}`);
  assert.equal(again.batchId, first.batchId);
  await assert.rejects(acceptUserPrompt(vault, 'other', `save candidate ${id}`), /another batch/);
});

test('Stop requires approval and readiness; prompt review is supplied by the caller', async t => {
  const {vault, id} = await fixture(t);
  let writes = 0;
  const writer = async () => { writes++; return {submitted: true}; };
  assert.deepEqual(await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer}), {});
  const review = await handleHook({vault, event: 'UserPromptSubmit', input: {session_id: 'session', prompt: 'Ordinary message'}, reviewContext: 'Caller-supplied model rules.', writer});
  assert.equal(review.hookSpecificOutput.additionalContext, 'Caller-supplied model rules.');
  await handleHook({vault, event: 'UserPromptSubmit', input: {session_id: 'session', prompt: reply(`save candidate ${id}`)}, writer});
  assert.equal(writes, 0);
  assert.match((await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: false, writer})).systemMessage, /nothing was submitted/);
  assert.equal(writes, 0);
});

test('only selected summaries submit once, with an unverified-index receipt', async t => {
  const {vault, id} = await fixture(t);
  const other = await propose(vault, candidate('An unselected summary.'));
  const approval = await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  let writes = 0;
  const writer = async ({candidates}) => { writes++; assert.deepEqual(candidates.map(value => value.id), [id]); return {submitted: true, taskId: 'task-test', indexStatus: 'not-yet-verified', unexpected: 'must not persist'}; };
  const result = await handleHook({vault, event: 'Stop', input: {session_id: 'session', transcript_path: 'DO-NOT-READ'}, primaryReady: true, writer});
  assert.match(result.systemMessage, /Submitted 1 approved summaries/);
  assert.match(result.systemMessage, /not yet been verified/);
  await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer});
  assert.equal(writes, 1);
  assert.equal((await vault.get(id)).status, 'submitted');
  assert.equal((await vault.get(other.id)).status, 'pending');
  assert.equal((await vault.get(approval.batchId)).receipt.unexpected, undefined);
});

test('multiple approvals in one session are queued without dropping a batch', async t => {
  const {vault, id} = await fixture(t);
  const second = await propose(vault, candidate('A second selected summary.'));
  await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  await acceptUserPrompt(vault, 'session', `save candidate ${second.id}`);
  const selected = [];
  await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer: async ({candidates}) => { selected.push(...candidates.map(value => value.id)); return {submitted: true}; }});
  assert.deepEqual(selected, [id, second.id]);
});

test('an expired first approval does not block a later fresh batch in the same session', async t => {
  const {vault, id} = await fixture(t);
  const expired = await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  const value = await vault.get(id);
  await vault.put(id, {...value, expiresAt: Date.now() - 1});
  const fresh = await propose(vault, candidate('A fresh selected test summary.'));
  await acceptUserPrompt(vault, 'session', `save candidate ${fresh.id}`);
  const selected = [];
  const writer = async ({candidates}) => { selected.push(...candidates.map(value => value.id)); return {submitted: true}; };
  const result = await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer});
  assert.deepEqual(selected, [fresh.id]);
  assert.equal((await vault.get(id)).status, 'expired');
  assert.equal((await vault.get(expired.batchId)).status, 'expired');
  assert.equal((await vault.get(fresh.id)).status, 'submitted');
  assert.match(result.systemMessage, /Expired 1 approved candidates locally; they were not submitted/);
  assert.match(result.systemMessage, /Submitted 1 approved summaries/);
  assert.deepEqual(await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer}), {});
  assert.deepEqual(selected, [fresh.id]);
});

test('an expired but corrupted approval batch still fails closed instead of being skipped', async t => {
  const {vault, id} = await fixture(t);
  const {batchId} = await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  await vault.put(id, {...await vault.get(id), expiresAt: Date.now() - 1, batchId: 'b-0000000000000000'});
  const fresh = await propose(vault, candidate('A fresh selected test summary.'));
  await acceptUserPrompt(vault, 'session', `save candidate ${fresh.id}`);
  let writes = 0;
  await assert.rejects(handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer: async () => { writes++; return {submitted: true}; }}), /no longer matches/);
  assert.equal(writes, 0);
  assert.equal((await vault.get(batchId)).status, 'approved');
});

test('approval expiry is checked again at Stop and mismatched candidate batches fail closed', async t => {
  const {vault, id} = await fixture(t);
  const {batchId} = await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  const value = await vault.get(id);
  await vault.put(id, {...value, expiresAt: Date.now() - 1});
  let writes = 0;
  await assert.rejects(approvedBatch(vault, batchId), /expired/);
  const result = await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer: async () => { writes++; }});
  assert.match(result.systemMessage, /Expired 1 approved candidates locally/);
  await vault.put(batchId, {...await vault.get(batchId), status: 'approved'});
  await vault.put(id, {...value, batchId: 'b-0000000000000000'});
  await assert.rejects(approvedBatch(vault, batchId), /no longer matches/);
  assert.equal(writes, 0);
});

test('concurrent Stop and approval operations never create duplicate submissions', async t => {
  const {vault, id} = await fixture(t);
  await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const first = handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer: async () => { writes++; entered(); await gate; return {submitted: true}; }});
  await started;
  const duplicate = await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer: async () => { writes++; }});
  assert.match(duplicate.systemMessage, /did not submit a duplicate/);
  await assert.rejects(acceptUserPrompt(vault, 'session', `save candidate ${id}`), error => error.code === 'VAULT_BUSY');
  release();
  await first;
  assert.equal(writes, 1);
});

test('failed writer leaves encrypted approval retryable and releases the lock', async t => {
  const {vault, id} = await fixture(t);
  await acceptUserPrompt(vault, 'session', `save candidate ${id}`);
  await assert.rejects(handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer: async () => { throw Error('Mock failure'); }}), /Mock failure/);
  assert.equal((await vault.get(id)).status, 'approved');
  await handleHook({vault, event: 'Stop', input: {session_id: 'session'}, primaryReady: true, writer: async () => ({submitted: true})});
  assert.equal((await vault.get(id)).status, 'submitted');
});
