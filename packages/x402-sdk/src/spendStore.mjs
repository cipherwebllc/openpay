import { randomUUID } from 'node:crypto';

const RESERVATIONS_KEY = '__openpayReservations';
const LOCK_RETRY_COUNT = 40;
const LOCK_RETRY_MS = 25;
// A lock older than this cannot belong to a live holder: the retry loop above waits only
// LOCK_RETRY_COUNT * LOCK_RETRY_MS (1s) and every critical section is a small read plus an
// atomic replace, so a live process either finishes or dies far inside this window. Without the
// takeover a SIGKILL leaves spend.json.lock behind and every budgeted payment fails forever.
export const SPEND_LOCK_STALE_MS = 60_000;
const LOCK_ERROR_CODE = 'ESPENDLOCK';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error) {
  return isObject(error) && error.code === 'ENOENT';
}

function isLockHeld(error) {
  return isObject(error) && error.code === 'EEXIST';
}

function isAtomicString(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reservationsFrom(document) {
  return isObject(document[RESERVATIONS_KEY])
    ? document[RESERVATIONS_KEY]
    : {};
}

function reservationMatches(existing, reservation) {
  return (
    isObject(existing) &&
    existing.key === reservation.key &&
    existing.amountAtomic === reservation.amountAtomic &&
    existing.payer === reservation.payer &&
    existing.network === reservation.network &&
    existing.asset === reservation.asset &&
    existing.validBefore === reservation.validBefore
  );
}

// Only a lock error carries a path we raised ourselves; arbitrary errors stay opaque so a
// filesystem message cannot leak into a caller-visible field.
function unavailableDetail(error) {
  return isObject(error) && error.code === LOCK_ERROR_CODE
    ? { detail: error.message }
    : {};
}

function supportsAtomicFileUpdates(fileSystem) {
  return (
    typeof fileSystem.open === 'function' &&
    typeof fileSystem.rename === 'function' &&
    typeof fileSystem.unlink === 'function'
  );
}

// stale takeover は「古さの判定 (stat)」と「奪取の原子化 (rename)」の両方を要する。
function supportsStaleTakeover(fileSystem) {
  return (
    typeof fileSystem.stat === 'function' && typeof fileSystem.rename === 'function'
  );
}

let staleTakeoverWarned = false;

// 掟13: takeover が無効な fsImpl を **黙って** 素通りさせない。無効なら「SIGKILL で残った
// ロックが予算つき支払いを永久に止める」状態に戻るので、運用者が気づけるよう一度だけ警告する。
function warnStaleTakeoverUnavailable() {
  if (staleTakeoverWarned) return;
  staleTakeoverWarned = true;
  console.warn(
    'openpay-x402-sdk: fsImpl lacks stat/rename — stale spend-lock takeover is disabled; ' +
      'a lock left behind by a killed process will block budgeted payments until it is removed.',
  );
}

export function createFileSpendStore({ path, fsImpl } = {}) {
  let runtimePromise;

  async function resolveRuntime() {
    runtimePromise ??= (async () => {
      const fileSystem = fsImpl ?? (await import('node:fs/promises'));
      const pathModule = await import('node:path');
      const targetPath =
        path ??
        pathModule.join(
          (await import('node:os')).homedir(),
          '.openpay-x402',
          'spend.json',
        );
      return {
        fileSystem,
        targetPath,
        directory: pathModule.dirname(targetPath),
        lockPath: `${targetPath}.lock`,
      };
    })();
    return runtimePromise;
  }

  async function readDocument(fileSystem, targetPath) {
    let raw;
    try {
      raw = await fileSystem.readFile(targetPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    const document = JSON.parse(raw);
    if (!isObject(document)) throw new Error('spend store must contain an object');
    return document;
  }

  function lockUnavailable(lockPath, detail) {
    return Object.assign(
      new Error(
        `spend store lock unavailable: ${lockPath}${detail === undefined ? '' : ` (${detail})`}`,
      ),
      { code: LOCK_ERROR_CODE, lockPath },
    );
  }

  // Record who holds the lock so an operator inspecting a stuck store can tell whether the pid
  // is still alive. Failure to annotate must not release a lock we successfully created.
  async function annotateLock(handle, lockPath) {
    if (typeof handle?.writeFile !== 'function') return;
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        'utf8',
      );
    } catch {
      // The lock is held either way; the owner note is diagnostic only.
    }
  }

  async function lockAgeMs(fileSystem, lockPath) {
    try {
      const stats = await fileSystem.stat(lockPath);
      const modified = Number(stats?.mtimeMs ?? stats?.mtime);
      if (!Number.isFinite(modified)) return null;
      return Date.now() - modified;
    } catch {
      // A lock that vanished or cannot be inspected is not provably stale.
      return null;
    }
  }

  async function acquireLock(fileSystem, lockPath) {
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
      try {
        const handle = await fileSystem.open(lockPath, 'wx');
        await annotateLock(handle, lockPath);
        return handle;
      } catch (error) {
        if (!isLockHeld(error)) throw error;
        if (attempt === LOCK_RETRY_COUNT - 1) break;
        await wait(LOCK_RETRY_MS);
      }
    }

    // Stale takeover. A fresh lock is left alone, so a live holder is never displaced; only a lock
    // that outlived the 1s contention window is taken over.
    //
    // ⚠️ The takeover MUST NOT unlink lockPath. `unlink(lockPath)` then `open(lockPath,'wx')` lets
    // two processes that both saw the same stale lock interleave as
    //   A: unlink → open (holds the lock)
    //   B: unlink (deletes A's *fresh* lock) → open (succeeds)
    // so both run the critical section at once and one reservation is lost. `rename` is atomic and
    // exactly one process can move the stale file away, so ownership of the takeover is proven
    // before lockPath is recreated.
    if (!supportsStaleTakeover(fileSystem)) {
      warnStaleTakeoverUnavailable();
      throw lockUnavailable(lockPath, 'held (stale takeover unavailable)');
    }
    const age = await lockAgeMs(fileSystem, lockPath);
    if (age === null || age < SPEND_LOCK_STALE_MS) {
      throw lockUnavailable(
        lockPath,
        age === null ? 'held' : `held for ${Math.round(age / 1000)}s`,
      );
    }
    const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await fileSystem.rename(lockPath, stalePath);
    } catch (error) {
      // ENOENT = another process won the same takeover and its lock is now fresh. Report the
      // contention instead of guessing; the caller retries from the normal acquisition loop.
      throw lockUnavailable(
        lockPath,
        isMissingFile(error)
          ? 'reacquired by another process'
          : 'stale, takeover failed',
      );
    }
    let handle;
    try {
      handle = await fileSystem.open(lockPath, 'wx');
    } catch (error) {
      if (!isLockHeld(error)) throw error;
      throw lockUnavailable(lockPath, 'reacquired by another process');
    } finally {
      try {
        await fileSystem.unlink(stalePath);
      } catch {
        // The stale file is already out of the lock path, so a leftover copy cannot hand the
        // critical section to anyone; only disk tidiness suffers.
      }
    }
    await annotateLock(handle, lockPath);
    return handle;
  }

  async function withLock(operation) {
    const runtime = await resolveRuntime();
    if (!supportsAtomicFileUpdates(runtime.fileSystem)) {
      throw new Error('atomic spend store file operations are unavailable');
    }
    await runtime.fileSystem.mkdir(runtime.directory, { recursive: true });
    const handle = await acquireLock(runtime.fileSystem, runtime.lockPath);
    try {
      return await operation(runtime);
    } finally {
      try {
        await handle.close();
      } finally {
        await runtime.fileSystem.unlink(runtime.lockPath);
      }
    }
  }

  async function writeDocument(runtime, document) {
    const temporaryPath = `${runtime.targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await runtime.fileSystem.writeFile(
        temporaryPath,
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8',
      );
      await runtime.fileSystem.rename(temporaryPath, runtime.targetPath);
    } catch (error) {
      try {
        await runtime.fileSystem.unlink(temporaryPath);
      } catch {
        // Cleanup failure must not hide the persistence error that caused it.
      }
      throw error;
    }
  }

  function documentForDate(document, date) {
    const current = Object.fromEntries(
      Object.entries(document).filter(
        ([storedKey, value]) =>
          storedKey !== RESERVATIONS_KEY &&
          storedKey.endsWith(`:${date}`) &&
          isAtomicString(value),
      ),
    );
    const reservations = Object.fromEntries(
      Object.entries(reservationsFrom(document)).filter(
        ([, reservation]) =>
          isObject(reservation) &&
          typeof reservation.key === 'string' &&
          reservation.key.endsWith(`:${date}`),
      ),
    );
    if (Object.keys(reservations).length > 0) {
      current[RESERVATIONS_KEY] = reservations;
    }
    return current;
  }

  async function load(key) {
    try {
      const { fileSystem, targetPath } = await resolveRuntime();
      const document = await readDocument(fileSystem, targetPath);
      const value = document[key];
      return value === undefined ? '0' : isAtomicString(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function reserve(
    key,
    amountAtomic,
    limitAtomic,
    reservation = {},
  ) {
    if (
      !isAtomicString(amountAtomic) ||
      BigInt(amountAtomic) <= 0n ||
      !isAtomicString(limitAtomic)
    ) {
      return { ok: false, reason: 'unavailable' };
    }
    const id = reservation.id;
    if (
      typeof id !== 'string' ||
      typeof reservation.validBefore !== 'string'
    ) {
      return { ok: false, reason: 'unavailable' };
    }

    try {
      return await withLock(async (runtime) => {
        const document = await readDocument(
          runtime.fileSystem,
          runtime.targetPath,
        );
        const currentValue = document[key] ?? '0';
        if (!isAtomicString(currentValue)) {
          return { ok: false, reason: 'unavailable' };
        }
        const reservations = reservationsFrom(document);
        const requested = {
          key,
          amountAtomic,
          payer: reservation.payer,
          network: reservation.network,
          asset: reservation.asset,
          validBefore: reservation.validBefore,
          status: 'pending',
        };
        const existing = reservations[id];
        if (existing !== undefined) {
          return reservationMatches(existing, requested)
            ? { ok: true, totalAtomic: currentValue }
            : { ok: false, reason: 'unavailable' };
        }

        const next = BigInt(currentValue) + BigInt(amountAtomic);
        if (next > BigInt(limitAtomic)) {
          return {
            ok: false,
            reason: 'limit_exceeded',
            totalAtomic: currentValue,
          };
        }
        const date = key.slice(-10);
        const current = documentForDate(document, date);
        current[key] = next.toString();
        current[RESERVATIONS_KEY] = {
          ...reservationsFrom(current),
          [id]: requested,
        };
        await writeDocument(runtime, current);
        return { ok: true, totalAtomic: next.toString() };
      });
    } catch (error) {
      // Name the lock file when the block came from it. A bare "unavailable" sends operators
      // hunting through the payment path for a failure that is one leftover file.
      return { ok: false, reason: 'unavailable', ...unavailableDetail(error) };
    }
  }

  async function confirm(id) {
    if (typeof id !== 'string') return false;
    try {
      return await withLock(async (runtime) => {
        const document = await readDocument(
          runtime.fileSystem,
          runtime.targetPath,
        );
        const reservations = reservationsFrom(document);
        const existing = reservations[id];
        if (!isObject(existing)) return false;
        reservations[id] = { ...existing, status: 'confirmed' };
        document[RESERVATIONS_KEY] = reservations;
        await writeDocument(runtime, document);
        return true;
      });
    } catch {
      return false;
    }
  }

  async function save(key, atomicString) {
    try {
      const runtime = await resolveRuntime();
      if (!supportsAtomicFileUpdates(runtime.fileSystem)) {
        let document = {};
        try {
          document = await readDocument(
            runtime.fileSystem,
            runtime.targetPath,
          );
        } catch {
          document = {};
        }
        const current = documentForDate(document, key.slice(-10));
        current[key] = atomicString;
        await runtime.fileSystem.mkdir(runtime.directory, { recursive: true });
        await runtime.fileSystem.writeFile(
          runtime.targetPath,
          `${JSON.stringify(current, null, 2)}\n`,
          'utf8',
        );
        return;
      }
      await withLock(async (runtime) => {
        const document = await readDocument(
          runtime.fileSystem,
          runtime.targetPath,
        );
        const date = key.slice(-10);
        const current = documentForDate(document, date);
        current[key] = atomicString;
        await writeDocument(runtime, current);
      });
    } catch {
      // The payment may already be complete; persistence failure must not replace its response.
    }
  }

  return { load, reserve, confirm, save };
}
