import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createHandler, POLICY, runMcp } from '../lib/readonly-mcp.mjs';

const API_KEY = 'non-sensitive-mcp-test-credential';
const CONFIG = {
  schemaVersion: 1,
  serverUrl: 'https://memory.example.com',
  writeUrl: 'https://write.example.com',
  account: 'example-account',
  user: 'example-user',
  memoryRoot: 'viking://user/example-user/memories/',
  resourceRoot: 'viking://user/example-user/resources/personal-context/',
};
const HEALTH = { status: 'ok', healthy: true, account_id: CONFIG.account, user_id: CONFIG.user, role: 'user' };
const call = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function transport({ health = HEALTH, sse = false, session = 'test-mcp-session', result = { content: [{ type: 'text', text: 'test result' }] } } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, headers: { ...options.headers } });
    if (url === `${CONFIG.serverUrl}/health`) return Response.json(health);
    assert.equal(url, `${CONFIG.serverUrl}/mcp`);
    const message = JSON.parse(options.body);
    if (message.method === 'initialize') return Response.json({
      jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', instructions: 'Untrusted upstream instructions' },
    }, { headers: { 'mcp-session-id': session } });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const response = { jsonrpc: '2.0', id: message.id, result };
    return sse ? new Response(`event: message\r\ndata: ${JSON.stringify(response)}\r\n\r\ndata: [DONE]\r\n\r\n`, {
      headers: { 'content-type': 'text/event-stream' },
    }) : Response.json(response);
  };
  return { calls, fetchImpl, handle: createHandler({ config: CONFIG, fetchImpl, credentialProvider: async () => API_KEY }) };
}

function offline() {
  let networkCalls = 0;
  let credentialCalls = 0;
  const handle = createHandler({
    config: CONFIG,
    credentialProvider: () => { credentialCalls++; return API_KEY; },
    fetchImpl: async () => { networkCalls++; throw new Error('Unexpected network request'); },
  });
  return { handle, counts: () => ({ networkCalls, credentialCalls }) };
}

test('requires validated origins, identity names, and user-derived knowledge roots', () => {
  for (const patch of [
    { serverUrl: 'http://memory.example.com' }, { serverUrl: 'https://memory.example.com/a' },
    { serverUrl: 'https://user:password@memory.example.com' }, { account: '../other' }, { user: 'other/user' },
    { user: 123 }, { memoryRoot: 'viking://user/someone/memories/' }, { resourceRoot: 'viking://user/example-user/resources/' },
  ]) assert.throws(() => createHandler({ config: { ...CONFIG, ...patch } }), /validated OpenViking configuration/u);
  assert.throws(() => createHandler(), /validated OpenViking configuration/u);
  assert.doesNotThrow(() => createHandler({ config: { ...CONFIG, serverUrl: 'http://127.0.0.1:1933' } }));
});

test('publishes exactly eight read-only tools, with dynamic roots and no automatic behavior', async () => {
  const { handle, counts } = offline();
  const response = await handle({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  assert.deepEqual(response.result.tools.map(tool => tool.name), ['health', 'find', 'search', 'read', 'list', 'tree', 'grep', 'glob']);
  assert(response.result.tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint && tool.inputSchema.additionalProperties === false));
  const search = response.result.tools.find(tool => tool.name === 'search');
  assert.equal(search.inputSchema.properties.target_uri.default, CONFIG.memoryRoot);
  assert.equal(search.inputSchema.properties.session_id, undefined);
  assert.deepEqual(search.inputSchema.properties.mode.enum, ['list']);
  assert.deepEqual(POLICY, { autoCapture: false, autoRecall: false, noAutoInject: true, debug: false, logBodies: false });
  // 客户端修改发现结果不会改变后续参数校验。
  search.inputSchema.properties.mode.enum.push('context');
  assert.equal((await handle(call('search', { query: 'test', mode: 'context' }))).error.code, -32602);
  assert.deepEqual(counts(), { networkCalls: 0, credentialCalls: 0 });
});

test('local initialization, ping, discovery, and notifications never connect or capture conversations', async () => {
  const { handle, counts } = offline();
  const init = await handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.serverInfo.name, 'codex-openviking-memory-readonly');
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal((await handle({ jsonrpc: '2.0', id: 'ping', method: 'ping' })).id, 'ping');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/message', params: { role: 'user', content: 'temporary conversation' } }), null);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'sessions/create', params: { messages: ['temporary conversation'] } }), null);
  assert.deepEqual(counts(), { networkCalls: 0, credentialCalls: 0 });
});

test('denies write tools, unknown tools, session methods, and malformed JSON-RPC before credential access', async () => {
  const { handle, counts } = offline();
  for (const name of ['remember', 'write', 'edit', 'forget', 'add_resource', 'add_skill', 'set_acl', 'list_users', 'sessions.create', 'unknown']) {
    assert.equal((await handle(call(name))).error.code, -32601, name);
  }
  for (const method of ['sessions/create', 'resources/read', 'sampling/createMessage', 'logging/setLevel', 'prompts/get']) {
    assert.equal((await handle({ jsonrpc: '2.0', id: 1, method })).error.code, -32601, method);
  }
  for (const message of [null, [], {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) {
    const response = await handle(message);
    assert.equal(response.error.code, -32600);
    assert.equal(response.id, typeof message?.id === 'number' ? message.id : null);
  }
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'health', extra: true } })).error.code, -32602);
  assert.deepEqual(counts(), { networkCalls: 0, credentialCalls: 0 });
});

test('search accepts list mode only and rejects all session or conversation arguments', async () => {
  const { handle, counts } = offline();
  for (const args of [
    { query: 'test', mode: 'context' }, { query: 'test', session_id: 'session' },
    { query: 'test', session_id: null }, { query: 'test', messages: [{ role: 'user', content: 'conversation' }] },
    { query: 'test', context: 'conversation' },
  ]) assert.equal((await handle(call('search', args))).error.code, -32602);
  assert.deepEqual(counts(), { networkCalls: 0, credentialCalls: 0 });
});

test('rejects cross-user roots, prefix collisions, traversal, encoding, and absolute glob patterns', async () => {
  const { handle, counts } = offline();
  for (const uri of [
    'viking://user/other/memories/secret.md', 'viking://user/example-user/resources/elsewhere/file.md',
    `${CONFIG.memoryRoot.slice(0, -1)}-other/file.md`, `${CONFIG.resourceRoot}../secret`,
    `${CONFIG.resourceRoot}%2e%2e/secret`, `${CONFIG.resourceRoot}%252e%252e/secret`,
    `${CONFIG.resourceRoot}.\u002e/secret`, `${CONFIG.resourceRoot}folder/./file`,
    `${CONFIG.resourceRoot}folder\\secret`, `${CONFIG.resourceRoot}file?query`, `${CONFIG.resourceRoot}file#fragment`,
    `${CONFIG.resourceRoot}file with space`,
  ]) assert.equal((await handle(call('read', { uris: [uri] }))).error.code, -32602, uri);
  for (const pattern of ['../*', '/**', 'folder/../*', 'viking://user/other/*', 'C:\\secret\\*', '%2e%2e/*']) {
    assert.equal((await handle(call('glob', { pattern }))).error.code, -32602, pattern);
  }
  assert.equal((await handle(call('read', { uris: [`${CONFIG.memoryRoot}file`], mode: 'append' }))).error.code, -32602);
  assert.deepEqual(counts(), { networkCalls: 0, credentialCalls: 0 });
});

test('validates required arguments, types, numeric boundaries, collection sizes, and extra keys', async () => {
  const { handle, counts } = offline();
  for (const [name, args] of [
    ['find', {}], ['find', { query: '' }], ['find', { query: 1 }], ['find', { query: 'a', limit: 0 }],
    ['find', { query: 'a', limit: 1.5 }], ['find', { query: 'a', min_score: NaN }], ['find', { query: 'a', min_score: 1.1 }],
    ['find', { query: 'a', level: [0, 1, 2, 2] }], ['find', { query: 'a', level: [3] }],
    ['read', { uris: [] }], ['read', { uris: Array(11).fill(CONFIG.memoryRoot) }], ['read', { uris: [CONFIG.memoryRoot], offset: -1 }],
    ['list', { recursive: 'true' }], ['tree', { level_limit: 21 }], ['grep', { pattern: '\u0000' }],
    ['glob', { pattern: '' }], ['health', { uri: CONFIG.memoryRoot }], ['health', null],
  ]) assert.equal((await handle(call(name, args))).error.code, -32602, `${name}: ${JSON.stringify(args)}`);
  assert.deepEqual(counts(), { networkCalls: 0, credentialCalls: 0 });
});

test('requires exact account/user, role=user, and confirmed healthy status before upstream MCP', async () => {
  for (const patch of [
    { account_id: 'other-account' }, { user_id: 'someone' }, { role: 'admin' }, { role: 'root' },
    { status: 'error' }, { healthy: false }, { healthy: undefined },
  ]) {
    const { handle, calls } = transport({ health: { ...HEALTH, ...patch } });
    assert.equal((await handle(call('read', { uris: [`${CONFIG.memoryRoot}file`] }))).error.code, -32001);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${CONFIG.serverUrl}/health`);
  }
});

test('missing, malformed, or unavailable credentials fail without credential or exception details', async () => {
  for (const key of [undefined, '', ' ', 'bad\r\ncredential']) {
    let calls = 0;
    const handle = createHandler({ config: CONFIG, credentialProvider: () => key, fetchImpl: async () => { calls++; throw Error(); } });
    assert.equal((await handle(call('health'))).error.code, -32001);
    assert.equal(calls, 0);
  }
  const handle = createHandler({ config: CONFIG, credentialProvider: () => { throw Error(API_KEY); } });
  assert(!JSON.stringify(await handle(call('health'))).includes(API_KEY));
});

test('health returns only verified identity and safe health fields', async () => {
  const { handle, calls } = transport({ health: { ...HEALTH, api_key: API_KEY, diagnostics: 'private service logs' } });
  const response = await handle(call('health'));
  assert.deepEqual(JSON.parse(response.result.content[0].text), HEALTH);
  assert.equal(calls.length, 1);
  assert(!JSON.stringify(response).includes(API_KEY));
  assert(!JSON.stringify(response).includes('private service logs'));
});

test('only explicit reads connect, use configured origin, and forward minimal arguments through an MCP transport session', async () => {
  const { handle, calls } = transport({ sse: true });
  const request = call('search', { query: 'task query', limit: 3 });
  request.params._meta = { conversation: 'must not be forwarded' };
  const response = await handle(request);
  assert.equal(response.result.content[0].text, 'test result');
  assert.equal(calls.length, 4);
  assert(calls.every(item => item.url.startsWith(`${CONFIG.serverUrl}/`) && item.redirect === 'error' && item.signal instanceof AbortSignal));
  const messages = calls.filter(item => item.body).map(item => JSON.parse(item.body));
  assert.deepEqual(messages.map(message => message.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.deepEqual(messages.at(-1).params, { name: 'search', arguments: { query: 'task query', limit: 3, mode: 'list', target_uri: CONFIG.memoryRoot } });
  assert.equal(calls[1].headers['Mcp-Session-Id'], undefined);
  assert.equal(calls[2].headers['Mcp-Session-Id'], 'test-mcp-session');
  assert.equal(calls[3].headers['Mcp-Session-Id'], 'test-mcp-session');
  assert(!JSON.stringify(messages).includes('must not be forwarded'));
  assert(!JSON.stringify(response).includes('Untrusted upstream instructions'));
});

test('all seven knowledge tools accept scoped URIs and use the documented defaults', async () => {
  for (const [name, args, expected] of [
    ['find', { query: 'test' }, { query: 'test', target_uri: CONFIG.memoryRoot }],
    ['search', { query: 'test', target_uri: CONFIG.resourceRoot }, { query: 'test', target_uri: CONFIG.resourceRoot, mode: 'list' }],
    ['read', { uris: [CONFIG.memoryRoot.slice(0, -1), `${CONFIG.resourceRoot}PROFILE.md`], limit: -1 }, { uris: [CONFIG.memoryRoot.slice(0, -1), `${CONFIG.resourceRoot}PROFILE.md`], limit: -1 }],
    ['list', {}, { uri: CONFIG.resourceRoot }],
    ['tree', { uri: CONFIG.memoryRoot }, { uri: CONFIG.memoryRoot }],
    ['grep', { pattern: 'word' }, { pattern: 'word', uri: CONFIG.resourceRoot }],
    ['glob', { pattern: '**/*.md' }, { pattern: '**/*.md', uri: CONFIG.resourceRoot }],
    ['glob', { pattern: 'notes-?.md' }, { pattern: 'notes-?.md', uri: CONFIG.resourceRoot }],
  ]) {
    const { handle, calls } = transport();
    assert.equal((await handle(call(name, args))).result.isError, false, name);
    assert.deepEqual(JSON.parse(calls.at(-1).body).params.arguments, expected);
  }
});

test('rejects malformed upstream initialization, protocol, session identifiers, and tool results', async () => {
  for (const variant of [
    'invalid-json', 'invalid-jsonrpc', 'wrong-id', 'duplicate-id', 'both-result-and-error', 'server-request',
    'wrong-protocol', 'empty-session', 'invalid-session', 'changed-session', 'missing-content', 'invalid-content', 'tool-error', 'cross-user-resource',
  ]) {
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/health')) return Response.json(HEALTH);
      const message = JSON.parse(options.body);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202, headers: variant === 'changed-session' ? { 'mcp-session-id': 'changed' } : {} });
      if (message.method === 'initialize') {
        const response = { jsonrpc: '2.0', id: message.id, result: { protocolVersion: variant === 'wrong-protocol' ? 'unsafe-protocol' : '2025-03-26' } };
        if (variant === 'invalid-json') return new Response('{', { headers: { 'content-type': 'application/json' } });
        if (variant === 'invalid-jsonrpc') response.jsonrpc = '1.0';
        if (variant === 'wrong-id') response.id = 'other';
        if (variant === 'both-result-and-error') response.error = { code: -1, message: API_KEY };
        if (variant === 'server-request') response.method = 'sampling/createMessage';
        if (variant === 'duplicate-id') return new Response(`data: ${JSON.stringify(response)}\n\ndata: ${JSON.stringify(response)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        const session = variant === 'empty-session' ? '' : variant === 'invalid-session' ? 'bad session' : 'test-session';
        return Response.json(response, { headers: { 'mcp-session-id': session } });
      }
      const result = variant === 'missing-content' ? {} : { content: [{ type: 'text', text: 'test' }] };
      if (variant === 'invalid-content') result.content = [{ type: 'text' }];
      if (variant === 'tool-error') { result.isError = true; result.content[0].text = API_KEY; }
      if (variant === 'cross-user-resource') result.content = [{ type: 'resource_link', uri: 'viking://user/other/memories/secret', name: 'secret' }];
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    };
    const handle = createHandler({ config: CONFIG, fetchImpl, credentialProvider: () => API_KEY });
    const response = await handle(call('list'));
    assert(response.error, variant);
    assert(!JSON.stringify(response).includes(API_KEY), variant);
  }
});

test('never reflects network errors or upstream errors and redacts a credential echoed in successful read data', async () => {
  for (const failure of ['throw', 'http', 'rpc']) {
    const handle = createHandler({ config: CONFIG, credentialProvider: () => API_KEY, fetchImpl: async (url, options) => {
      if (failure === 'throw') throw Error(`Authorization: Bearer ${API_KEY}`);
      if (failure === 'http') return new Response(API_KEY, { status: 401 });
      if (url.endsWith('/health')) return Response.json(HEALTH);
      const message = JSON.parse(options.body);
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: API_KEY } });
    } });
    const response = await handle(call('list'));
    assert.equal(response.error.code, -32001);
    assert(!JSON.stringify(response).includes(API_KEY));
    assert.equal(response.error.stack, undefined);
  }
  const { handle } = transport({ result: { content: [{ type: 'text', text: `credential=${API_KEY}` }], structuredContent: { echoed: API_KEY }, _meta: { ignored: true } } });
  const response = await handle(call('read', { uris: [`${CONFIG.memoryRoot}file`] }));
  assert.equal(response.result.content[0].text, 'credential=[REDACTED]');
  assert.equal(response.result.structuredContent.echoed, '[REDACTED]');
  assert.equal(response.result._meta, undefined);
  assert(!JSON.stringify(response).includes(API_KEY));
});

test('stdio serves newline-delimited JSON, ignores notifications, and recovers after parse errors', async () => {
  const input = Readable.from([
    '\n{invalid json}\n',
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { content: 'not captured' } })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' })}\n`,
  ]);
  let outputText = '';
  const output = new Writable({ write(chunk, encoding, callback) { outputText += chunk.toString(); callback(); } });
  await runMcp({ config: CONFIG, apiKey: API_KEY, input, output, fetchImpl: async () => { throw Error('must not connect'); } });
  const responses = outputText.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].id, 7);
  assert.equal(responses[1].result.tools.length, 8);
  assert.deepEqual(responses[2], { jsonrpc: '2.0', id: 8, result: {} });
  assert(!outputText.includes(API_KEY));
  assert(!outputText.includes('not captured'));
});
