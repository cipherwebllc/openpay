import { randomUUID } from 'node:crypto';

const RESERVATIONS_KEY = '__openpayReservations';
const LOCK_RETRY_COUNT = 40;
const LOCK_RETRY_MS = 25;

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

function supportsAtomicFileUpdates(fileSystem) {
  return (
    typeof fileSystem.open === 'function' &&
    typeof fileSystem.rename === 'function' &&
    typeof fileSystem.unlink === 'function'
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

  async function acquireLock(fileSystem, lockPath) {
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
      try {
        return await fileSystem.open(lockPath, 'wx');
      } catch (error) {
        if (!isLockHeld(error)) throw error;
        if (attempt === LOCK_RETRY_COUNT - 1) throw error;
        await wait(LOCK_RETRY_MS);
      }
    }
    throw new Error('spend store lock unavailable');
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
    } catch {
      return { ok: false, reason: 'unavailable' };
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
