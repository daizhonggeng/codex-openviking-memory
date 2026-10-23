import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createKeychainClient, keychainService, readKeychainSecret, writeKeychainSecret, deleteKeychainSecret} from '../lib/keychain.mjs';
import {createCredentialLoader, loadCredentials} from '../lib/credentials.mjs';

const testRoot = resolve(tmpdir(), 'ovcm-unit-keychain');
const service = keychainService(testRoot);
const target = {service, account: 'api-key', keychainPath: join(testRoot, 'isolated.keychain-db')};

function mockNative({code = 0, output = '', stderr = '', fail = false} = {}) {
  const calls = [];
  const spawnImpl = (program, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', null); };
    const call = {program, args, options, input: ''};
    calls.push(call);
    child.stdin.on('data', chunk => { call.input += chunk; });
    child.stdin.on('finish', () => queueMicrotask(() => {
      if (fail) child.emit('error', Error('RAW-SENSITIVE-NATIVE-FAILURE'));
      else {
        child.stdout.end(output);
        child.stderr.end(stderr);
        child.emit('close', code);
      }
    }));
    return child;
  };
  return {calls, client: createKeychainClient({platform: 'darwin', spawnImpl})};
}

// Minimal mirror of Apple's security.c split_line quoted-argument grammar.
// It validates our stdin escaping without spawning a shell or native binary.
function parseSecurityInput(input) {
  const values = [];
  const pattern = /"((?:\\.|[^"\\])*)"(?:\s+|$)/g;
  let match;
  let end = 0;
  while ((match = pattern.exec(input))) {
    assert.equal(match.index, end);
    values.push(match[1].replace(/\\(.)/g, '$1'));
    end = pattern.lastIndex;
  }
  assert.equal(end, input.length);
  return values;
}

test('Keychain service identity is deterministic, private and scoped to an absolute data directory', () => {
  assert.equal(keychainService(testRoot), service);
  assert.match(service, /^com\.codex-openviking-memory\.[a-f0-9]{32}$/);
  assert.notEqual(keychainService(join(testRoot, 'other')), service);
  assert.ok(!service.includes(testRoot));
  assert.throws(() => keychainService('relative'), /absolute/);
  assert.throws(() => keychainService(testRoot + '\n'), /absolute/);
});

test('Keychain reads use native argv containing only identifiers, and remove only the final output newline', async () => {
  const {client, calls} = mockNative({output: 'synthetic-key\n'});
  assert.equal(await client.readKeychainSecret(target), 'synthetic-key');
  assert.equal(calls[0].program, '/usr/bin/security');
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', service, '-a', 'api-key', '-w', target.keychainPath]);
  assert.equal(calls[0].input, '');
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('Keychain secret writes travel only through safely escaped stdin, never argv, env or files', async () => {
  const {client, calls} = mockNative();
  const value = 'synthetic!"\\\'$()`;|&<>=';
  await client.writeKeychainSecret({...target, value});
  assert.deepEqual(calls[0].args, ['-i']);
  assert.ok(!JSON.stringify(calls[0].args).includes(value));
  assert.ok(!JSON.stringify(calls[0].options).includes(value));
  assert.deepEqual(parseSecurityInput(calls[0].input), ['add-generic-password', '-U', '-s', service, '-a', 'api-key', '-w', value, '-T', '/usr/bin/security', target.keychainPath]);
  assert.equal(calls[0].input.split('\n').length, 2);
  for (const name of ['OVCM_API_KEY', 'OVCM_VAULT_KEY', 'NODE_OPTIONS', 'OPENVIKING_API_KEY']) assert.equal(calls[0].options.env[name], undefined);
});

test('missing Keychain items return null, but locked/native failures never expose native diagnostics', async () => {
  const missing = mockNative({code: 44, stderr: 'raw item metadata'});
  assert.equal(await missing.client.readKeychainSecret(target), null);
  for (const settings of [{code: 36, stderr: 'RAW-SENSITIVE-NATIVE-FAILURE'}, {fail: true}]) {
    const {client} = mockNative(settings);
    await assert.rejects(client.readKeychainSecret(target), error => /Keychain could not be accessed/.test(error.message) && !error.message.includes('RAW-SENSITIVE'));
    await assert.rejects(client.writeKeychainSecret({...target, value: 'synthetic-key'}), error => /Keychain could not be accessed/.test(error.message) && !error.message.includes('RAW-SENSITIVE'));
  }
});

test('invalid targets, multiline secrets and overlong native commands never spawn', async () => {
  const {client, calls} = mockNative();
  for (const override of [{service: 'other-app'}, {account: 'root'}, {keychainPath: 'relative'}, {keychainPath: target.keychainPath + '\n'}]) await assert.rejects(client.readKeychainSecret({...target, ...override}));
  for (const value of ['', 'secret\nnext-command', 'secret\rnext-command', 'secret\0suffix', '非ASCII值', 'x'.repeat(5000)]) await assert.rejects(client.writeKeychainSecret({...target, value}));
  assert.equal(calls.length, 0);
  const otherPlatform = createKeychainClient({platform: 'linux', spawnImpl: () => assert.fail('must not spawn')});
  await assert.rejects(otherPlatform.readKeychainSecret(target), /require macOS/);
});

test('cleanup deletes only an explicit isolated Keychain target and tolerates a missing test item', async () => {
  const {client, calls} = mockNative();
  await assert.rejects(client.deleteKeychainSecret({service, account: 'api-key'}), /explicit isolated/);
  assert.equal(await client.deleteKeychainSecret(target), true);
  assert.deepEqual(calls[0].args, ['delete-generic-password', '-s', service, '-a', 'api-key', target.keychainPath]);
  const missing = mockNative({code: 44});
  assert.equal(await missing.client.deleteKeychainSecret(target), false);
});

test('Darwin credential loading selects both native accounts and the optional isolated keychain path', async () => {
  const calls = [];
  const vaultKey = randomBytes(32).toString('base64');
  const load = createCredentialLoader({platform: 'darwin', env: {OVCM_KEYCHAIN_PATH: target.keychainPath}, keychainReader: async value => { calls.push(value); return value.account === 'api-key' ? 'synthetic-api-key' : vaultKey; }, dpapiReader: () => assert.fail('Darwin must use native Keychain')});
  assert.deepEqual(await load({dataDir: testRoot}), {apiKey: 'synthetic-api-key', vaultKey});
  assert.deepEqual(calls, [{service, account: 'api-key', keychainPath: target.keychainPath}, {service, account: 'vault-key', keychainPath: target.keychainPath}]);
});

test('credential overrides and requested scopes avoid native access; Windows retains DPAPI paths', async () => {
  const vaultKey = randomBytes(32).toString('base64');
  const overridden = createCredentialLoader({platform: 'darwin', env: {OVCM_API_KEY: 'synthetic-env-key', OVCM_VAULT_KEY: vaultKey}, keychainReader: () => assert.fail('Explicit override must not access Keychain')});
  assert.deepEqual(await overridden({dataDir: testRoot}), {apiKey: 'synthetic-env-key', vaultKey});
  assert.deepEqual(await overridden({dataDir: testRoot}, {needApi: false, needVault: false}), {});
  const paths = [];
  const windows = createCredentialLoader({platform: 'win32', env: {}, keychainReader: () => assert.fail('Windows must retain DPAPI'), dpapiReader: async path => { paths.push(path); return path.endsWith('api-key.dpapi') ? 'synthetic-dpapi-key' : vaultKey; }});
  assert.deepEqual(await windows({dataDir: testRoot}), {apiKey: 'synthetic-dpapi-key', vaultKey});
  assert.deepEqual(paths, [join(testRoot, 'secrets', 'api-key.dpapi'), join(testRoot, 'secrets', 'vault-key.dpapi')]);
});

test('missing or invalid native credentials fail with bounded local validation errors', async () => {
  const missing = createCredentialLoader({platform: 'darwin', env: {}, keychainReader: async () => null});
  await assert.rejects(missing({dataDir: testRoot}), /credential is missing/);
  const invalid = createCredentialLoader({platform: 'darwin', env: {}, keychainReader: async () => 'synthetic\0secret'});
  await assert.rejects(invalid({dataDir: testRoot}), error => !error.message.includes('synthetic'));
});

test('native macOS isolated Keychain roundtrip and runtime credential loading', {skip: process.platform !== 'darwin' ? 'Native /usr/bin/security test runs in macOS CI' : false}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ovcm-native-keychain-'));
  const keychainPath = join(root, 'isolated.keychain-db');
  const execute = promisify(execFile);
  // The keychain password is a synthetic test value, never a user credential.
  const password = randomBytes(24).toString('hex');
  await execute('/usr/bin/security', ['create-keychain', '-p', password, keychainPath]);
  t.after(async () => {
    await execute('/usr/bin/security', ['delete-keychain', keychainPath]).catch(() => {});
    await rm(root, {recursive: true, force: true});
  });
  await execute('/usr/bin/security', ['unlock-keychain', '-p', password, keychainPath]);
  const nativeTarget = {service: keychainService(root), account: 'api-key', keychainPath};
  const apiKey = 'synthetic-api!"\\\'$()`;|&<>=';
  const vaultKey = randomBytes(32).toString('base64');
  assert.equal(await readKeychainSecret(nativeTarget), null);
  await writeKeychainSecret({...nativeTarget, value: apiKey});
  await writeKeychainSecret({...nativeTarget, account: 'vault-key', value: vaultKey});
  assert.equal(await readKeychainSecret(nativeTarget), apiKey);
  assert.equal(await readKeychainSecret({...nativeTarget, account: 'vault-key'}), vaultKey);
  const saved = Object.fromEntries(['OVCM_KEYCHAIN_PATH', 'OVCM_API_KEY', 'OVCM_VAULT_KEY'].map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.OVCM_KEYCHAIN_PATH = keychainPath;
  delete process.env.OVCM_API_KEY;
  delete process.env.OVCM_VAULT_KEY;
  assert.deepEqual(await loadCredentials({dataDir: root}), {apiKey, vaultKey});
  await writeKeychainSecret({...nativeTarget, value: 'synthetic-updated-key'});
  assert.equal(await readKeychainSecret(nativeTarget), 'synthetic-updated-key');
  assert.equal(await deleteKeychainSecret(nativeTarget), true);
  assert.equal(await readKeychainSecret(nativeTarget), null);
  assert.equal(await deleteKeychainSecret({...nativeTarget, account: 'vault-key'}), true);
});
