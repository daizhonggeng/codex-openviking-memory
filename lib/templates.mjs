import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

const MANIFEST = 'template-manifest.json';
const CORE_FILES = { profile: 'PROFILE.md', preference: 'PREFERENCES.md', current: 'CURRENT.md' };
const identifier = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const noFollow = constants.O_NOFOLLOW ?? 0;

function absolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value) ||
      value.split(/[\\/]/u).some(part => part === '.' || part === '..')) throw Error('Template paths must be absolute without traversal');
  return resolve(value);
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || isAbsolute(value)) throw Error('Invalid template manifest path');
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part.startsWith('.') || /[\u0000-\u0020\u007f<>:"\\|?*%#]/u.test(part) || part.endsWith('.') ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part)) throw Error('Invalid template manifest path');
  }
  return value;
}

async function statOrMissing(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// 检查每一级现有目录；不通过 realpath 静默跟随符号链接或 Windows junction。
async function checkDirectories(path, { allowMissing = false, create = false } = {}) {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    let stat = await statOrMissing(current);
    if (!stat && create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await statOrMissing(current);
    }
    if (!stat) {
      if (allowMissing) return;
      throw Error('Template directory does not exist');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Template directory conflicts with a file or symbolic link');
  }
}

async function checkedFile(path) {
  await checkDirectories(dirname(path));
  const stat = await statOrMissing(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw Error('Template source must contain regular files only');
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    if (!(await handle.stat()).isFile()) throw Error('Template source must contain regular files only');
    return await handle.readFile();
  } finally { await handle.close(); }
}

function validateManifest(raw) {
  const fields = ['schemaVersion', 'templateVersion', 'coreFiles', 'directories', 'files'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length ||
      Object.keys(raw).some(key => !fields.includes(key)) || raw.schemaVersion !== 1 ||
      typeof raw.templateVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(raw.templateVersion) ||
      !raw.coreFiles || typeof raw.coreFiles !== 'object' || Array.isArray(raw.coreFiles) ||
      Object.keys(raw.coreFiles).length !== 3 || Object.entries(CORE_FILES).some(([kind, file]) => raw.coreFiles[kind] !== file) ||
      !Array.isArray(raw.directories) || !raw.directories.length || raw.directories.length > 256 ||
      !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 512) throw Error('Invalid template manifest');
  const directories = raw.directories.map(safeRelative);
  const files = raw.files.map(safeRelative);
  const all = [...directories, ...files];
  if (new Set(all.map(path => path.toLowerCase())).size !== all.length || files.some(path => !path.endsWith('.md')) ||
      Object.values(CORE_FILES).some(path => !files.includes(path))) throw Error('Invalid template manifest entries');
  const directorySet = new Set(directories);
  for (const path of all) {
    const segments = path.split('/');
    while (segments.length > 1) {
      segments.pop();
      if (!directorySet.has(segments.join('/'))) throw Error('Template manifest is missing a parent directory');
    }
  }
  return { schemaVersion: 1, templateVersion: raw.templateVersion, coreFiles: { ...CORE_FILES }, directories, files };
}

async function loadTemplate(source, { contents = false } = {}) {
  const root = absolutePath(source);
  await checkDirectories(root);
  let raw;
  try { raw = JSON.parse((await checkedFile(join(root, MANIFEST))).toString('utf8')); }
  catch { throw Error('Template manifest is missing, unsafe, or invalid'); }
  const manifest = validateManifest(raw);
  for (const directory of manifest.directories) await checkDirectories(join(root, ...directory.split('/')));
  const files = new Map();
  for (const file of manifest.files) {
    const buffer = await checkedFile(join(root, ...file.split('/')));
    if (contents) files.set(file, buffer);
  }
  return { root, manifest, files };
}

function separateRoots(source, destination) {
  const related = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'));
  };
  if (related(source, destination) || related(destination, source)) throw Error('Template source and destination must be separate directories');
}

async function destinationFile(path) {
  await checkDirectories(dirname(path), { allowMissing: true });
  const stat = await statOrMissing(path);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw Error('Template destination conflicts with a non-file or symbolic link');
  return stat;
}

export async function initializeTemplate({ source, destination }) {
  const target = absolutePath(destination);
  const { root, manifest, files } = await loadTemplate(source, { contents: true });
  separateRoots(root, target);
  // 先核对全部冲突，再创建目录或文件；已有常规文件始终保留。
  await checkDirectories(target, { allowMissing: true });
  for (const directory of manifest.directories) await checkDirectories(join(target, ...directory.split('/')), { allowMissing: true });
  for (const file of manifest.files) await destinationFile(join(target, ...file.split('/')));
  await checkDirectories(target, { create: true });
  for (const directory of manifest.directories) await checkDirectories(join(target, ...directory.split('/')), { create: true });
  const created = [];
  const skipped = [];
  for (const [file, content] of files) {
    const path = join(target, ...file.split('/'));
    if (await destinationFile(path)) { skipped.push(file); continue; }
    let handle;
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await destinationFile(path);
      skipped.push(file);
      continue;
    }
    const identity = await handle.stat();
    try { await handle.writeFile(content); }
    catch (error) {
      await handle.close();
      handle = null;
      const current = await statOrMissing(path);
      if (current?.isFile() && !current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev) await unlink(path);
      throw error;
    } finally { if (handle) await handle.close(); }
    created.push(file);
  }
  return { created, skipped, destination: target };
}

export async function templateMap({ source, destination, resourceRoot, memoryRoot }) {
  const localRoot = absolutePath(destination);
  const { root, manifest } = await loadTemplate(source);
  separateRoots(root, localRoot);
  const resourceMatch = typeof resourceRoot === 'string' && new RegExp(`^viking://user/(${identifier})/resources/personal-context/$`, 'u').exec(resourceRoot);
  if (!resourceMatch || memoryRoot !== `viking://user/${resourceMatch[1]}/memories/`) throw Error('Template mapping requires matching configured knowledge roots');
  const mapping = relativePath => ({ relativePath, localPath: join(localRoot, ...relativePath.split('/')), resourceUri: resourceRoot + relativePath });
  return {
    templateVersion: manifest.templateVersion,
    localRoot,
    resourceRoot,
    memoryRoot,
    coreFiles: Object.fromEntries(Object.entries(CORE_FILES).map(([kind, file]) => [kind, mapping(file)])),
    directories: manifest.directories.map(path => ({ ...mapping(path), resourceUri: resourceRoot + path + '/' })),
    files: manifest.files.map(mapping),
  };
}
