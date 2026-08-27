#!/usr/bin/env node
// Opt-in lifecycle decoration around the unchanged transport supervisor.
// This process opens no listener and creates no second Recall connection.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { SessionLifecycleAdapter } from "./session-lifecycle-adapter.mjs";
import {
  JsonLineReader,
  SessionRpcInterposer,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
} from "./session-rpc.mjs";

export function startSessionAdapter({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  spawnProcess = spawn,
  env = process.env,
} = {}) {
  const hostIndex = argv.indexOf("--host");
  const host = hostIndex >= 0 ? argv[hostIndex + 1] : null;
  if (!["claude-code", "codex"].includes(host))
    throw new Error("Unsupported Recall recording adapter host.");
  const forwarded = [...argv];
  forwarded.splice(hostIndex, 2);
  const child = spawnProcess(
    process.execPath,
    [fileURLToPath(new URL("./index.mjs", import.meta.url)), ...forwarded],
    { env, stdio: ["pipe", "pipe", "inherit"] },
  );
  const send = (stream, value, source) => {
    const body = `${JSON.stringify(value)}\n`;
    if (!stream.write(body)) {
      source?.pause();
      stream.once("drain", () => source?.resume());
    }
  };
  let rpc;
  const adapter = new SessionLifecycleAdapter({
    host,
    env,
    call: (tool, args, options) => rpc.call(tool, args, options),
  });
  rpc = new SessionRpcInterposer({
    adapter,
    sendHost: (value) => send(output, value, child.stdout),
    sendPeer: (value) => send(child.stdin, value, input),
  });
  const fail = () => {
    rpc.close();
    child.kill("SIGTERM");
  };
  const hostLines = new JsonLineReader(
    MAX_REQUEST_BYTES,
    (value) => {
      void rpc.fromHost(value).catch(fail);
    },
    fail,
  );
  const peerLines = new JsonLineReader(
    MAX_RESPONSE_BYTES,
    (value) => {
      void rpc.fromPeer(value).catch(fail);
    },
    fail,
  );
  input.on("data", (chunk) => hostLines.push(chunk));
  input.on("end", () => {
    hostLines.end();
    child.stdin.end();
  });
  child.stdout.on("data", (chunk) => peerLines.push(chunk));
  child.stdout.on("end", () => peerLines.end());
  child.stdin.on("error", fail);
  output.on("error", fail);
  child.on("error", fail);
  child.on("exit", () => rpc.close());
  return { child, rpc };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invoked === import.meta.url) {
  try {
    const { child } = startSessionAdapter();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.on(signal, () => child.kill(signal));
    child.on("exit", (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1);
      process.stdin.pause();
    });
  } catch {
    process.stderr.write("[recall] Recording adapter could not start.\n");
    process.exitCode = 2;
  }
}
