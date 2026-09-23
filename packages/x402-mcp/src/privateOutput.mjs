// Shared by packaged bootstrap and repository operator scripts; Node built-ins only.
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class PrivateOutputError extends Error {}

async function outsideRepository(directory) {
  let existing = directory;
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      existing = dirname(existing);
    }
  }
  for (;;) {
    let git;
    try { git = await lstat(join(existing, '.git')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Resolve symlinked parents and recognize both .git directories and worktree files:
    // private output must not spill into a checkout and then into a public commit.
    if (git) throw new PrivateOutputError('Private output must be outside a git repository');
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
}

export async function openPrivateOutput(file, { createParents = false } = {}) {
  const path = resolve(file);
  const parent = dirname(path);
  await outsideRepository(parent);
  if (createParents) await mkdir(parent, { recursive: true, mode: 0o700 });
  await outsideRepository(parent);
  // wx uses O_EXCL: neither an old credential/report nor a final symlink is overwritten.
  try { return { path, handle: await open(path, 'wx', 0o600) }; }
  catch (error) {
    if (error.code === 'EEXIST') throw new PrivateOutputError('Private output already exists; choose a new path');
    throw error;
  }
}
