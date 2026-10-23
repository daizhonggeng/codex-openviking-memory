import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isAbsolute, resolve} from 'node:path';

const servicePattern = /^com\.codex-openviking-memory\.[a-f0-9]{32}$/;
const accounts = new Set(['api-key', 'vault-key']);
const nativeError = () => Error('macOS Keychain could not be accessed; unlock it and rerun as the same OS user');
const controls = /[\x00-\x1f\x7f]/;

export function keychainService(dataDir) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || controls.test(dataDir)) throw Error('Keychain data directory must be an absolute path');
  return 'com.codex-openviking-memory.' + createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 32);
}

function validateTarget({service, account, keychainPath}) {
  if (typeof service !== 'string' || !servicePattern.test(service) || !accounts.has(account)) throw Error('Invalid application Keychain target');
  if (keychainPath !== undefined && (typeof keychainPath !== 'string' || !isAbsolute(keychainPath) || controls.test(keychainPath))) throw Error('Keychain path must be absolute');
}

// security's interactive parser treats quoted backslash escapes literally. No
// shell is involved. Keep the single command below its 4096-byte input buffer.
function quoted(value) { return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'; }

function nativeEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|HOME|USER|LOGNAME|TMPDIR|LANG|LC_ALL|LC_CTYPE)$/i.test(name)));
}

export function createKeychainClient({platform = process.platform, spawnImpl = spawn} = {}) {
  async function execute(args, input = '') {
    if (platform !== 'darwin') throw Error('Native Keychain credentials require macOS');
    return new Promise((resolveRun, reject) => {
      let child;
      try { child = spawnImpl('/usr/bin/security', args, {env: nativeEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']}); }
      catch { reject(nativeError()); return; }
      let output = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolveRun(value);
      };
      const timer = setTimeout(() => { child.kill(); finish(nativeError()); }, 15000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output, 'utf8') > 16384) { child.kill(); finish(nativeError()); }
      });
      // Never expose native diagnostics: they can contain account metadata or
      // echo a failed command, including its stdin-supplied secret.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => finish(nativeError()));
      child.on('close', code => finish(null, {code, output}));
      child.stdin.end(input);
    });
  }

  return {
    async readKeychainSecret(target) {
      validateTarget(target);
      const {service, account, keychainPath} = target;
      const result = await execute(['find-generic-password', '-s', service, '-a', account, '-w', ...(keychainPath ? [keychainPath] : [])]);
      // security exits with errSecItemNotFound (-25300 modulo 256).
      if (result.code === 44) return null;
      if (result.code !== 0) throw nativeError();
      return result.output.endsWith('\n') ? result.output.slice(0, -1) : result.output;
    },

    async writeKeychainSecret(target) {
      validateTarget(target);
      const {service, account, value, keychainPath} = target;
      // security -w prints non-printable password bytes as hex. Both supported
      // credential formats are printable ASCII, so reject other values rather
      // than later decoding the wrong secret.
      if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value)) throw Error('Keychain secret must be a nonempty printable ASCII value');
      const args = ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value, '-T', '/usr/bin/security', ...(keychainPath ? [keychainPath] : [])];
      const input = args.map(quoted).join(' ') + '\n';
      if (Buffer.byteLength(input, 'utf8') >= 4095) throw Error('Keychain secret or target exceeds the native input limit');
      // The secret is sent only through the pipe, never process argv or env.
      const result = await execute(['-i'], input);
      if (result.code !== 0) throw nativeError();
    },

    async deleteKeychainSecret(target) {
      validateTarget(target);
      // Deletion exists for explicit isolated native tests, never the default
      // login keychain or ordinary runtime credential loading.
      if (!target.keychainPath) throw Error('Keychain deletion requires an explicit isolated keychain path');
      const result = await execute(['delete-generic-password', '-s', target.service, '-a', target.account, target.keychainPath]);
      if (result.code === 44) return false;
      if (result.code !== 0) throw nativeError();
      return true;
    },
  };
}

const nativeClient = createKeychainClient();
export const readKeychainSecret = target => nativeClient.readKeychainSecret(target);
export const writeKeychainSecret = target => nativeClient.writeKeychainSecret(target);
export const deleteKeychainSecret = target => nativeClient.deleteKeychainSecret(target);
