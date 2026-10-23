import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { assertIdentity, validateOrigin } from './config.mjs';

const PROTOCOL_VERSION = '2025-03-26';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_STRING = 32768;
export const POLICY = Object.freeze({
  autoCapture: false,
  autoRecall: false,
  noAutoInject: true,
  debug: false,
  logBodies: false,
});

class SafeError extends Error {
  constructor(message, code = -32602) {
    super(message);
    this.code = code;
  }
}
const fail = (message, code) => { throw new SafeError(message, code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = description => ({ type: 'string', description });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const boolean = { type: 'boolean' };

function checkedConfig(config) {
  try {
    if (!object(config) || typeof config.account !== 'string' || typeof config.user !== 'string' ||
        !IDENTIFIER.test(config.account) || !IDENTIFIER.test(config.user)) throw new Error();
    validateOrigin(config.serverUrl);
    const memoryRoot = `viking://user/${config.user}/memories/`;
    const resourceRoot = `viking://user/${config.user}/resources/personal-context/`;
    if (config.memoryRoot !== memoryRoot || config.resourceRoot !== resourceRoot) throw new Error();
    return {
      account: config.account,
      user: config.user,
      memoryRoot,
      resourceRoot,
      healthUrl: new URL('/health', config.serverUrl).href,
      mcpUrl: new URL('/mcp', config.serverUrl).href,
    };
  } catch {
    throw new TypeError('A validated OpenViking configuration is required');
  }
}

function toolCatalog(config) {
  const target = { ...string('A URI within the configured memory or personal-context resource roots'), default: config.resourceRoot };
  const definition = (name, description, properties = {}, required = []) => ({
    name,
    description,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  });
  const retrieval = {
    query: { ...string('A short query relevant to the current task'), minLength: 1 },
    target_uri: { ...target, default: config.memoryRoot },
    limit: integer(1, 100),
    min_score: { type: 'number', minimum: 0, maximum: 1 },
    level: { type: 'array', items: integer(0, 2), maxItems: 3 },
    read_content: boolean,
  };
  return [
    definition('health', 'Check service health and the configured account/user identity with role=user.'),
    definition('find', 'Find task-relevant knowledge without session context.', retrieval, ['query']),
    definition('search', 'Search task-relevant knowledge in list mode without a session.', {
      ...retrieval,
      mode: { type: 'string', enum: ['list'], default: 'list' },
    }, ['query']),
    definition('read', 'Read files within the configured knowledge roots.', {
      uris: { type: 'array', items: string('An approved knowledge URI'), minItems: 1, maxItems: 10 },
      offset: integer(0, 1000000), limit: integer(-1, 1000000),
    }, ['uris']),
    definition('list', 'List an approved knowledge directory.', {
      uri: target, recursive: boolean, offset: integer(0, 1000000), limit: integer(1, 10000),
      sort_by: { type: 'string', enum: ['name', 'mtime'] }, sort_order: { type: 'string', enum: ['asc', 'desc'] },
    }),
    definition('tree', 'Inspect an approved knowledge directory tree.', {
      uri: target, level_limit: integer(1, 20), node_limit: integer(1, 10000), include_abstract: boolean,
      offset: integer(0, 1000000), limit: integer(1, 10000),
    }),
    definition('grep', 'Search for text within an approved knowledge directory.', {
      uri: target, pattern: { ...string('A regular expression'), minLength: 1 },
      case_insensitive: boolean, node_limit: integer(1, 1000),
    }, ['pattern']),
    definition('glob', 'Find names using a relative pattern within an approved directory.', {
      uri: target, pattern: { ...string('A relative glob pattern'), minLength: 1 }, node_limit: integer(1, 1000),
    }, ['pattern']),
  ];
}

function checkValue(value, schema) {
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100)) fail('Invalid tool argument');
    for (const item of value) checkValue(item, schema.items);
    return;
  }
  if (schema.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== schema.type) fail('Invalid tool argument');
  if (typeof value === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail('Invalid tool argument');
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > MAX_STRING || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))) fail('Invalid tool argument');
  if (schema.enum && !schema.enum.includes(value)) fail('Invalid tool argument');
}

function checkUri(uri, config) {
  const roots = [config.memoryRoot, config.resourceRoot];
  if (typeof uri !== 'string' || !roots.some(root => uri === root.slice(0, -1) || uri.startsWith(root)) ||
      /[%\\?#\u0000-\u0020\u007f]/u.test(uri) || uri.split('/').some(part => part === '.' || part === '..')) {
    fail('URI outside the configured knowledge scope');
  }
}

function validateCall(catalog, config, name, args = {}) {
  const tool = catalog.get(name);
  if (!tool) fail('Tool denied by read-only policy', -32601);
  if (!object(args)) fail('Tool arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) fail('Argument denied by read-only policy');
    checkValue(args[key], tool.inputSchema.properties[key]);
  }
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) fail('Missing required tool argument');
  const safe = { ...args };
  if (name === 'search') safe.mode = 'list';
  if (name === 'find' || name === 'search') {
    safe.target_uri ??= config.memoryRoot;
    checkUri(safe.target_uri, config);
  }
  if (['list', 'tree', 'grep', 'glob'].includes(name)) {
    safe.uri ??= config.resourceRoot;
    checkUri(safe.uri, config);
  }
  if (name === 'read') safe.uris.forEach(uri => checkUri(uri, config));
  if (name === 'glob' && (/[\\%:\u0000-\u001f\u007f]/u.test(safe.pattern) || safe.pattern.startsWith('/') ||
      safe.pattern.split('/').some(part => part === '.' || part === '..'))) fail('Glob outside the configured knowledge scope');
  return safe;
}

function parseMessages(response, text) {
  if (!text.trim()) return [];
  const type = response.headers.get('content-type') ?? '';
  let messages;
  if (type.toLowerCase().includes('text/event-stream')) {
    messages = text.replace(/\r\n/g, '\n').split('\n\n').flatMap(block => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
    });
  } else {
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(type)) fail('Invalid upstream MCP response', -32001);
    messages = [JSON.parse(text)];
  }
  for (const message of messages) {
    if (!object(message) || message.jsonrpc !== '2.0') fail('Invalid upstream MCP response', -32001);
    if (Object.hasOwn(message, 'id')) {
      if ((message.id !== null && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id))) ||
          Object.hasOwn(message, 'method') || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) fail('Invalid upstream MCP response', -32001);
    } else if (typeof message.method !== 'string') fail('Invalid upstream MCP response', -32001);
  }
  return messages;
}

function resultFor(messages, id) {
  const matches = messages.filter(message => message.id === id);
  if (matches.length !== 1 || !object(matches[0].result) || Object.hasOwn(matches[0], 'error')) fail('Upstream read request failed', -32001);
  return matches[0].result;
}

function checkedContent(block, config) {
  if (!object(block)) fail('Invalid upstream tool response', -32001);
  const checkResponseUri = uri => {
    try { checkUri(uri, config); } catch { fail('Invalid upstream tool response', -32001); }
  };
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (['image', 'audio'].includes(block.type) && typeof block.data === 'string' && typeof block.mimeType === 'string') {
    return { type: block.type, data: block.data, mimeType: block.mimeType };
  }
  if (block.type === 'resource_link' && typeof block.uri === 'string' && typeof block.name === 'string') {
    checkResponseUri(block.uri);
    return { type: 'resource_link', uri: block.uri, name: block.name };
  }
  if (block.type === 'resource' && object(block.resource) && typeof block.resource.uri === 'string' &&
      (typeof block.resource.text === 'string' || typeof block.resource.blob === 'string')) {
    checkResponseUri(block.resource.uri);
    const resource = { uri: block.resource.uri };
    if (typeof block.resource.mimeType === 'string') resource.mimeType = block.resource.mimeType;
    if (typeof block.resource.text === 'string') resource.text = block.resource.text;
    else resource.blob = block.resource.blob;
    return { type: 'resource', resource };
  }
  fail('Invalid upstream tool response', -32001);
}

// 只对返回数据做凭据遮盖；上游错误、认证头和堆栈从不进入协议输出。
function redact(value, key) {
  if (typeof value === 'string') return value.split(key).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), redact(item, key)]));
  return value;
}

export function createHandler({ config, fetchImpl = globalThis.fetch, credentialProvider = () => process.env.OVCM_API_KEY } = {}) {
  const scope = checkedConfig(config);
  const tools = toolCatalog(scope);
  const catalog = new Map(tools.map(tool => [tool.name, tool]));

  async function checkedHealth(key) {
    const response = await fetchImpl(scope.healthUrl, {
      headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || response.redirected) fail('OpenViking health request failed', -32001);
    const health = await response.json();
    try { assertIdentity(health, scope); } catch { fail('OpenViking health or identity check failed', -32001); }
    return { status: 'ok', healthy: true, account_id: scope.account, user_id: scope.user, role: 'user' };
  }

  async function remoteCall(name, args, key) {
    let protocolVersion = PROTOCOL_VERSION;
    let sessionId;
    async function post(message) {
      const headers = {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion,
      };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      const response = await fetchImpl(scope.mcpUrl, {
        method: 'POST', headers, body: JSON.stringify(message), redirect: 'error', signal: AbortSignal.timeout(90000),
      });
      if (!response.ok || response.redirected) fail('OpenViking MCP request failed', -32001);
      const receivedSession = response.headers.get('mcp-session-id');
      if (receivedSession !== null) {
        if (!/^[\x21-\x7e]{1,512}$/u.test(receivedSession) || (sessionId && receivedSession !== sessionId)) fail('Invalid upstream MCP session', -32001);
        sessionId = receivedSession;
      }
      return parseMessages(response, await response.text());
    }
    const initialized = resultFor(await post({
      jsonrpc: '2.0', id: 'readonly-init', method: 'initialize', params: {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'codex-openviking-memory-readonly', version: '0.1.0' },
      },
    }), 'readonly-init');
    if (initialized.protocolVersion !== PROTOCOL_VERSION) fail('Unsupported upstream MCP protocol', -32001);
    protocolVersion = initialized.protocolVersion;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = resultFor(await post({
      jsonrpc: '2.0', id: 'readonly-call', method: 'tools/call', params: { name, arguments: args },
    }), 'readonly-call');
    if (!Array.isArray(result.content) ||
        (result.isError !== undefined && typeof result.isError !== 'boolean')) fail('Invalid upstream tool response', -32001);
    if (result.isError) fail('Upstream read tool failed', -32001);
    const safe = { content: result.content.map(block => checkedContent(block, scope)), isError: false };
    if (Object.hasOwn(result, 'structuredContent')) {
      if (!object(result.structuredContent)) fail('Invalid upstream tool response', -32001);
      safe.structuredContent = result.structuredContent;
    }
    return redact(safe, key);
  }

  return async message => {
    const receivedId = message?.id;
    const id = typeof receivedId === 'string' || (typeof receivedId === 'number' && Number.isFinite(receivedId)) ? receivedId : null;
    const ok = result => ({ jsonrpc: '2.0', id, result });
    try {
      if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
          (Object.hasOwn(message, 'id') && message.id !== null && typeof message.id !== 'string' &&
            !(typeof message.id === 'number' && Number.isFinite(message.id)))) fail('Invalid JSON-RPC request', -32600);
      // 任意通知均仅在本机忽略，不转发对话、采样或会话上下文。
      if (!Object.hasOwn(message, 'id')) return null;
      if (message.method === 'initialize') return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'codex-openviking-memory-readonly', version: '0.1.0' },
        instructions: 'Read configured knowledge only when the current task needs it. Automatic capture, recall, and injection are disabled.',
      });
      if (message.method === 'ping') return ok({});
      if (message.method === 'tools/list') return ok({ tools: structuredClone(tools) });
      if (message.method !== 'tools/call') fail('Method denied by read-only policy', -32601);
      if (!object(message.params) || Object.keys(message.params).some(key => !['name', 'arguments', '_meta'].includes(key))) fail('Invalid tool call');
      const args = validateCall(catalog, scope, message.params.name, message.params.arguments);
      const key = await credentialProvider();
      if (typeof key !== 'string' || !key || /[\u0000-\u0020\u007f]/u.test(key)) fail('A local user credential is required', -32001);
      const health = await checkedHealth(key);
      if (message.params.name === 'health') return ok({ content: [{ type: 'text', text: JSON.stringify(health) }], isError: false });
      return ok(await remoteCall(message.params.name, args, key));
    } catch (error) {
      return { jsonrpc: '2.0', id, error: {
        code: error instanceof SafeError ? error.code : -32001,
        message: error instanceof SafeError ? error.message : 'OpenViking connection failed; check the configured endpoint and local credential',
      } };
    }
  };
}

export async function runMcp({ config, apiKey, input = process.stdin, output = process.stdout, fetchImpl = globalThis.fetch }) {
  const handle = createHandler({ config, fetchImpl, credentialProvider: () => apiKey });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try { response = await handle(JSON.parse(line)); }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (response && !output.write(`${JSON.stringify(response)}\n`)) await once(output, 'drain');
  }
}
