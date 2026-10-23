import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTemplate, templateMap } from '../lib/templates.mjs';

const SOURCE = await realpath(fileURLToPath(new URL('../templates/personal-context', import.meta.url)));
const RESOURCE = 'viking://user/example-user/resources/personal-context/';
const MEMORY = 'viking://user/example-user/memories/';
const manifestName = 'template-manifest.json';
const baseManifest = () => ({
  schemaVersion: 1,
  templateVersion: '0.2.0',
  coreFiles: { profile: 'PROFILE.md', preference: 'PREFERENCES.md', current: 'CURRENT.md' },
  directories: ['00-收件箱', '00-收件箱/待确认'],
  files: ['PROFILE.md', 'PREFERENCES.md', 'CURRENT.md', '00-收件箱/待确认/README.md'],
});

async function fixture(t) {
  // macOS 的 /tmp、/var 可能是系统符号链接，先选取明确的真实测试根目录。
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ovcm-templates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'knowledge');
  const manifest = baseManifest();
  await mkdir(source);
  for (const directory of manifest.directories) await mkdir(join(source, ...directory.split('/')), { recursive: true });
  for (const file of manifest.files) await writeFile(join(source, ...file.split('/')), `# Empty template: ${file}\n`);
  await writeFile(join(source, manifestName), JSON.stringify(manifest));
  return { root, source, destination, manifest };
}

async function allFiles(root, path = '') {
  const files = [];
  for (const item of await readdir(join(root, path), { withFileTypes: true })) {
    const local = path ? `${path}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await allFiles(root, local));
    else files.push(local);
  }
  return files.sort();
}

test('initialization creates only allowlisted templates and scaffolds empty directories', async t => {
  const { source, destination, manifest } = await fixture(t);
  manifest.directories.push('99-归档');
  await mkdir(join(source, '99-归档'));
  await writeFile(join(source, manifestName), JSON.stringify(manifest));
  await writeFile(join(source, 'not-allowlisted.txt'), 'Do not copy unrelated source files.');
  const result = await initializeTemplate({ source, destination });
  assert.equal(result.destination, destination);
  assert.deepEqual(result.created, manifest.files);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(await allFiles(destination), [...manifest.files].sort());
  assert((await lstat(join(destination, '99-归档'))).isDirectory());
  assert.equal(await readFile(join(destination, 'PROFILE.md'), 'utf8'), '# Empty template: PROFILE.md\n');
});

test('existing user edits and unrelated files survive initial and repeated initialization', async t => {
  const { source, destination, manifest } = await fixture(t);
  await mkdir(join(destination, '00-收件箱', '待确认'), { recursive: true });
  await writeFile(join(destination, 'PROFILE.md'), 'An existing user-maintained file.\n');
  await writeFile(join(destination, '00-收件箱', '待确认', 'README.md'), 'Existing navigation.\n');
  await writeFile(join(destination, 'unrelated.txt'), 'Unrelated user work.\n');
  const first = await initializeTemplate({ source, destination });
  assert.deepEqual(first.skipped, ['PROFILE.md', '00-收件箱/待确认/README.md']);
  assert.deepEqual(first.created, ['PREFERENCES.md', 'CURRENT.md']);
  const second = await initializeTemplate({ source, destination });
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skipped, manifest.files);
  assert.equal(await readFile(join(destination, 'PROFILE.md'), 'utf8'), 'An existing user-maintained file.\n');
  assert.equal(await readFile(join(destination, '00-收件箱', '待确认', 'README.md'), 'utf8'), 'Existing navigation.\n');
  assert.equal(await readFile(join(destination, 'unrelated.txt'), 'utf8'), 'Unrelated user work.\n');
});

test('directory and file conflicts fail preflight without copying other files', async t => {
  for (const conflict of ['directory-as-file', 'file-as-directory']) {
    const { source, destination } = await fixture(t);
    await mkdir(destination);
    if (conflict === 'directory-as-file') await mkdir(join(destination, 'CURRENT.md'));
    else await writeFile(join(destination, '00-收件箱'), 'Existing regular file.');
    await assert.rejects(initializeTemplate({ source, destination }), /conflict/u);
    assert.deepEqual((await readdir(destination)).sort(), [conflict === 'directory-as-file' ? 'CURRENT.md' : '00-收件箱']);
  }
});

test('rejects unsafe manifest paths, aliases, duplicate entries, unknown fields, and missing parents', async t => {
  const { source, destination } = await fixture(t);
  const patches = [
    manifest => { manifest.files.push('../escape.md'); },
    manifest => { manifest.files.push('/escape.md'); },
    manifest => { manifest.files.push('C:/escape.md'); },
    manifest => { manifest.files.push('00-收件箱\\escape.md'); },
    manifest => { manifest.files.push('00-收件箱/./escape.md'); },
    manifest => { manifest.files.push('00-收件箱/%2e%2e.md'); },
    manifest => { manifest.files.push('00-收件箱/escape?.md'); },
    manifest => { manifest.files.push('00-收件箱/escape\u0000.md'); },
    manifest => { manifest.files.push('00-收件箱/CON.md'); },
    manifest => { manifest.files.push('.private.md'); },
    manifest => { manifest.files.push('credentials.json'); },
    manifest => { manifest.files.push('profile.md'); },
    manifest => { manifest.directories.push('PROFILE.md'); },
    manifest => { manifest.directories.push('missing/child'); },
    manifest => { manifest.files.push('missing/README.md'); },
    manifest => { manifest.coreFiles.profile = 'other.md'; },
    manifest => { manifest.extra = true; },
    manifest => { manifest.templateVersion = 'not-a-version'; },
  ];
  for (const patch of patches) {
    const manifest = baseManifest();
    patch(manifest);
    await writeFile(join(source, manifestName), JSON.stringify(manifest));
    await assert.rejects(initializeTemplate({ source, destination }), /manifest/u);
  }
  assert.deepEqual(await readdir(dirname(destination)), ['source']);
});

test('requires absolute independent roots and rejects lexical traversal', async t => {
  const { root, source, destination } = await fixture(t);
  for (const options of [
    { source: 'relative', destination }, { source, destination: 'relative' },
    { source, destination: source }, { source, destination: join(source, 'child') },
    { source, destination: root }, { source, destination: `${root}/child/../escaped` },
    { source: `${root}/child/../source`, destination },
  ]) await assert.rejects(initializeTemplate(options), /absolute|traversal|separate/u);
  assert.deepEqual(await readdir(root), ['source']);
});

test('source files and manifest must be regular files and are checked before destination creation', async t => {
  for (const file of ['CURRENT.md', manifestName]) {
    const { source, destination } = await fixture(t);
    await rm(join(source, file));
    await mkdir(join(source, file));
    await assert.rejects(initializeTemplate({ source, destination }), /regular files|manifest/u);
    await assert.rejects(lstat(destination), error => error.code === 'ENOENT');
  }
});

test('rejects source, destination, and ancestor directory symlinks or Windows junctions', async t => {
  for (const location of ['source-root', 'source-child', 'destination-root', 'destination-ancestor', 'destination-child']) {
    const { root, source, destination } = await fixture(t);
    const outside = join(root, 'outside');
    await mkdir(outside);
    let options = { source, destination };
    if (location === 'source-root') {
      const link = join(root, 'source-link');
      await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
      options.source = link;
    } else if (location === 'source-child') {
      await rm(join(source, '00-收件箱'), { recursive: true });
      await symlink(outside, join(source, '00-收件箱'), process.platform === 'win32' ? 'junction' : 'dir');
    } else if (location === 'destination-root' || location === 'destination-ancestor') {
      await symlink(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
      if (location === 'destination-ancestor') options.destination = join(destination, 'nested');
    } else {
      await mkdir(destination);
      await symlink(outside, join(destination, '00-收件箱'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    await assert.rejects(initializeTemplate(options), /symbolic link/u, location);
    assert.deepEqual(await readdir(outside), [], location);
  }
});

test('rejects file symlinks rather than reading or overwriting their target', async t => {
  const { root, source, destination } = await fixture(t);
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'Outside content must remain untouched.');
  await mkdir(destination);
  try { await symlink(outside, join(destination, 'PROFILE.md'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('File symlinks require Windows Developer Mode or privilege; junction checks run separately.');
      return;
    }
    throw error;
  }
  await assert.rejects(initializeTemplate({ source, destination }), /symbolic link/u);
  await rm(join(destination, 'PROFILE.md'));
  await rm(join(source, 'PROFILE.md'));
  await symlink(outside, join(source, 'PROFILE.md'), 'file');
  await assert.rejects(initializeTemplate({ source, destination }), /regular files/u);
  assert.equal(await readFile(outside, 'utf8'), 'Outside content must remain untouched.');
  assert.deepEqual(await readdir(destination), []);
});

test('mapping is deterministic, keeps native memories separate, and never creates or edits destination files', async t => {
  const { source, destination, manifest } = await fixture(t);
  const map = await templateMap({ source, destination, resourceRoot: RESOURCE, memoryRoot: MEMORY });
  assert.equal(map.templateVersion, '0.2.0');
  assert.equal(map.localRoot, destination);
  assert.equal(map.memoryRoot, MEMORY);
  assert.equal(map.resourceRoot, RESOURCE);
  assert.deepEqual(map.coreFiles.profile, { relativePath: 'PROFILE.md', localPath: join(destination, 'PROFILE.md'), resourceUri: RESOURCE + 'PROFILE.md' });
  assert.equal(map.coreFiles.preference.resourceUri, RESOURCE + 'PREFERENCES.md');
  assert.equal(map.coreFiles.current.resourceUri, RESOURCE + 'CURRENT.md');
  assert.deepEqual(map.directories.map(item => item.relativePath), manifest.directories);
  assert.equal(map.directories[1].resourceUri, RESOURCE + '00-收件箱/待确认/');
  assert.equal(map.files.length, manifest.files.length);
  assert(map.files.every(item => isAbsolute(item.localPath) && item.resourceUri.startsWith(RESOURCE) && !item.resourceUri.startsWith(MEMORY)));
  assert.deepEqual(map, await templateMap({ source, destination, resourceRoot: RESOURCE, memoryRoot: MEMORY }));
  await assert.rejects(lstat(destination), error => error.code === 'ENOENT');
  await mkdir(destination);
  await writeFile(join(destination, 'user.md'), 'Untouched.');
  await templateMap({ source, destination, resourceRoot: RESOURCE, memoryRoot: MEMORY });
  assert.deepEqual(await readdir(destination), ['user.md']);
});

test('mapping rejects mismatched users and malformed resource roots', async t => {
  const { source, destination } = await fixture(t);
  for (const roots of [
    { resourceRoot: RESOURCE, memoryRoot: 'viking://user/other/memories/' },
    { resourceRoot: 'viking://user/example-user/resources/', memoryRoot: MEMORY },
    { resourceRoot: RESOURCE + '../', memoryRoot: MEMORY },
    { resourceRoot: 'https://example.com/', memoryRoot: MEMORY },
    { resourceRoot: RESOURCE, memoryRoot: undefined },
  ]) await assert.rejects(templateMap({ source, destination, ...roots }), /matching configured knowledge roots/u);
});

test('published scaffold matches its manifest, contains all 20 generic sections and six blank record templates', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ovcm-scaffold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(join(SOURCE, manifestName), 'utf8'));
  const top = manifest.directories.filter(path => !path.includes('/'));
  assert.equal(top.length, 20);
  assert.deepEqual(top.map(path => path.slice(0, 2)), [...Array(18).keys()].map(index => String(index).padStart(2, '0')).concat(['90', '99']));
  assert.equal(manifest.files.filter(path => path.startsWith('90-模板/') && path !== '90-模板/README.md').length, 6);
  assert.deepEqual(manifest.files.filter(path => path.startsWith('90-模板/') && path !== '90-模板/README.md').sort(),
    ['通用记录.md', '项目.md', '决策.md', '人物.md', '日记与复盘.md', '服务与账号索引.md'].map(path => `90-模板/${path}`).sort());
  assert.deepEqual(await allFiles(SOURCE), [...manifest.files, manifestName].sort());
  for (const file of ['PROFILE.md', 'PREFERENCES.md', 'CURRENT.md']) {
    const text = await readFile(join(SOURCE, file), 'utf8');
    assert(text.includes('空白核心模板'));
    assert(!/^[-*]\s|\|/mu.test(text), 'core files contain no prefilled fact entries');
  }
  for (const file of manifest.files) {
    const text = await readFile(join(SOURCE, ...file.split('/')), 'utf8');
    assert(!/https?:\/\/|[A-Z]:\\Users\\|202\d-\d\d-\d\d|自动.{0,4}(?:Git|同步到Git)/iu.test(text), file);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = resolve(dirname(join(SOURCE, ...file.split('/'))), match[1]);
      assert(!relative(SOURCE, target).startsWith('..'), `${file}: link escaped source`);
      assert((await lstat(target)).isFile(), `${file}: missing navigation link`);
    }
  }
  const result = await initializeTemplate({ source: SOURCE, destination: join(root, 'knowledge') });
  assert.equal(result.created.length, manifest.files.length);
  const map = await templateMap({ source: SOURCE, destination: result.destination, resourceRoot: RESOURCE, memoryRoot: MEMORY });
  assert.equal(map.directories.length, manifest.directories.length);
});
