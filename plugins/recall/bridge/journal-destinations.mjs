import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Saved filesystem-project destinations are matched the same way by the
// per-prompt journal hook and by the session-recording adapter. Both readers
// import this module so that a path can never route one of them somewhere
// the other would not go.

const run = promisify(execFile);
const GIT_RESOLUTION_TIMEOUT_MS = 2_000;
const GIT_CANONICAL_ARGUMENTS = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--git-common-dir",
];

// One bound for every reader of recall-journal.json. A file over this size is
// invalid to the hook and to the adapter alike, so flipping the pilot on or
// off can never change whether the file is honored.
export const JOURNAL_CONFIG_MAX_BYTES = 64 * 1024;

// Compare real paths so a project root saved with (or without) symlinks in it
// still matches the session's working directory.
export function normalizeDirectory(directory) {
  const resolved = path.resolve(directory);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isFilesystemRoot(directory) {
  return directory === path.parse(directory).root;
}

export function isInsideDirectory(directory, root) {
  const relativeDirectory = path.relative(root, directory);
  return (
    relativeDirectory === "" ||
    (relativeDirectory !== ".." &&
      !relativeDirectory.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeDirectory))
  );
}

// A saved root must be absolute and must not be the filesystem root either
// lexically or after symlinks are resolved: a key such as /tmp/scope that is
// a symlink to / would otherwise prefix-match every session. Returns the
// canonical root, or null when the key is unusable.
export function canonicalProjectRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return null;
  const resolved = path.resolve(root);
  if (isFilesystemRoot(resolved)) return null;
  const canonical = normalizeDirectory(resolved);
  return isFilesystemRoot(canonical) ? null : canonical;
}

function gitEnvironment(env) {
  const environment = { ...env, GIT_TERMINAL_PROMPT: "0" };
  delete environment.GIT_COMMON_DIR;
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  return environment;
}

// Project bindings use the main checkout's path as their stable identity, but
// Codex and Claude Code may place linked worktrees elsewhere on disk. Given
// the output of `git rev-parse --show-toplevel --git-common-dir`, preserve the
// current subdirectory while mapping it onto the main checkout. Anything that
// is not a normal non-bare checkout keeps the filesystem-only directory.
export function canonicalizeThroughMainCheckout(currentDirectory, stdout) {
  if (typeof stdout !== "string") return currentDirectory;
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2 || lines.some((line) => line.length === 0)) {
    return currentDirectory;
  }

  const checkoutRoot = normalizeDirectory(lines[0]);
  const commonDirectory = normalizeDirectory(lines[1]);
  if (
    path.basename(commonDirectory) !== ".git" ||
    !isInsideDirectory(currentDirectory, checkoutRoot)
  ) {
    return currentDirectory;
  }

  const mainCheckoutRoot = normalizeDirectory(path.dirname(commonDirectory));
  const relativeDirectory = path.relative(checkoutRoot, currentDirectory);
  return normalizeDirectory(path.join(mainCheckoutRoot, relativeDirectory));
}

// The hook runs once per prompt and exits, so it resolves synchronously.
export function resolveCanonicalWorkingDirectorySync(
  workingDirectory,
  env = process.env,
) {
  const currentDirectory = normalizeDirectory(workingDirectory);
  const result = spawnSync(
    "git",
    ["-C", currentDirectory, ...GIT_CANONICAL_ARGUMENTS],
    {
      encoding: "utf8",
      env: gitEnvironment(env),
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_RESOLUTION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) return currentDirectory;
  return canonicalizeThroughMainCheckout(currentDirectory, result.stdout);
}

// The key of a saved filesystem-project destination is the main checkout's
// root, so a linked worktree and the checkout it belongs to share one entry.
// Outside Git, or when Git cannot answer, the working directory itself is the
// root, exactly as the journal skill documents; the caller still rejects the
// filesystem root through canonicalProjectRoot.
export function resolveFilesystemProjectRootSync(
  workingDirectory,
  env = process.env,
) {
  const currentDirectory = normalizeDirectory(workingDirectory);
  const result = spawnSync(
    "git",
    ["-C", currentDirectory, ...GIT_CANONICAL_ARGUMENTS],
    {
      encoding: "utf8",
      env: gitEnvironment(env),
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_RESOLUTION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    return { repository: false, root: currentDirectory };
  }
  const lines = result.stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2 || lines.some((line) => line.length === 0)) {
    return { repository: true, root: currentDirectory };
  }
  const commonDirectory = normalizeDirectory(lines[1]);
  if (path.basename(commonDirectory) !== ".git") {
    return { repository: true, root: currentDirectory };
  }
  return {
    repository: true,
    root: normalizeDirectory(path.dirname(commonDirectory)),
  };
}

// The adapter lives inside the long-running bridge, so it must not block.
export async function resolveCanonicalWorkingDirectory(
  workingDirectory,
  { env = process.env, execute = run } = {},
) {
  const currentDirectory = normalizeDirectory(workingDirectory);
  let stdout;
  try {
    ({ stdout } = await execute(
      "git",
      ["-C", currentDirectory, ...GIT_CANONICAL_ARGUMENTS],
      {
        encoding: "utf8",
        env: gitEnvironment(env),
        maxBuffer: 16 * 1024,
        timeout: GIT_RESOLUTION_TIMEOUT_MS,
        windowsHide: true,
      },
    ));
  } catch {
    return currentDirectory;
  }
  return canonicalizeThroughMainCheckout(currentDirectory, stdout);
}

// A saved root covers itself and everything under it; the longest matching
// root wins when saved roots nest. Roots are canonicalized again here so a
// symlink retargeted at the filesystem root after validation cannot swallow
// every session. Entries carry their canonical `root` plus whatever payload
// the caller attached; the matching entry is returned.
export function matchProjectDestination(entries, canonicalDirectory) {
  let bestRoot = null;
  let bestEntry = null;
  for (const entry of entries) {
    const projectRoot = normalizeDirectory(entry.root);
    if (isFilesystemRoot(projectRoot)) continue;
    if (!isInsideDirectory(canonicalDirectory, projectRoot)) continue;
    if (bestRoot === null || projectRoot.length > bestRoot.length) {
      bestRoot = projectRoot;
      bestEntry = entry;
    }
  }
  return bestEntry;
}
