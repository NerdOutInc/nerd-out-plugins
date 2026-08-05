#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_SERVER_TIMEOUT_MS = 8_000;
const INITIALIZE_REQUEST_ID = 1;
const HOOKS_LIST_REQUEST_ID = 2;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "../../..");
const recallHookSourcePath = path.join(pluginRoot, "hooks", "hooks.json");

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function collectDiagnostics(entries, field) {
  return entries.flatMap((entry) => {
    const diagnostics = Array.isArray(entry?.[field]) ? entry[field] : [];
    return diagnostics
      .map((diagnostic) =>
        typeof diagnostic === "string" ? diagnostic : diagnostic?.message,
      )
      .filter((message) => typeof message === "string" && message.length > 0);
  });
}

function summarizeHook(hook) {
  return {
    key: hook.key,
    enabled: hook.enabled,
    trustStatus: hook.trustStatus,
    isManaged: hook.isManaged,
  };
}

export function classifyRecallHook(
  response,
  { expectedSourcePath = recallHookSourcePath } = {},
) {
  const entries = Array.isArray(response?.data) ? response.data : [];
  const normalizedExpectedSourcePath = normalizePath(expectedSourcePath);
  const matches = entries
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .filter(
      (hook) =>
        hook?.source === "plugin" &&
        hook?.eventName === "userPromptSubmit" &&
        hook?.handlerType === "command" &&
        normalizePath(hook?.sourcePath) === normalizedExpectedSourcePath,
    );

  const diagnostics = {
    warnings: collectDiagnostics(entries, "warnings"),
    errors: collectDiagnostics(entries, "errors"),
  };

  if (matches.length === 0) {
    return { status: "missing", ...diagnostics };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", matchCount: matches.length, ...diagnostics };
  }

  const hook = matches[0];
  const summary = summarizeHook(hook);
  if (hook.enabled !== true) {
    return { status: "disabled", hook: summary, ...diagnostics };
  }

  switch (hook.trustStatus) {
    case "trusted":
    case "managed":
    case "untrusted":
    case "modified":
      return { status: hook.trustStatus, hook: summary, ...diagnostics };
    default:
      return { status: "unknown", hook: summary, ...diagnostics };
  }
}

function compactProtocolError(error) {
  const message = typeof error?.message === "string" ? error.message : null;
  return message?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
}

export function inspectCodexHook({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let output;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output?.close();
      child?.stdin.end();
      child?.kill("SIGTERM");
      resolve(result);
    };

    const unavailable = (reason, error = null) =>
      finish({
        status: "unavailable",
        reason,
        ...(compactProtocolError(error)
          ? { protocolError: compactProtocolError(error) }
          : {}),
      });

    const timer = setTimeout(
      () => unavailable("Timed out while asking Codex for hook status."),
      APP_SERVER_TIMEOUT_MS,
    );

    try {
      child = spawn(env.CODEX_CLI_PATH || "codex", ["app-server"], {
        cwd: path.resolve(cwd),
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      unavailable("Could not start the Codex App Server.", error);
      return;
    }

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        unavailable("Could not send the hook-status request to Codex.", error);
      }
    };

    child.once("error", (error) =>
      unavailable("Could not start the Codex App Server.", error),
    );
    child.once("exit", (code) => {
      if (!settled) {
        unavailable(
          `Codex App Server exited before returning hook status (exit ${code ?? "unknown"}).`,
        );
      }
    });

    output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        unavailable("Codex App Server returned an invalid response.");
        return;
      }

      if (message.id === INITIALIZE_REQUEST_ID) {
        if (message.error) {
          unavailable(
            "Codex App Server rejected initialization.",
            message.error,
          );
          return;
        }
        send({ method: "initialized", params: {} });
        send({
          method: "hooks/list",
          id: HOOKS_LIST_REQUEST_ID,
          params: { cwds: [path.resolve(cwd)] },
        });
        return;
      }

      if (message.id === HOOKS_LIST_REQUEST_ID) {
        if (message.error) {
          unavailable("Codex could not list lifecycle hooks.", message.error);
          return;
        }
        finish(classifyRecallHook(message.result));
      }
    });

    send({
      method: "initialize",
      id: INITIALIZE_REQUEST_ID,
      params: {
        clientInfo: {
          name: "recall_journal_hook_status",
          title: "Recall Journal Hook Status",
          version: "1.0.0",
        },
      },
    });
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  const result = await inspectCodexHook({
    cwd: process.argv[2] || process.cwd(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
