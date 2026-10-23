import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, basename, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {runOfficialCapture} from '../lib/official-writer.mjs';
import {createApprovedFetch, validateEnvelope} from '../lib/approval-transport.mjs';

const config = {serverUrl: 'https://read.example.com', writeUrl: 'https://write.example.com', account: 'example-account', user: 'example-user'};
const batchId = 'b-0123456789abcdef';
const sessionId = 'cx-confirmed-0123456789abcdef';
const approvedText = 'An approved test summary.';
const health = {status: 'ok', healthy: true, account_id: config.account, user_id: config.user, role: 'user'};
const guard = fileURLToPath(new URL('../lib/approval-transport.mjs', import.meta.url));
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const envelope = extra => ({origin: config.writeUrl, sessionId, text: approvedText, account: config.account, user: config.user, journal: 'unused-in-injected-tests', ...extra});
const headers = {Authorization: 'Bearer test-only-key'};

async function fixture(t, options = {}) {
  const workRoot = await mkdtemp(join(tmpdir(), 'ovcm-writer-'));
  t.after(() => rm(workRoot, {recursive: true, force: true}));
  let commits = options.commits || 0;
  const calls = [];
  const scripts = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url: String(url), init});
    const path = new URL(url).pathname;
    if (path === '/health') return jsonResponse(options.health || health);
    if (init.method === 'POST' && path.endsWith('/commit')) { commits++; return jsonResponse({status: 'ok', result: {task_id: 'mock-task-id'}}); }
    if (init.method === 'POST' && path.endsWith('/messages/batch')) return jsonResponse({status: 'ok', result: {}});
    if (path === `/api/v1/sessions/${sessionId}`) return commits ? jsonResponse({status: 'ok', result: {commit_count: commits}}) : jsonResponse({status: 'error'}, 404);
    assert.fail('Unexpected fake transport request: ' + path);
  };
  const runScript = async (script, input, env, processOptions) => {
    scripts.push({script, input, env, processOptions});
    const approved = JSON.parse(env.OVCM_APPROVED_ENVELOPE);
    const fetch = createApprovedFetch({envelope: approved, apiKey: env.OPENVIKING_API_KEY, fetchImpl});
    if (basename(script) === 'auto-capture.mjs') {
      const transcript = (await readFile(input.transcript_path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(transcript.length, 2);
      assert.equal(transcript[1].payload.role, 'user');
      assert.equal(transcript[1].payload.content[0].text, approved.text);
      await fetch(config.writeUrl + '/health', {headers});
      await fetch(`${config.writeUrl}/api/v1/sessions/${sessionId}/messages/batch`, {method: 'POST', headers, body: JSON.stringify({messages: [{role: 'user', parts: [{type: 'text', text: approved.text}]}]})});
    } else if (basename(script) === 'session-end.mjs') {
      await fetch(`${config.writeUrl}/api/v1/sessions/${sessionId}/commit`, {method: 'POST', headers, body: JSON.stringify({keep_recent_count: 0})});
    } else assert.fail('Unexpected official script');
  };
  return {workRoot, calls, scripts, fetchImpl, runScript, args: {source: resolve(workRoot, 'vendor'), workRoot, guard, batchId, summaries: [approvedText], apiKey: 'test-only-key', config, fetchImpl, runScript}};
}

test('only selected summaries pass through the two unchanged official script entry points', async t => {
  const fixtureData = await fixture(t);
  const result = await runOfficialCapture({...fixtureData.args, summaries: [approvedText, 'Another selected summary.']});
  assert.deepEqual(result, {submitted: true, sessionId, taskId: 'mock-task-id', indexStatus: 'not-yet-verified'});
  assert.deepEqual(fixtureData.scripts.map(call => basename(call.script)), ['auto-capture.mjs', 'session-end.mjs']);
  const env = fixtureData.scripts[0].env;
  assert.equal(JSON.parse(env.OVCM_APPROVED_ENVELOPE).text, approvedText + '\n\nAnother selected summary.');
  assert.ok(fixtureData.calls.every(call => call.url.startsWith(config.writeUrl + '/')));
  assert.ok(fixtureData.calls.every(call => call.init.redirect === 'error'));
  assert.ok(!(await readdir(fixtureData.workRoot)).some(path => path.endsWith('.approved.jsonl')), 'derived plaintext is removed after completion');
});

test('child process receives required credentials and discards unrelated secrets and NODE_OPTIONS', async t => {
  const fixtureData = await fixture(t);
  const names = ['NODE_OPTIONS', 'OVCM_API_KEY', 'OVCM_VAULT_KEY', 'OPENVIKING_ROOT_API_KEY', 'OPENVIKING_EXTRA_HEADERS', 'UNRELATED_API_TOKEN'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }));
  for (const name of names) process.env[name] = 'sensitive-test-marker';
  await runOfficialCapture(fixtureData.args);
  const {env, input, processOptions} = fixtureData.scripts[0];
  for (const name of names.filter(name => name !== 'NODE_OPTIONS')) assert.equal(env[name], undefined, name);
  assert.match(env.NODE_OPTIONS, /^--import=file:/);
  assert.ok(!env.NODE_OPTIONS.includes('sensitive-test-marker'));
  assert.equal(env.OPENVIKING_API_KEY, 'test-only-key');
  assert.equal(env.OPENVIKING_ACCOUNT, config.account);
  assert.equal(env.OPENVIKING_USER, config.user);
  assert.equal(env.OPENVIKING_AUTO_CAPTURE, 'true');
  assert.equal(env.OPENVIKING_AUTO_RECALL, 'false');
  assert.equal(env.OPENVIKING_DEBUG, 'false');
  assert.equal(input.last_assistant_message, '');
  assert.equal(processOptions.cwd, fixtureData.workRoot);
});

test('identity mismatch, admin role and unhealthy write channel stop before any official child script', async t => {
  for (const modified of [{...health, account_id: 'wrong'}, {...health, user_id: 'wrong'}, {...health, role: 'admin'}, {...health, healthy: false}]) {
    const fixtureData = await fixture(t, {health: modified});
    await assert.rejects(runOfficialCapture(fixtureData.args));
    assert.equal(fixtureData.scripts.length, 0);
  }
});

test('an already committed batch is recovered without running capture again', async t => {
  const fixtureData = await fixture(t, {commits: 1});
  const result = await runOfficialCapture(fixtureData.args);
  assert.equal(result.recoveredExistingCommit, true);
  assert.equal(result.indexStatus, 'not-yet-verified');
  assert.equal(fixtureData.scripts.length, 0);
});

test('invalid batch, transcript/credential payloads and unsafe origins fail before network access', async t => {
  const fixtureData = await fixture(t);
  for (const override of [{batchId: '../escape'}, {summaries: []}, {summaries: ['x']}, {summaries: ['password=not-a-real-secret']}, {summaries: ['assistant: Raw transcript']}, {summaries: Array(4).fill(approvedText)}, {apiKey: 'key\nmalicious'}, {config: {...config, writeUrl: 'http://public.example.com'}}, {config: {...config, writeUrl: 'https://write.example.com/path'}}, {source: 'relative'}]) await assert.rejects(runOfficialCapture({...fixtureData.args, ...override}));
  assert.equal(fixtureData.calls.length, 0);
});

test('failed hooks cannot report success and derived plaintext is cleaned up', async t => {
  const fixtureData = await fixture(t);
  await assert.rejects(runOfficialCapture({...fixtureData.args, runScript: async () => { throw Error('Fake hook failure'); }}), /Fake hook failure/);
  assert.ok(!(await readdir(fixtureData.workRoot)).some(path => path.endsWith('.approved.jsonl')));
  await assert.rejects(runOfficialCapture({...fixtureData.args, runScript: async () => {}}), /read failed/);
});

test('transport accepts only exact approved messages and records commit metadata', async () => {
  const calls = [];
  const journal = [];
  const fetch = createApprovedFetch({envelope: envelope(), apiKey: 'test-only-key', fetchImpl: async (url, init) => { calls.push({url, init}); return jsonResponse({status: 'ok', result: {task_id: 'mock-task'}}); }, journalWriter: value => journal.push(value)});
  const base = `${config.writeUrl}/api/v1/sessions/${sessionId}`;
  await fetch(base + '/messages', {method: 'POST', headers, body: JSON.stringify({role: 'user', content: approvedText})});
  await fetch(base + '/messages/batch', {method: 'POST', headers, body: JSON.stringify({messages: [{role: 'user', parts: [{type: 'input_text', text: approvedText}]}]})});
  await fetch(base + '/commit', {method: 'POST', headers, body: '{}'});
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.init.redirect === 'error'));
  assert.deepEqual(journal, [{event: 'approved-commit', sessionId, taskId: 'mock-task', status: 200}]);
});

test('transport blocks other origins, sessions, methods, credentials and arbitrary bodies', async () => {
  let requests = 0;
  const fetch = createApprovedFetch({envelope: envelope(), apiKey: 'test-only-key', fetchImpl: async () => { requests++; return jsonResponse({}); }, journalWriter: () => {}});
  const base = `${config.writeUrl}/api/v1/sessions/${sessionId}`;
  const message = {role: 'user', content: approvedText};
  const post = body => ({method: 'POST', headers, body: JSON.stringify(body)});
  const cases = [
    ['https://other.example.com/health', {headers}], [base + '?query=extra', {headers}], [base + '#extra', {headers}], [`${config.writeUrl}/api/v1/sessions/other`, {headers}],
    [base, {method: 'DELETE', headers}], [base, {headers: {Authorization: 'Bearer other'}}], [base, {headers: {...headers, 'X-OpenViking-User': 'other'}}], [base, {headers: {...headers, 'X-Secret': 'unapproved'}}],
    [base + '/messages', post({...message, content: 'Unapproved text'})], [base + '/messages', post({...message, role: 'assistant'})], [base + '/messages', post({...message, metadata: 'extra'})],
    [base + '/messages', post({...message, parts: [{type: 'text', text: approvedText}]})], [base + '/messages', post({role: 'user', parts: [{type: 'text', text: approvedText, tool: 'extra'}]})],
    [base + '/messages/batch', post({messages: [message, message]})], [base + '/messages/batch', post({messages: [message], transcript: 'extra'})],
    [base + '/commit', post({other: 'field'})], [base + '/commit', post({keep_recent_count: -1})], [base + '/commit', post(null)], [base + '/commit', {method: 'POST', headers, body: 'not json'}],
    [config.writeUrl + '/api/v1/resources', post(message)],
  ];
  for (const [url, init] of cases) await assert.rejects(fetch(url, init), /rejected/, url);
  assert.equal(requests, 0);
});

test('transport supports Request/URL inputs and checks ordinary-user health identity', async () => {
  const fetch = createApprovedFetch({envelope: envelope(), apiKey: 'test-only-key', fetchImpl: async url => jsonResponse(String(url).endsWith('/health') ? health : {status: 'ok'}), journalWriter: () => {}});
  await fetch(new URL(config.writeUrl + '/health'), {headers});
  await fetch(new Request(`${config.writeUrl}/api/v1/sessions/${sessionId}/messages`, {method: 'POST', headers, body: JSON.stringify({role: 'user', content: approvedText})}));
  const bad = createApprovedFetch({envelope: envelope(), apiKey: 'test-only-key', fetchImpl: async () => jsonResponse({...health, role: 'admin'}), journalWriter: () => {}});
  await assert.rejects(bad(config.writeUrl + '/health', {headers}), /rejected/);
});

test('transport envelope rejects unconfigured origins and invalid identities', () => {
  for (const override of [{origin: 'https://write.example.com/path'}, {origin: 'http://public.example.com'}, {origin: 'https://name:secret@write.example.com'}, {sessionId: 'other'}, {account: 'root/other'}, {text: ''}]) assert.throws(() => validateEnvelope(envelope(override)));
  assert.equal(validateEnvelope(envelope({origin: 'http://127.0.0.1:1933'})).origin, 'http://127.0.0.1:1933');
});

test('the actual vendored capture and session-end child scripts run behind the guard with fake fetch only', async t => {
  const workRoot = await mkdtemp(join(tmpdir(), 'ovcm-vendor-hooks-'));
  t.after(() => rm(workRoot, {recursive: true, force: true}));
  const statePath = join(workRoot, 'fake-transport-state.json');
  const fakePath = join(workRoot, 'fake-fetch.mjs');
  await writeFile(statePath, JSON.stringify({messages: [], commits: 0}));
  // This is a test-only process preload. It implements an entirely local fake
  // fetch and persists mock state so both real upstream child processes see it.
  await writeFile(fakePath, `import {readFileSync,writeFileSync} from 'node:fs';
const path=process.env.OVCM_FAKE_STATE;
const envelope=JSON.parse(process.env.OVCM_APPROVED_ENVELOPE);
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,init={})=>{
  const state=JSON.parse(readFileSync(path,'utf8'));
  const url=new URL(typeof input==='string'?input:input.url);
  if(url.pathname==='/health')return reply({status:'ok',healthy:true,account_id:envelope.account,user_id:envelope.user,role:'user'});
  const prefix='/api/v1/sessions/'+envelope.sessionId;
  if(url.pathname===prefix)return state.messages.length||state.commits?reply({status:'ok',result:{commit_count:state.commits,pending_tokens:state.messages.length*10,total_message_count:state.messages.length}}):reply({status:'error'},404);
  if(init.method==='POST'&&url.pathname===prefix+'/messages/batch'){state.messages.push(...JSON.parse(init.body).messages);writeFileSync(path,JSON.stringify(state));return reply({status:'ok',result:{}});}
  if(init.method==='POST'&&url.pathname===prefix+'/commit'){state.commits++;writeFileSync(path,JSON.stringify(state));return reply({status:'ok',result:{task_id:'mock-vendor-task'}});}
  throw Error('Unexpected fake fetch endpoint');
};\n`);
  const fetchImpl = async url => {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (new URL(url).pathname === '/health') return jsonResponse(health);
    return state.messages.length || state.commits ? jsonResponse({status: 'ok', result: {commit_count: state.commits}}) : jsonResponse({status: 'error'}, 404);
  };
  const runScript = (script, input, env, options) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script], {cwd: options.cwd, env: {...env, OVCM_FAKE_STATE: statePath, NODE_OPTIONS: `--import=${pathToFileURL(fakePath).href} ${env.NODE_OPTIONS}`}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Fake vendor child timed out')); }, 10000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolveRun(); else reject(Error(`Fake vendor child failed (${code}): ${output} ${errors}`)); });
  });
  const summary = 'The test subject prefers concise technical documentation.';
  const result = await runOfficialCapture({source: fileURLToPath(new URL('../vendor/OpenViking-v0.5.1.1', import.meta.url)), workRoot, guard, batchId, summaries: [summary], apiKey: 'test-only-key', config, fetchImpl, runScript});
  assert.equal(result.submitted, true);
  assert.equal(result.taskId, 'mock-vendor-task');
  assert.equal(result.indexStatus, 'not-yet-verified');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.commits, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].role, 'user');
  assert.deepEqual(state.messages[0].parts, [{type: 'text', text: summary}]);
});
