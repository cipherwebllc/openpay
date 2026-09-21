import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Internal only: wallet records contain a private key and must never become tool results.
export function walletDirectory(env = process.env) {
  if (env.OPENPAY_X402_HOME && !isAbsolute(env.OPENPAY_X402_HOME)) {
    throw walletError('wallet_home_not_absolute');
  }
  return env.OPENPAY_X402_HOME
    ? env.OPENPAY_X402_HOME
    : join(env.HOME || homedir(), '.openpay-x402');
}

function walletError(code, detail = '') {
  return Object.assign(new Error(`${code}${detail ? `: ${detail}` : ''}`), { code });
}

function preserveWalletError(code, path) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return walletError(code, `${path}; Do not delete this file. Move it aside under another name (for example: mv ${quote(path)} ${quote(`${path}.broken`)}). If you have ever funded this address, this file may be the only copy of the key.`);
}

function walletRecord(publicRecord, privateKey) {
  // Keep even accidental spreads/JSON serialization public-only; secret access must be explicit.
  return Object.defineProperty({ public: publicRecord }, 'secret', {
    value: { privateKey },
    enumerable: false,
  });
}

function checkPermissions(stats, path, directory) {
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    const quoted = `'${path.replaceAll("'", "'\\''")}'`;
    throw walletError(
      'wallet_permissions_unsafe',
      `${path}; fix manually with chmod ${directory ? '700' : '600'} ${quoted}`,
    );
  }
}

async function checkDirectory(directory) {
  let stats;
  try {
    stats = await fs.lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink()) throw walletError('wallet_dir_symlink');
  if (!stats.isDirectory()) throw walletError('wallet_dir_invalid');
  checkPermissions(stats, directory, true);
  return true;
}

function validateDocument(raw, path) {
  let document;
  let address;
  try {
    document = JSON.parse(raw);
    if (
      document === null || typeof document !== 'object' || Array.isArray(document) ||
      document.version !== 1 ||
      typeof document.privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(document.privateKey) ||
      typeof document.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(document.address) ||
      typeof document.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(document.createdAt))
    ) {
      throw new Error();
    }
    address = privateKeyToAccount(document.privateKey).address;
  } catch {
    // JSON/viem errors can embed the input key; never propagate their messages.
    throw preserveWalletError('wallet_corrupt', path);
  }
  if (address.toLowerCase() !== document.address.toLowerCase()) {
    throw preserveWalletError('wallet_address_mismatch', path);
  }
  return { version: 1, address, privateKey: document.privateKey, createdAt: document.createdAt };
}

function safeStorageError(error) {
  // Native filesystem errors may include attacker-controlled paths. Only our own errors leave this module.
  if (error instanceof Error && error.code?.startsWith('wallet_')) return error;
  const reason = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? error.code : 'UNKNOWN';
  return Object.assign(walletError('wallet_unavailable', `filesystem operation failed (${reason})`), { reason });
}

export async function loadWallet({ env = process.env } = {}) {
  const directory = walletDirectory(env);
  const path = join(directory, 'wallet.json');
  let handle;
  try {
    if (!await checkDirectory(directory)) return null;
    let stats;
    try {
      stats = await fs.lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) throw preserveWalletError('wallet_file_unsafe', path);
    checkPermissions(stats, path, false);
    // Reject file substitution between lstat and open, and avoid blocking on a substituted FIFO.
    try {
      handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ELOOP') throw preserveWalletError('wallet_file_unsafe', path);
      throw error;
    }
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stats.ino || opened.dev !== stats.dev) {
      throw preserveWalletError('wallet_file_unsafe', path);
    }
    checkPermissions(opened, path, false);
    if (!await checkDirectory(directory)) throw walletError('wallet_unavailable');
    const document = validateDocument(await handle.readFile('utf8'), path);
    return walletRecord({
      address: document.address,
      createdAt: document.createdAt,
      storage: { kind: 'file', path, permissionsChecked: process.platform !== 'win32' },
    }, document.privateKey);
  } catch (error) {
    throw safeStorageError(error);
  } finally {
    // A read-handle close failure must not replace a validation error or expose native error text.
    if (handle) await handle.close().catch(() => {});
  }
}

export async function createWallet({ env = process.env } = {}) {
  const options = { env };
  const directory = walletDirectory(env);
  const path = join(directory, 'wallet.json');
  try {
    const existing = await loadWallet(options);
    if (existing !== null) {
      existing.public.created = false;
      return existing;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await checkDirectory(directory);
    let privateKey = generatePrivateKey();
    let handle;
    let created = false;
    const temporary = `${path}.${randomUUID()}.tmp`;
    let ownsTemporary = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      ownsTemporary = true;
      await handle.writeFile(JSON.stringify({
        version: 1,
        address: privateKeyToAccount(privateKey).address,
        privateKey,
        createdAt: new Date().toISOString(),
      }), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        // link publishes complete bytes atomically and cannot replace an existing wallet.
        // Unsupported hard links fail closed: rename would permit overwriting a funded key.
        await fs.link(temporary, path);
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      await fs.unlink(temporary);
      ownsTemporary = false;
      // Windows cannot open a directory handle for fsync; the wallet is already published, so failing here
      // would report an error for a wallet that exists. POSIX keeps the dirent durable before returning.
      if (process.platform !== 'win32') {
        const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } finally {
      privateKey = null;
      // Cleanup must still run when writing, syncing, closing, or publishing fails.
      try {
        if (handle) await handle.close();
      } finally {
        if (ownsTemporary) await fs.unlink(temporary);
      }
    }
    // Never advertise a generated address until the stored key has been re-read and verified.
    const stored = await loadWallet(options);
    if (stored === null) throw walletError('wallet_unavailable');
    stored.public.created = created;
    return stored;
  } catch (error) {
    throw safeStorageError(error);
  }
}
