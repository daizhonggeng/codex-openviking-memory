import {spawn} from 'node:child_process';
import {mkdir, writeFile, readFile, unlink} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertIdentity, validateOrigin} from './config.mjs';
import {validateCandidate} from './candidate-core.mjs';

function run(script, input, env, {cwd}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let length = 0;
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 65536) child.kill(); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    child.on('error', () => reject(Error('Official hook did not start')));
    child.on('close', code => code === 0 && length <= 65536 ? resolve() : reject(Error('Official hook process did not complete')));
  });
}

function childEnvironment({origin, account, user, apiKey, workRoot, guard, envelope}) {
  const env = {};
  // Explicitly inherit OS/runtime necessities. API keys, vault keys, proxies,
  // external NODE_OPTIONS and unrelated application secrets are not inherited.
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TZ)$/i.test(name)) env[name] = value;
  }
  return {...env,
    OPENVIKING_CREDENTIAL_SOURCE: 'env', OPENVIKING_URL: origin, OPENVIKING_BASE_URL: origin, OPENVIKING_API_KEY: apiKey, OPENVIKING_AUTH_MODE: 'api_key',
    OPENVIKING_ACCOUNT: account, OPENVIKING_USER: user, OPENVIKING_PEER_SOURCE: 'none', OPENVIKING_PEER_ID: '',
    OPENVIKING_CLI_CONFIG_FILE: join(workRoot, 'disabled-ovcli.conf'), OPENVIKING_CONFIG_FILE: join(workRoot, 'disabled-ov.conf'),
    OPENVIKING_AUTO_CAPTURE: 'true', OPENVIKING_AUTO_RECALL: 'false', OPENVIKING_NO_AUTO_INJECT: 'true', OPENVIKING_DEBUG: 'false',
    OPENVIKING_CAPTURE_ASSISTANT_TURNS: 'false', OPENVIKING_CAPTURE_LAST_ASSISTANT_ON_STOP: 'false', OPENVIKING_CAPTURE_TOOL_RESULTS: 'false',
    OPENVIKING_CAPTURE_MODE: 'semantic', OPENVIKING_CAPTURE_MAX_LENGTH: '24000', OPENVIKING_COMMIT_TOKEN_THRESHOLD: '1000000',
    OPENVIKING_AUTO_COMMIT_ON_COMPACT: 'false', OPENVIKING_WRITE_PATH_ASYNC: 'false', OPENVIKING_CODEX_STATE_DIR: join(workRoot, 'official-state'),
    OV_HOOK_WORKER: '1', OVCM_APPROVED_ENVELOPE: JSON.stringify(envelope), NODE_OPTIONS: '--import=' + pathToFileURL(guard).href,
  };
}

export async function runOfficialCapture({source, workRoot, guard, batchId, summaries, apiKey, config, fetchImpl = globalThis.fetch, runScript = run}) {
  if (!/^b-[a-f0-9]{16}$/.test(batchId) || !Array.isArray(summaries) || !summaries.length || summaries.length > 3) throw Error('Invalid approved batch');
  for (const summary of summaries) {
    const checked = validateCandidate({summary, kind: 'knowledge', source: 'current-human-statement'});
    if (checked.summary !== summary) throw Error('Invalid approved summary');
  }
  if (![source, workRoot, guard].every(path => typeof path === 'string' && isAbsolute(path))) throw Error('Official hook paths must be absolute');
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) throw Error('Missing ordinary-user credentials');
  if (!config || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.account) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.user)) throw Error('Invalid configured identity');
  const origin = validateOrigin(config.writeUrl || config.serverUrl);
  const logicalId = 'confirmed-' + batchId.slice(2);
  const sessionId = 'cx-' + logicalId;
  const approvedText = summaries.join('\n\n');
  async function request(path, {allowMissing = false} = {}) {
    let response;
    try { response = await fetchImpl(origin + path, {headers: {Authorization: `Bearer ${apiKey}`}, redirect: 'error', signal: AbortSignal.timeout(15000)}); }
    catch { throw Error('Authenticated write-channel read failed'); }
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw Error('Authenticated write-channel read failed');
    let body;
    try { body = await response.json(); } catch { throw Error('Invalid write-channel response'); }
    if (body?.status === 'error') throw Error('Write-channel request was rejected');
    return body;
  }
  assertIdentity(await request('/health'), config);
  const sessionPath = '/api/v1/sessions/' + encodeURIComponent(sessionId);
  const existing = await request(sessionPath, {allowMissing: true});
  if (Number(existing?.result?.commit_count ?? existing?.commit_count) > 0) return {submitted: true, sessionId, taskId: null, recoveredExistingCommit: true, indexStatus: 'not-yet-verified'};
  await mkdir(workRoot, {recursive: true, mode: 0o700});
  const transcript = join(workRoot, batchId + '.approved.jsonl');
  const journal = join(workRoot, batchId + '.receipt.jsonl');
  const lines = [{type: 'turn_context', payload: {}}, {type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: approvedText}]}}];
  await writeFile(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n', {mode: 0o600});
  const envelope = {origin, sessionId, text: approvedText, account: config.account, user: config.user, journal};
  const env = childEnvironment({origin, account: config.account, user: config.user, apiKey, workRoot, guard, envelope});
  const scripts = join(source, 'examples', 'codex-memory-plugin', 'scripts');
  const payload = {session_id: logicalId, transcript_path: transcript, cwd: workRoot, last_assistant_message: '', reason: 'other'};
  try {
    await runScript(join(scripts, 'auto-capture.mjs'), payload, env, {cwd: workRoot});
    await runScript(join(scripts, 'session-end.mjs'), payload, env, {cwd: workRoot});
    const completed = await request(sessionPath);
    if (!(Number(completed?.result?.commit_count ?? completed?.commit_count) >= 1)) throw Error('Official hooks did not acknowledge a commit');
    let receipt;
    try { receipt = JSON.parse((await readFile(journal, 'utf8')).trim().split('\n').at(-1)); } catch { /* A recovered commit may not have a local task id. */ }
    return {submitted: true, sessionId, taskId: typeof receipt?.taskId === 'string' ? receipt.taskId : null, indexStatus: 'not-yet-verified'};
  } finally {
    await unlink(transcript).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
