import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { hiddenCredentialPrompt, integrationContents, parseInstallerArgs, posixQuote, windowsInstallerArgs } from '../scripts/install.mjs';

const installerPath = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const darwinOnly = { skip: process.platform === 'darwin' ? false : 'Native macOS Keychain smoke test runs on the macOS CI job' };
const required = ['--server-url', 'https://memory.example.com', '--account', 'test-account', '--user', 'test-user'];
const macOptions = { platform: 'darwin', homeDir: '/Users/example', keychainPath: undefined };

function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ['OVCM_API_KEY', 'OVCM_VAULT_KEY', 'OVCM_CONFIG']) delete env[name];
  return env;
}

function assertSuccess(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('unified installer validates arguments and keeps Windows delegation as argv', () => {
  const options = parseInstallerArgs([...required, '--data-dir', 'C:\\data with spaces', '--skip-doctor', '--no-credential-prompt'], {
    platform: 'win32', homeDir: 'C:\\Users\\test', localAppData: 'C:\\Users\\test\\AppData\\Local', keychainPath: undefined,
  });
  assert.equal(options.dataDir, 'C:\\data with spaces');
  assert.deepEqual(windowsInstallerArgs(options, 'C:\\source with spaces\\scripts\\install.ps1'), [
    '-NoLogo', '-NoProfile', '-File', 'C:\\source with spaces\\scripts\\install.ps1',
    '-ServerUrl', 'https://memory.example.com', '-Account', 'test-account', '-User', 'test-user',
    '-WriteUrl', 'https://memory.example.com', '-DataDir', 'C:\\data with spaces', '-SkipDoctor', '-NoCredentialPrompt',
  ]);
  const mac = parseInstallerArgs(required, macOptions);
  assert.equal(mac.dataDir, '/Users/example/Library/Application Support/CodexOpenVikingMemory');
  assert.equal(mac.writeUrl, mac.serverUrl);
  assert.deepEqual(parseInstallerArgs(['--help'], { platform: 'linux' }), { help: true });
  assert.throws(() => parseInstallerArgs(required, { platform: 'linux' }), /Windows and macOS only/);
  assert.throws(() => parseInstallerArgs([...required, '--no-credential-prompt'], macOptions), /requires --skip-doctor/);
  assert.throws(() => parseInstallerArgs([...required, '--keychain', '/tmp/test.keychain'], { platform: 'win32' }), /only on macOS/);
  assert.throws(() => parseInstallerArgs([...required, '--keychain', ''], { platform: 'win32' }), /only on macOS/);
  assert.throws(() => windowsInstallerArgs({ ...options, keychainPath: '' }), /only on macOS/);
  assert.throws(() => parseInstallerArgs([...required, '--keychain', 'relative'], macOptions), /absolute path/);
  assert.throws(() => parseInstallerArgs([...required, '--keychain', ''], macOptions), /absolute path/);
  assert.throws(() => parseInstallerArgs(required, { ...macOptions, keychainPath: '' }), /absolute path/);
  assert.throws(() => parseInstallerArgs([...required, '--keychain', ''], { ...macOptions, keychainPath: '/tmp/valid.keychain' }), /absolute path/);
  assert.equal(parseInstallerArgs([...required, '--keychain', '/tmp/explicit.keychain'], { ...macOptions, keychainPath: '' }).keychainPath, '/tmp/explicit.keychain');
  assert.throws(() => parseInstallerArgs([...required, '--data-dir', 'relative'], macOptions), /absolute --data-dir/);
  assert.throws(() => parseInstallerArgs(['--server-url', 'http://memory.example.com', '--account', 'test', '--user', 'test'], macOptions), /HTTPS/);
});

test('macOS generated hooks and model command use literal POSIX arguments', () => {
  const dataDir = "/Users/example/Library/Application Support/memory's $(touch unexpected)";
  const nodePath = '/opt/node with spaces/bin/node';
  const cliPath = dataDir + '/runtime/bin/cli.mjs';
  const files = integrationContents({ dataDir, nodePath, cliPath, version: '0.2.0' });
  const { hooks } = JSON.parse(files.get('marketplace/plugins/codex-openviking-memory/hooks/hooks.json'));
  assert.deepEqual(Object.keys(hooks), ['UserPromptSubmit', 'Stop']);
  for (const [event, entries] of Object.entries(hooks)) {
    assert.equal(entries[0].hooks[0].command, `${posixQuote(nodePath)} ${posixQuote(cliPath)} hook ${event} --config ${posixQuote(dataDir + '/config.json')}`);
  }
  const manifest = JSON.parse(files.get('marketplace/plugins/codex-openviking-memory/.codex-plugin/plugin.json'));
  assert.equal(manifest.version, '0.2.0');
  const mcp = files.get('mcp-config.toml');
  assert.ok(mcp.includes(`command = ${JSON.stringify(nodePath)}`));
  assert.match(mcp, /"mcp", "--config"/);
  const rules = files.get('AGENTS.fragment.md');
  assert.match(rules, /request_user_input_async/);
  assert.match(rules, /"save candidate <REAL_ID>" and "Not now"/);
  assert.match(rules, /Never invoke the hook entrypoint yourself/);
  assert.match(rules, /navigation and record templates, not personal facts/);
  assert.match(rules, /do not automatically write Markdown/);
  assert.equal(posixQuote("a'b$(echo x)`echo y`"), "'a'\\''b$(echo x)`echo y`'");
  assert.throws(() => posixQuote('bad\nargument'), /Invalid command argument/);
  if (process.platform !== 'win32') {
    const literal = "a'b$(echo x)`echo y` with spaces";
    const quoted = spawnSync('/bin/sh', ['-c', `printf '%s' ${posixQuote(literal)}`], { encoding: 'utf8' });
    assertSuccess(quoted);
    assert.equal(quoted.stdout, literal);
  }
});

test('hidden credential input never echoes typed text and restores the TTY on completion or cancellation', async () => {
  function mockTerminal() {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; return input; };
    let written = '';
    return { input, output: { write: text => { written += text; } }, written: () => written };
  }
  const terminal = mockTerminal();
  const credential = hiddenCredentialPrompt(terminal);
  terminal.input.emit('keypress', 'synthetic-hidden-value', {});
  terminal.input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await credential, 'synthetic-hidden-value');
  assert.equal(terminal.written().includes('synthetic-hidden-value'), false);
  assert.equal(terminal.input.isRaw, false);
  assert.equal(terminal.input.isPaused(), true);
  terminal.input.destroy();
  const cancelled = mockTerminal();
  const pending = hiddenCredentialPrompt(cancelled);
  cancelled.input.emit('keypress', '\u0003', { ctrl: true, name: 'c' });
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancelled.input.isRaw, false);
  cancelled.input.destroy();
  await assert.rejects(hiddenCredentialPrompt({ input: { isTTY: false }, output: { write() {} } }), /TTY is required/);
});

test('Windows unified entry performs an isolated offline installation and initializes the local template', {
  skip: process.platform === 'win32' ? false : 'Windows delegation smoke test runs in Windows CI',
}, async (t) => {
  const tempParent = realpathSync.native(os.tmpdir());
  const temporaryRoot = realpathSync.native(await mkdtemp(path.join(tempParent, 'ovcm unified windows ')));
  t.after(async () => {
    const target = realpathSync.native(temporaryRoot);
    assert.equal(path.dirname(target).toLowerCase(), tempParent.toLowerCase());
    assert.ok(path.basename(target).startsWith('ovcm unified windows '));
    await rm(target, { recursive: true, force: true });
  });
  const dataDir = path.join(temporaryRoot, 'data with spaces');
  const result = spawnSync(process.execPath, [installerPath, ...required, '--data-dir', dataDir,
    '--skip-doctor', '--no-credential-prompt'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: childEnvironment() });
  assertSuccess(result);
  const configPath = path.join(dataDir, 'config.json');
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).dataDir, dataDir);
  assert.ok((await readFile(path.join(dataDir, 'knowledge', 'PROFILE.md'), 'utf8')).length);
  await assert.rejects(stat(path.join(dataDir, 'secrets', 'api-key.dpapi')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(dataDir, 'state', 'readiness.json')), { code: 'ENOENT' });
  const mapped = spawnSync(process.execPath, [path.join(dataDir, 'runtime', 'bin', 'cli.mjs'),
    'template', 'map', '--config', configPath], { encoding: 'utf8', timeout: 20_000, windowsHide: true, env: childEnvironment() });
  assertSuccess(mapped);
  assert.equal(JSON.parse(mapped.stdout).localRoot, path.join(dataDir, 'knowledge'));
});

test('macOS native isolated Keychain install supports installed propose/status and preserves keys, config, and edited templates', darwinOnly, async (t) => {
  const tempParent = await realpath(os.tmpdir());
  const temporaryRoot = await realpath(await mkdtemp(path.join(tempParent, 'ovcm macos installer ')));
  const dataDir = path.join(temporaryRoot, "data with spaces and 'quote'");
  const keychainPath = path.join(temporaryRoot, 'isolated.keychain-db');
  const keychainPassword = 'synthetic-keychain-' + randomBytes(12).toString('hex');
  t.after(async () => {
    if (process.platform !== 'darwin') return;
    spawnSync('/usr/bin/security', ['delete-keychain', keychainPath], { encoding: 'utf8', timeout: 15_000 });
    const target = await realpath(temporaryRoot);
    assert.equal(path.dirname(target), tempParent);
    assert.ok(path.basename(target).startsWith('ovcm macos installer '));
    await rm(target, { recursive: true, force: true });
  });
  assertSuccess(spawnSync('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychainPath], { encoding: 'utf8', timeout: 15_000 }));
  assertSuccess(spawnSync('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychainPath], { encoding: 'utf8', timeout: 15_000 }));
  const { keychainService, readKeychainSecret, writeKeychainSecret } = await import('../lib/keychain.mjs');
  const credential = { service: keychainService(dataDir), keychainPath };
  const guardPath = path.join(temporaryRoot, 'deny-network.mjs');
  await writeFile(guardPath, "globalThis.fetch = async () => { throw Error('Unexpected network request in offline installer test'); };\n");
  const environment = childEnvironment({ OVCM_KEYCHAIN_PATH: keychainPath, NODE_OPTIONS: '--import=' + pathToFileURL(guardPath).href });
  const install = extra => spawnSync(process.execPath, [installerPath, ...required, '--data-dir', dataDir,
    '--keychain', keychainPath, '--skip-doctor', '--no-credential-prompt', ...extra], {
    encoding: 'utf8', timeout: 60_000, env: environment,
  });
  const first = install([]);
  assertSuccess(first);
  assert.match(first.stdout, /Doctor skipped/);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  const configPath = path.join(dataDir, 'config.json');
  const beforeConfig = await readFile(configPath, 'utf8');
  const config = JSON.parse(beforeConfig);
  assert.deepEqual(Object.keys(config).sort(), ['account', 'dataDir', 'schemaVersion', 'serverUrl', 'user', 'writeUrl']);
  const vaultKey = await readKeychainSecret({ ...credential, account: 'vault-key' });
  assert.equal(Buffer.from(vaultKey, 'base64').length, 32);
  assert.equal(await readKeychainSecret({ ...credential, account: 'api-key' }), null);
  await assert.rejects(stat(path.join(dataDir, 'secrets', 'vault-key.dpapi')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(dataDir, 'state', 'readiness.json')), { code: 'ENOENT' });
  const inputPath = path.join(temporaryRoot, 'synthetic candidate.json');
  const summary = 'Synthetic native macOS installation test; not a personal fact.';
  await writeFile(inputPath, JSON.stringify({ summary, kind: 'knowledge', source: 'current-human-statement' }));
  const cliPath = path.join(dataDir, 'runtime', 'bin', 'cli.mjs');
  const invokeCli = args => spawnSync(process.execPath, [cliPath, ...args, '--config', configPath], {
    encoding: 'utf8', timeout: 20_000, env: environment,
  });
  const proposed = invokeCli(['propose', '--input', inputPath]);
  assertSuccess(proposed);
  const candidate = JSON.parse(proposed.stdout);
  assert.match(candidate.id, /^[a-f0-9]{16}$/);
  assert.equal(candidate.status, 'pending');
  const encrypted = await readFile(path.join(dataDir, 'candidate-vault', candidate.id + '.bin'), 'utf8');
  assert.equal(encrypted.includes(summary), false);
  const status = invokeCli(['status', '--id', candidate.id]);
  assertSuccess(status);
  assert.equal(JSON.parse(status.stdout).status, 'pending');
  assert.equal(status.stdout.includes(summary), false);
  const profilePath = path.join(dataDir, 'knowledge', 'PROFILE.md');
  await writeFile(profilePath, '# Synthetic preserved template edit\n');
  const syntheticApi = 'isolated-native-installer-test-' + randomBytes(8).toString('hex');
  await writeKeychainSecret({ ...credential, account: 'api-key', value: syntheticApi });
  assertSuccess(install([]));
  assert.equal(await readFile(configPath, 'utf8'), beforeConfig);
  assert.equal(await readFile(profilePath, 'utf8'), '# Synthetic preserved template edit\n');
  assert.ok(await readKeychainSecret({ ...credential, account: 'vault-key' }) === vaultKey, 'The existing vault key must be preserved');
  assert.ok(await readKeychainSecret({ ...credential, account: 'api-key' }) === syntheticApi, 'The existing API key must be preserved');
  delete config.writeUrl;
  const configWithoutWriteUrl = JSON.stringify(config, null, 4) + '\n\n';
  await writeFile(configPath, configWithoutWriteUrl);
  assertSuccess(install([]));
  assert.equal(await readFile(configPath, 'utf8'), configWithoutWriteUrl);
  assert.equal(await readFile(profilePath, 'utf8'), '# Synthetic preserved template edit\n');
  assert.ok(await readKeychainSecret({ ...credential, account: 'vault-key' }) === vaultKey, 'A config omitting optional writeUrl must preserve the vault key');
  assert.ok(await readKeychainSecret({ ...credential, account: 'api-key' }) === syntheticApi, 'A config omitting optional writeUrl must preserve the API key');
  const incompatible = install(['--user', 'different-test-user']);
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /incompatible/);
  assert.equal(await readFile(configPath, 'utf8'), configWithoutWriteUrl);
});
