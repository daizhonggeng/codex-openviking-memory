#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateConfig, validateOrigin } from '../lib/config.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const identifiers = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const runtimeDirectories = ['bin', 'lib', 'vendor', 'templates'];
const runtimeFiles = ['package.json', 'LICENSE', 'NOTICE'];
const help = `Install Codex OpenViking Memory on Windows or macOS (Node.js 22+).

node scripts/install.mjs --server-url HTTPS_ORIGIN --account ACCOUNT --user USER
  [--write-url HTTPS_ORIGIN] [--data-dir ABSOLUTE_PATH] [--skip-doctor]
  [--no-credential-prompt] [--keychain ABSOLUTE_PATH]

--no-credential-prompt requires --skip-doctor and is for isolated offline tests.
--keychain is a macOS-only isolated Keychain override; config.json stays unchanged.
Existing Codex config.toml and AGENTS.md are never edited.
`;

export function parseInstallerArgs(argv, {
  platform = process.platform, homeDir = homedir(), localAppData = process.env.LOCALAPPDATA,
  keychainPath = process.env.OVCM_KEYCHAIN_PATH,
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      'server-url': { type: 'string' }, account: { type: 'string' }, user: { type: 'string' },
      'write-url': { type: 'string' }, 'data-dir': { type: 'string' },
      'skip-doctor': { type: 'boolean' }, 'no-credential-prompt': { type: 'boolean' },
      keychain: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } }));
  } catch { throw Error('Invalid installer arguments; use --help for supported flags.'); }
  if (values.help) return { help: true };
  if (!['win32', 'darwin'].includes(platform)) throw Error('The native installer supports Windows and macOS only.');
  if (!identifiers.test(values.account ?? '') || !identifiers.test(values.user ?? '')) {
    throw Error('Provide explicit --account and --user safe identifiers.');
  }
  const serverUrl = validateOrigin(values['server-url']);
  const writeUrl = validateOrigin(values['write-url'] ?? serverUrl);
  if (values['no-credential-prompt'] && !values['skip-doctor']) {
    throw Error('--no-credential-prompt is for isolated offline tests and requires --skip-doctor.');
  }
  if (values.keychain !== undefined && platform !== 'darwin') throw Error('--keychain is supported only on macOS.');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const defaultDataDir = platform === 'win32'
    ? localAppData && paths.join(localAppData, 'CodexOpenVikingMemory')
    : paths.join(homeDir, 'Library', 'Application Support', 'CodexOpenVikingMemory');
  const dataDir = values['data-dir'] ?? defaultDataDir;
  if (!dataDir || !paths.isAbsolute(dataDir) || /[\x00-\x1f\x7f]/.test(dataDir)) throw Error('Provide an absolute --data-dir without control characters.');
  const selectedKeychain = platform === 'darwin' ? values.keychain ?? keychainPath : undefined;
  if (selectedKeychain !== undefined && (typeof selectedKeychain !== 'string' || !paths.isAbsolute(selectedKeychain) || /[\x00-\x1f\x7f]/.test(selectedKeychain))) throw Error('--keychain must be an absolute path without control characters.');
  return {
    platform, serverUrl, writeUrl, account: values.account, user: values.user,
    dataDir: paths.resolve(dataDir), skipDoctor: values['skip-doctor'] ?? false,
    noCredentialPrompt: values['no-credential-prompt'] ?? false,
    ...(selectedKeychain !== undefined ? { keychainPath: paths.resolve(selectedKeychain) } : {}),
  };
}

export function windowsInstallerArgs(options, installerPath = path.join(repositoryRoot, 'scripts', 'install.ps1')) {
  if (options.keychainPath !== undefined) throw Error('--keychain is supported only on macOS.');
  return ['-NoLogo', '-NoProfile', '-File', installerPath,
    '-ServerUrl', options.serverUrl, '-Account', options.account, '-User', options.user,
    '-WriteUrl', options.writeUrl, '-DataDir', options.dataDir,
    ...(options.skipDoctor ? ['-SkipDoctor'] : []),
    ...(options.noCredentialPrompt ? ['-NoCredentialPrompt'] : []),
  ];
}

export function posixQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw Error('Invalid command argument.');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function integrationContents({ dataDir, nodePath, cliPath, version }) {
  const configPath = path.posix.join(dataDir, 'config.json');
  const command = `${posixQuote(nodePath)} ${posixQuote(cliPath)}`;
  const hooks = {};
  for (const event of ['UserPromptSubmit', 'Stop']) {
    hooks[event] = [{ matcher: '*', hooks: [{ type: 'command',
      command: `${command} hook ${event} --config ${posixQuote(configPath)}`,
      timeout: event === 'Stop' ? 60 : 10,
    }] }];
  }
  const json = value => JSON.stringify(value, null, 2) + '\n';
  return new Map([
    ['marketplace/.agents/plugins/marketplace.json', json({
      name: 'codex-openviking-memory-local', interface: { displayName: 'OpenViking Memory (local)' },
      plugins: [{ name: 'codex-openviking-memory', source: { source: 'local', path: './plugins/codex-openviking-memory' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
    })],
    ['marketplace/plugins/codex-openviking-memory/.codex-plugin/plugin.json', json({
      name: 'codex-openviking-memory', version,
      description: 'Local encrypted memory candidates with explicit human approval and a read-only OpenViking MCP.',
      author: { name: 'codex-openviking-memory contributors' }, hooks: './hooks/hooks.json',
      interface: { displayName: 'OpenViking Memory', shortDescription: 'Approve selected summaries before capture', category: 'Productivity' },
    })],
    ['marketplace/plugins/codex-openviking-memory/hooks/hooks.json', json({ hooks })],
    ['mcp-config.toml', `[mcp_servers.openviking_memory]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${JSON.stringify(cliPath)}, "mcp", "--config", ${JSON.stringify(configPath)}]\nstartup_timeout_sec = 30\n`],
    ['AGENTS.fragment.md', `## Confirmed OpenViking memory candidates

For each current human message, make a semantic judgment about explicitly stated stable facts, long-term preferences, current goals, or reusable experience worth retaining. Do not infer facts from history, tools, third parties, fictional examples, templates, or this installation. If nothing is worth retaining, answer normally without a candidate notice.

Propose at most three concise candidates per turn. Never include credentials, sensitive identifiers, chat transcripts, or tool logs. Write a temporary UTF-8 JSON object with exactly summary, kind (profile / preference / current / knowledge), and source (current-human-statement), then run:

    ${command} propose --config ${posixQuote(configPath)} --input '<absolute-candidate-json-path>'

Use the returned real candidate ID. Show its summary and suggested category. Prefer a native request_user_input_async confirmation card with choices exactly "save candidate <REAL_ID>" and "Not now" (Chinese: "保存候选 <REAL_ID>" / "暂不保存"). If this client lacks a native card tool, clearly state that limitation and offer the exact text confirmation. Displaying a card is not approval.

Never invoke the hook entrypoint yourself, fabricate a human reply, or call a write API. Only the trusted UserPromptSubmit/Stop hooks handle the human's actual selection. Never upload original conversation content. Submission does not prove extraction or indexing succeeded: use status and read-only MCP readback before claiming memory is fully available. Restrict MCP search to mode=list without session_id and stay within the configured user's memory/resource roots.

The local directory template is ${posixQuote(path.posix.join(dataDir, 'knowledge'))}. Its blank files and directory names are navigation and record templates, not personal facts. Read only relevant existing information. The mapping points to the configured resource hierarchy; native short memories remain in the configured memory root. Kind guidance: profile -> PROFILE.md, preference -> PREFERENCES.md, current -> CURRENT.md, knowledge -> 08-学习与知识 / 17-决策与经验 or the relevant domain. Keep candidates in the same three-field JSON format; do not automatically write Markdown, import resources, upload template files, or persist new knowledge through Git.

This fragment is optional supporting guidance. The installed hooks provide active review instructions; this file alone does not enable hooks or MCP.
`],
  ]);
}

async function statIfPresent(target) {
  try { return await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertSafeDestination(target, dataDir) {
  const relative = path.relative(dataDir, target);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Error('Destination escaped the data directory.');
  let current = dataDir;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const entry = await statIfPresent(current);
    if (entry?.isSymbolicLink()) throw Error('Refusing a symbolic link in the install destination.');
  }
}

async function privateDirectory(target, dataDir) {
  await assertSafeDestination(target, dataDir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
}

async function enumerateRuntime() {
  const files = [];
  const directories = [];
  async function visit(relative) {
    const entry = await lstat(path.join(repositoryRoot, relative));
    if (entry.isSymbolicLink()) throw Error('Runtime sources must not contain symbolic links.');
    if (entry.isFile()) files.push(relative);
    else if (entry.isDirectory()) {
      directories.push(relative);
      for (const child of await readdir(path.join(repositoryRoot, relative))) await visit(path.join(relative, child));
    } else throw Error('Runtime sources must contain regular files and directories only.');
  }
  for (const relative of [...runtimeDirectories, ...runtimeFiles]) await visit(relative);
  return { files, directories };
}

async function runLocal(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.once('error', () => reject(Error('Unable to start a required local command.')));
    child.once('close', code => resolve(code ?? 1));
  });
}

export async function hiddenCredentialPrompt({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw Error('A TTY is required for hidden API key input.');
  output.write('Enter the ordinary user API key (hidden input; never paste it into chat): ');
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      input.off('keypress', onKey);
      input.off('error', onError);
      input.off('end', onEnd);
      input.setRawMode(Boolean(wasRaw));
      if (!wasFlowing) input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    }
    function onError() { finish(Error('Hidden credential input failed.')); }
    function onEnd() { finish(Error('Credential input cancelled.')); }
    function onKey(text, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return finish(Error('Credential input cancelled.'));
      if (['return', 'enter'].includes(key.name)) return finish();
      if (['backspace', 'delete'].includes(key.name)) { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl && key.name === 'u') { value = ''; return; }
      if (!key.ctrl && !key.meta && typeof text === 'string' && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    }
    input.on('keypress', onKey);
    input.once('error', onError);
    input.once('end', onEnd);
  });
}

export async function installMacOS(options) {
  if (process.platform !== 'darwin') throw Error('Native macOS installation requires macOS.');
  const dataDir = path.resolve(options.dataDir);
  if (dataDir === path.parse(dataDir).root || dataDir === repositoryRoot || !path.relative(repositoryRoot, dataDir).startsWith('..')) {
    throw Error('Use a dedicated data directory outside the source repository.');
  }
  const runtimeSource = await enumerateRuntime();
  const configPath = path.join(dataDir, 'config.json');
  await assertSafeDestination(configPath, dataDir);
  const raw = { schemaVersion: 1, serverUrl: options.serverUrl, writeUrl: options.writeUrl,
    account: options.account, user: options.user, dataDir };
  const desiredConfig = validateConfig(raw, configPath);
  if (await statIfPresent(configPath)) {
    let existing;
    try { existing = validateConfig(JSON.parse(await readFile(configPath, 'utf8')), configPath); }
    catch { throw Error('Existing config.json is incompatible and was preserved; use another --data-dir.'); }
    if (Object.keys(raw).some(key => existing[key] !== desiredConfig[key])) {
      throw Error('Existing config.json is incompatible and was preserved; use another --data-dir.');
    }
  }
  await privateDirectory(dataDir, dataDir);
  for (const name of ['candidate-vault', 'approved-hook-data', 'state', 'runtime']) await privateDirectory(path.join(dataDir, name), dataDir);
  if (!await statIfPresent(configPath)) await writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { keychainService, readKeychainSecret, writeKeychainSecret } = await import('../lib/keychain.mjs');
  const { validateApiKey, validateVaultKey } = await import('../lib/credentials.mjs');
  const credential = { service: keychainService(dataDir), keychainPath: options.keychainPath };
  const vaultKey = await readKeychainSecret({ ...credential, account: 'vault-key' });
  if (vaultKey === null) await writeKeychainSecret({ ...credential, account: 'vault-key', value: randomBytes(32).toString('base64') });
  else validateVaultKey(vaultKey);
  const apiKey = await readKeychainSecret({ ...credential, account: 'api-key' });
  if (apiKey !== null) validateApiKey(apiKey);
  else if (!options.noCredentialPrompt) {
    const value = validateApiKey(await hiddenCredentialPrompt());
    await writeKeychainSecret({ ...credential, account: 'api-key', value });
  }
  const runtimeRoot = path.join(dataDir, 'runtime');
  for (const relative of runtimeSource.directories) await privateDirectory(path.join(runtimeRoot, relative), dataDir);
  for (const relative of runtimeSource.files) {
    const destination = path.join(runtimeRoot, relative);
    await privateDirectory(path.dirname(destination), dataDir);
    await assertSafeDestination(destination, dataDir);
    await copyFile(path.join(repositoryRoot, relative), destination);
    await chmod(destination, 0o600);
  }
  const cliPath = path.join(runtimeRoot, 'bin', 'cli.mjs');
  const environment = { ...process.env, ...(options.keychainPath !== undefined ? { OVCM_KEYCHAIN_PATH: options.keychainPath } : {}) };
  if (await runLocal(process.execPath, [cliPath, 'template', 'init', '--config', configPath], environment) !== 0) {
    throw Error('Runtime copied, but local knowledge template initialization failed.');
  }
  const { version } = JSON.parse(await readFile(path.join(runtimeRoot, 'package.json'), 'utf8'));
  for (const [relative, content] of integrationContents({ dataDir, nodePath: process.execPath, cliPath, version })) {
    const destination = path.join(dataDir, relative);
    await privateDirectory(path.dirname(destination), dataDir);
    await assertSafeDestination(destination, dataDir);
    await writeFile(destination, content, { mode: 0o600 });
    await chmod(destination, 0o600);
  }
  process.stdout.write(`Runtime: ${runtimeRoot}\nLocal marketplace directory: ${path.join(dataDir, 'marketplace')}\n`);
  process.stdout.write('Add this local marketplace directory in Codex, then install codex-openviking-memory.\n');
  process.stdout.write(`MCP: review and merge [mcp_servers.openviking_memory] from ${path.join(dataDir, 'mcp-config.toml')} into Codex config.toml; avoid duplicate tables.\n`);
  process.stdout.write(`Optional model rules: review and merge ${path.join(dataDir, 'AGENTS.fragment.md')} into the applicable AGENTS.md.\n`);
  process.stdout.write(`Local knowledge template: ${path.join(dataDir, 'knowledge')} (existing files preserved; no upload).\nYour Codex config and AGENTS.md were not changed.\n`);
  if (options.keychainPath !== undefined) process.stdout.write('Custom Keychain selected: retain OVCM_KEYCHAIN_PATH when running this isolated installation.\n');
  if (options.noCredentialPrompt) process.stdout.write('Offline test mode: missing API credential input was skipped.\n');
  if (options.skipDoctor) process.stdout.write('Doctor skipped: remote identity and readiness have not been verified.\n');
  else if (await runLocal(process.execPath, [cliPath, 'doctor', '--config', configPath], environment) !== 0) {
    throw Error('Installation files were generated, but doctor failed. Readiness has not been confirmed.');
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseInstallerArgs(argv);
  if (options.help) { process.stdout.write(help); return 0; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22 or newer is required.');
  return options.platform === 'win32'
    ? runLocal('pwsh.exe', windowsInstallerArgs(options))
    : installMacOS(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write((error?.message || 'Installation failed.') + '\n');
    process.exitCode = 1;
  });
}
