import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import {
  LifecycleError,
  isObject,
  isToken,
  parseToolResult,
} from "./session-lifecycle-contract.mjs";

const run = promisify(execFile);
const onlyKeys = (value, keys) =>
  isObject(value) && Object.keys(value).every((key) => keys.includes(key));

export function agentConfigDirectory(host, env = process.env) {
  if (host === "claude-code")
    return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  if (host === "codex")
    return env.CODEX_HOME || path.join(os.homedir(), ".codex");
  throw new LifecycleError("unsupported_host");
}

export async function readLifecycleConfig(host, env = process.env) {
  const directory = agentConfigDirectory(host, env);
  let value;
  try {
    const file = path.join(directory, "recall-journal.json");
    const stat = await fs.stat(file);
    if (stat.size > 16 * 1024) throw new LifecycleError("config_invalid");
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, directory };
    throw new LifecycleError("config_invalid");
  }
  // Version 6 carries the pilot beside one default Project. Version 7 carries
  // the same `sessionLifecycle` block, optional this time, beside the global
  // and per-path destinations; its global destination is the adapter's
  // no-repository default, and a file without one has no such default.
  if (value?.version !== 6 && value?.version !== 7)
    return { enabled: false, directory };
  const version7 = value.version === 7;
  const lifecycle = version7
    ? (value.sessionLifecycle ?? { enabled: false })
    : value.sessionLifecycle;
  if (
    !onlyKeys(value, ["version", "projectMemory", "sessionLifecycle"]) ||
    !onlyKeys(
      value.projectMemory,
      version7 ? ["enabled", "global", "paths"] : ["enabled", "defaultProject"],
    ) ||
    value.projectMemory.enabled !== true ||
    !onlyKeys(lifecycle, ["enabled", "codexParticipantVerified"]) ||
    typeof lifecycle.enabled !== "boolean" ||
    (lifecycle.codexParticipantVerified !== undefined &&
      typeof lifecycle.codexParticipantVerified !== "boolean")
  ) {
    throw new LifecycleError("config_invalid");
  }
  const scopeOf = (destination) => {
    if (!onlyKeys(destination, ["workspace", "recallProject"]))
      throw new LifecycleError("config_invalid");
    for (const key of ["workspace", "recallProject"]) {
      if (
        !onlyKeys(destination[key], ["id", "name"]) ||
        !isToken(destination[key].id) ||
        typeof destination[key].name !== "string" ||
        !destination[key].name.trim() ||
        destination[key].name.length > 256
      ) {
        throw new LifecycleError("config_invalid");
      }
    }
    return {
      workspaceId: destination.workspace.id,
      projectUuid: destination.recallProject.id,
    };
  };
  let defaultProject;
  if (version7) {
    const { global: globalValue, paths } = value.projectMemory;
    defaultProject = globalValue === undefined ? null : scopeOf(globalValue);
    if (paths !== undefined && !isObject(paths))
      throw new LifecycleError("config_invalid");
    const roots = paths === undefined ? [] : Object.keys(paths);
    for (const root of roots) {
      if (
        !path.isAbsolute(root) ||
        path.resolve(root) === path.parse(path.resolve(root)).root
      )
        throw new LifecycleError("config_invalid");
      scopeOf(paths[root]);
    }
    if (!defaultProject && roots.length === 0)
      throw new LifecycleError("config_invalid");
  } else {
    defaultProject = scopeOf(value.projectMemory.defaultProject);
  }
  return {
    enabled: lifecycle.enabled,
    directory,
    defaultProject,
    codexParticipantVerified: lifecycle.codexParticipantVerified === true,
  };
}

export function sanitizedRemote(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\x00-\x1f\x7f]/.test(value)
  )
    return null;
  let url;
  if (/^git@[^/:]+:[^/]/.test(value)) {
    const match = /^git@([^/:]+):(.+)$/.exec(value);
    value = `ssh://git@${match[1]}/${match[2]}`;
  }
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/\.$/, "");
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.username && !(url.protocol === "ssh:" && url.username === "git")) ||
    !hostname.includes(".") ||
    isIP(hostname) ||
    hostname.startsWith("[") ||
    /\.(local|localhost)$/.test(hostname) ||
    !url.pathname ||
    url.pathname === "/"
  )
    return null;
  return url.href;
}

export async function inspectRepository(
  cwd,
  { env = process.env, execute = run } = {},
) {
  if (!path.isAbsolute(cwd)) throw new LifecycleError("repository_unavailable");
  let directory;
  try {
    directory = await fs.realpath(cwd);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error();
  } catch {
    throw new LifecycleError("repository_unavailable");
  }
  let found = false;
  for (let depth = 0; depth < 256; depth++) {
    try {
      await fs.lstat(path.join(directory, ".git"));
      found = true;
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code))
        throw new LifecycleError("repository_unavailable");
    }
    const parent = path.dirname(directory);
    if (parent === directory) return { kind: "absent" };
    directory = parent;
  }
  if (!found) throw new LifecycleError("repository_unavailable");
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(gitEnv)) {
    if (
      [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
      ].includes(key) ||
      /^GIT_CONFIG_(KEY|VALUE)_/.test(key)
    )
      delete gitEnv[key];
  }
  let remote;
  try {
    const result = await execute(
      "git",
      ["-C", cwd, "config", "--local", "--get", "remote.origin.url"],
      {
        env: gitEnv,
        timeout: 1000,
        maxBuffer: 4096,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    remote = sanitizedRemote(result.stdout.trim());
  } catch {
    throw new LifecycleError("repository_unavailable");
  }
  if (!remote) throw new LifecycleError("repository_unavailable");
  return { kind: "present", remoteUrl: remote };
}

export async function resolveLifecycleScope(
  event,
  config,
  call,
  inspect = inspectRepository,
) {
  const repository = await inspect(event.cwd);
  if (repository.kind === "absent") {
    // A version 7 file may carry only per-path destinations; outside a
    // repository it then has no default to offer, and nothing is guessed.
    if (!config.defaultProject) throw new LifecycleError("scope_unavailable");
    return config.defaultProject;
  }
  if (repository.kind !== "present")
    throw new LifecycleError("repository_unavailable");
  // Repository paths (including a local root basename) stay local. The exact
  // encrypted remote binding is the only routing evidence sent to Recall.
  const result = parseToolResult(
    await call("resolve_project", { remoteUrl: repository.remoteUrl }),
  );
  if (result?.match === "ambiguous")
    throw new LifecycleError("project_ambiguous");
  if (result?.match !== "exact")
    throw new LifecycleError(
      result?.match === "not_ready"
        ? "project_not_ready"
        : "project_unresolved",
    );
  if (!isToken(result.project?.id) || !isToken(result.project?.workspaceId))
    throw new LifecycleError("scope_unavailable");
  return {
    workspaceId: result.project.workspaceId,
    projectUuid: result.project.id,
  };
}
