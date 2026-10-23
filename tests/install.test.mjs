import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const installerSource = path.join(repositoryRoot, 'scripts', 'install.ps1');
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows DPAPI installer smoke test' : false };

function createTemporaryRoot(t) {
  const temporaryRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ovcm installer ')));
  t.after(() => {
    const resolvedTarget = realpathSync.native(temporaryRoot);
    const resolvedTemp = realpathSync.native(os.tmpdir());
    assert.equal(path.dirname(resolvedTarget).toLowerCase(), resolvedTemp.toLowerCase());
    assert.ok(path.basename(resolvedTarget).startsWith('ovcm installer '));
    rmSync(resolvedTarget, { recursive: true, force: true });
  });
  return temporaryRoot;
}

function isolatedEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra };
  for (const name of ['OVCM_API_KEY', 'OVCM_VAULT_KEY', 'OVCM_CONFIG']) delete environment[name];
  return environment;
}

function createFixture(t) {
  const temporaryRoot = createTemporaryRoot(t);
  const sourceRoot = path.join(temporaryRoot, 'source with spaces');
  const dataDir = path.join(temporaryRoot, 'data with spaces %OVCM_INSTALLER_LITERAL%');
  for (const relative of ['scripts', 'bin', 'lib', 'vendor/upstream', 'templates/personal-context', 'secrets', 'tests']) {
    mkdirSync(path.join(sourceRoot, relative), { recursive: true });
  }
  copyFileSync(installerSource, path.join(sourceRoot, 'scripts', 'install.ps1'));
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"type":"module","version":"0.1.0"}\n');
  writeFileSync(path.join(sourceRoot, 'LICENSE'), 'fixture license\n');
  writeFileSync(path.join(sourceRoot, 'NOTICE'), 'fixture notice\n');
  writeFileSync(path.join(sourceRoot, 'lib', 'marker.mjs'), 'export const marker = true;\n');
  writeFileSync(path.join(sourceRoot, 'vendor', 'upstream', 'marker.txt'), 'fixture upstream\n');
  writeFileSync(path.join(sourceRoot, 'secrets', 'must-not-copy'), 'not a real credential\n');
  writeFileSync(path.join(sourceRoot, 'tests', 'must-not-copy'), 'fixture test\n');
  writeFileSync(path.join(sourceRoot, 'bin', 'cli.mjs'), `
import { writeFileSync } from 'node:fs';
const config = process.argv[process.argv.indexOf('--config') + 1];
if (process.argv[2] === 'doctor') throw new Error('Offline installer must not invoke doctor');
if (process.argv[2] === 'hook') process.stdout.write(JSON.stringify({ event: process.argv[3], config }));
if (process.argv[2] === 'template') process.stdout.write(JSON.stringify({ created: [], skipped: [], destination: 'fixture-knowledge' }));
`);
  return { temporaryRoot, sourceRoot, dataDir, installer: path.join(sourceRoot, 'scripts', 'install.ps1') };
}

function runInstaller(fixture, extra = []) {
  const parameters = [
    '-ServerUrl', 'https://memory.example.com', '-Account', 'test-account', '-User', 'test-user',
    '-DataDir', fixture.dataDir, '-NoCredentialPrompt', '-SkipDoctor',
  ];
  for (let index = 0; index < extra.length; index += 2) {
    const existing = parameters.indexOf(extra[index]);
    if (existing >= 0) parameters.splice(existing, 2, extra[index], extra[index + 1]);
    else parameters.push(extra[index], extra[index + 1]);
  }
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture.installer, ...parameters],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: isolatedEnvironment() });
}

function assertSucceeded(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runPowerShell(script, env = {}) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true, env: isolatedEnvironment(env),
  });
  assertSucceeded(result);
  return result.stdout.trim();
}

test('Windows offline installer handles spaces, encrypts a fresh vault key, and generates isolated integration files', windowsOnly, (t) => {
  const fixture = createFixture(t);
  const result = runInstaller(fixture);
  assertSucceeded(result);
  const configPath = path.join(fixture.dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(config, {
    schemaVersion: 1, serverUrl: 'https://memory.example.com', writeUrl: 'https://memory.example.com',
    account: 'test-account', user: 'test-user', dataDir: fixture.dataDir,
  });
  assert.equal(existsSync(path.join(fixture.dataDir, 'secrets', 'api-key.dpapi')), false);
  assert.equal(existsSync(path.join(fixture.dataDir, 'state', 'readiness.json')), false);
  assert.equal(existsSync(path.join(fixture.dataDir, 'runtime', 'secrets')), false);
  assert.equal(existsSync(path.join(fixture.dataDir, 'runtime', 'tests')), false);
  assert.equal(readFileSync(path.join(fixture.dataDir, 'runtime', 'vendor', 'upstream', 'marker.txt'), 'utf8'), 'fixture upstream\n');
  assert.equal(readFileSync(path.join(fixture.dataDir, 'runtime', 'LICENSE'), 'utf8'), 'fixture license\n');
  const marketplaceRoot = path.join(fixture.dataDir, 'marketplace');
  const marketplace = JSON.parse(readFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.plugins[0].source.path, './plugins/codex-openviking-memory');
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'codex-openviking-memory');
  const plugin = JSON.parse(readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.hooks, './hooks/hooks.json');
  const { hooks } = JSON.parse(readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks), ['UserPromptSubmit', 'Stop']);
  for (const event of Object.keys(hooks)) {
    const command = hooks[event][0].hooks[0].command;
    assert.match(command, /^pwsh\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    const decoded=Buffer.from(command.split(' ').at(-1),'base64').toString('utf16le');
    assert.ok(decoded.includes(`--config '${configPath.replaceAll("'","''")}'`));
    // A same-named environment variable must not expand inside the literal data path.
    const invoked = spawnSync(command, { shell: true, encoding: 'utf8', input:'{"fixture":"中文输入"}', timeout: 10_000, windowsHide: true, env:isolatedEnvironment({OVCM_INSTALLER_LITERAL:'UNEXPECTED-EXPANSION'}) });
    assertSucceeded(invoked);
    assert.deepEqual(JSON.parse(invoked.stdout), { event, config: configPath });
  }
  const mcp = readFileSync(path.join(fixture.dataDir, 'mcp-config.toml'), 'utf8');
  assert.match(mcp, /^\[mcp_servers\.openviking_memory\]/);
  assert.ok(mcp.includes(JSON.stringify(configPath)));
  assert.match(mcp, /"mcp", "--config"/);
  const fragment = readFileSync(path.join(fixture.dataDir, 'AGENTS.fragment.md'), 'utf8');
  assert.match(fragment, /current-human-statement/);
  assert.match(fragment, /request_user_input_async confirmation card/);
  assert.match(fragment, /choices exactly "save candidate <REAL_ID>" and "Not now"/);
  assert.match(fragment, /Never invoke the hook entrypoint yourself/);
  assert.match(fragment, /^    & '.+node\.exe' '.+cli\.mjs' propose --config '.+' --input /m);
  assert.match(fragment, /does not prove extraction or indexing succeeded/);
  assert.ok(result.stdout.includes(marketplaceRoot));
  assert.match(result.stdout, /Doctor skipped/);
  const vaultCheck = JSON.parse(runPowerShell(`
$ErrorActionPreference = 'Stop'
$secretPath = Join-Path $env:OVCM_TEST_DATA 'secrets/vault-key.dpapi'
$cipher = [Convert]::FromBase64String([IO.File]::ReadAllText($secretPath))
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$text = [Text.Encoding]::UTF8.GetString($plain)
$dirAcl = Get-Acl -LiteralPath (Split-Path -Parent $secretPath)
$fileAcl = Get-Acl -LiteralPath $secretPath
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
$sids = @($fileAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
@{ length = [Convert]::FromBase64String($text).Length; directoryProtected = $dirAcl.AreAccessRulesProtected; fileProtected = $fileAcl.AreAccessRulesProtected; unexpectedSid = @($sids | Where-Object { $_ -notin $allowed }).Count } | ConvertTo-Json -Compress
[Array]::Clear($plain, 0, $plain.Length)
`, { OVCM_TEST_DATA: fixture.dataDir }));
  assert.deepEqual(vaultCheck, { length: 32, directoryProtected: true, fileProtected: true, unexpectedSid: 0 });
});

test('Windows reinstall preserves config, DPAPI keys, candidates, and readiness; incompatible config is rejected', windowsOnly, (t) => {
  const fixture = createFixture(t);
  assertSucceeded(runInstaller(fixture));
  const configPath = path.join(fixture.dataDir, 'config.json');
  const vaultPath = path.join(fixture.dataDir, 'secrets', 'vault-key.dpapi');
  runPowerShell(`
$dummy = [Text.Encoding]::UTF8.GetBytes('isolated-test-only-dummy-key')
$cipher = [Security.Cryptography.ProtectedData]::Protect($dummy, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText((Join-Path $env:OVCM_TEST_DATA 'secrets/api-key.dpapi'), [Convert]::ToBase64String($cipher))
`, { OVCM_TEST_DATA: fixture.dataDir });
  const apiPath = path.join(fixture.dataDir, 'secrets', 'api-key.dpapi');
  const candidatePath = path.join(fixture.dataDir, 'candidate-vault', 'retained.candidate');
  const readinessPath = path.join(fixture.dataDir, 'state', 'readiness.json');
  writeFileSync(candidatePath, 'isolated encrypted candidate fixture');
  writeFileSync(readinessPath, '{"fixture":true}\n');
  const tracked = [configPath, vaultPath, apiPath, candidatePath, readinessPath];
  const hash = (target) => createHash('sha256').update(readFileSync(target)).digest('hex');
  const before = tracked.map(hash);
  assertSucceeded(runInstaller(fixture));
  assert.deepEqual(tracked.map(hash), before);
  const incompatible = runInstaller(fixture, ['-User', 'different-user']);
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /incompatible/);
  assert.deepEqual(tracked.map(hash), before);
});

test('Windows installer rejects unsafe endpoints and in-repository state before creating files', windowsOnly, (t) => {
  const fixture = createFixture(t);
  for (const endpoint of ['http://memory.example.com', 'http://127.0.0.2', 'https://memory.example.com/private', 'https://user:secret@memory.example.com', 'https://memory.example.com?x=1', 'https://memory.example.com?', 'https://memory.example.com#', ' https://memory.example.com']) {
    const result = runInstaller(fixture, ['-ServerUrl', endpoint]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(fixture.dataDir), false);
  }
  const result = runInstaller(fixture, ['-DataDir', path.join(fixture.sourceRoot, 'state')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source repository/);
  assert.equal(existsSync(path.join(fixture.sourceRoot, 'state')), false);
});

test('Windows reinstall accepts an existing schema1 config with its optional writeUrl omitted',windowsOnly,t=>{
  const fixture=createFixture(t);assertSucceeded(runInstaller(fixture));
  const configPath=path.join(fixture.dataDir,'config.json');
  const config=JSON.parse(readFileSync(configPath,'utf8'));delete config.writeUrl;
  const preserved=JSON.stringify(config,null,2)+'\n';writeFileSync(configPath,preserved);
  const vaultPath=path.join(fixture.dataDir,'secrets','vault-key.dpapi');
  const vaultBefore=readFileSync(vaultPath,'utf8');
  assertSucceeded(runInstaller(fixture));
  assert.equal(readFileSync(configPath,'utf8'),preserved);
  assert.equal(readFileSync(vaultPath,'utf8'),vaultBefore);
});

test('Windows actual runtime install runs the generated PowerShell propose command with its DPAPI vault', windowsOnly, (t) => {
  const temporaryRoot = createTemporaryRoot(t);
  const dataDir = path.join(temporaryRoot, "actual runtime data with spaces and 'quote'");
  assertSucceeded(runInstaller({ installer: installerSource, dataDir }));
  for (const name of ['PROFILE.md','PREFERENCES.md','CURRENT.md','90-模板/通用记录.md','99-归档/README.md']) {
    assert.equal(existsSync(path.join(dataDir,'knowledge',name)),true);
  }
  const preservedProfile=path.join(dataDir,'knowledge','PROFILE.md');
  writeFileSync(preservedProfile,'Synthetic user-edited template; preserve this file.\n');
  assertSucceeded(runInstaller({ installer: installerSource, dataDir }));
  assert.equal(readFileSync(preservedProfile,'utf8'),'Synthetic user-edited template; preserve this file.\n');
  const inputPath = path.join(temporaryRoot, "synthetic candidate's input.json");
  const summary = 'Synthetic offline installer smoke-test candidate; this is not a personal fact.';
  writeFileSync(inputPath, JSON.stringify({ summary, kind: 'knowledge', source: 'current-human-statement' }));
  const fragment = readFileSync(path.join(dataDir, 'AGENTS.fragment.md'), 'utf8');
  const command = fragment.match(/^    (& .+ propose .+)$/m)?.[1];
  assert.ok(command, 'The generated fragment must contain a PowerShell command with its call operator');
  const candidate = JSON.parse(runPowerShell(command.replace('"<absolute-candidate-json-path>"', `'${inputPath.replaceAll("'", "''")}'`) + '\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));
  assert.match(candidate.id, /^[a-f0-9]{16}$/);
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.kind, 'knowledge');
  const encryptedCandidate = readFileSync(path.join(dataDir, 'candidate-vault', candidate.id + '.bin'), 'utf8');
  assert.equal(encryptedCandidate.includes(summary), false);
  assert.equal(existsSync(path.join(dataDir, 'secrets', 'api-key.dpapi')), false);
  assert.equal(existsSync(path.join(dataDir, 'state', 'readiness.json')), false);
  const result = spawnSync(process.execPath, [path.join(dataDir, 'runtime', 'bin', 'cli.mjs'),
    'status', '--config', path.join(dataDir, 'config.json'), '--id', candidate.id], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true, env: isolatedEnvironment(),
  });
  assertSucceeded(result);
  const status = JSON.parse(result.stdout);
  assert.equal(status.id, candidate.id);
  assert.equal(status.status, 'pending');
  assert.equal(result.stdout.includes(summary), false);
});
