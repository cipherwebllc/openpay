function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error) {
  return isObject(error) && error.code === 'ENOENT';
}

function isAtomicString(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
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
      };
    })();
    return runtimePromise;
  }

  async function load(key) {
    try {
      const { fileSystem, targetPath } = await resolveRuntime();
      let raw;
      try {
        raw = await fileSystem.readFile(targetPath, 'utf8');
      } catch (error) {
        return isMissingFile(error) ? '0' : null;
      }
      const document = JSON.parse(raw);
      if (!isObject(document)) return null;
      const value = document[key];
      return value === undefined ? '0' : isAtomicString(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function save(key, atomicString) {
    try {
      const { fileSystem, targetPath, directory } = await resolveRuntime();
      let document = {};
      try {
        const raw = await fileSystem.readFile(targetPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (isObject(parsed)) document = parsed;
      } catch {
        document = {};
      }

      const date = key.slice(-10);
      const current = Object.fromEntries(
        Object.entries(document).filter(
          ([storedKey, value]) =>
            storedKey.endsWith(`:${date}`) && isAtomicString(value),
        ),
      );
      current[key] = atomicString;
      await fileSystem.mkdir(directory, { recursive: true });
      await fileSystem.writeFile(
        targetPath,
        `${JSON.stringify(current, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // The payment is already complete; persistence failure must not replace its response.
    }
  }

  return { load, save };
}
