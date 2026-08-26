import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = new URL("../", import.meta.url);
const launcherSource = fileURLToPath(
  new URL("plugins/recall/bridge/launch.mjs", repoRoot)
);

// A stand-in bridge entry: reports how it was invoked, honors --exit so exit
// codes can be proven to forward verbatim (the helper exit-code contract).
const stubBridge = `
const args = process.argv.slice(2);
const exitFlag = args.indexOf("--exit");
process.stdout.write(
  JSON.stringify({
    args,
    execPath: process.execPath,
    via: process.env.RECALL_TEST_VIA ?? null,
  }) + "\\n"
);
process.exit(exitFlag === -1 ? 0 : Number(args[exitFlag + 1]));
`;

async function makeLauncherFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "recall-launch-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const launcher = path.join(root, "launch.mjs");
  await copyFile(launcherSource, launcher);
  await writeFile(path.join(root, "index.mjs"), stubBridge);
  return { root, launcher };
}

function launchEnvironment(root, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.RECALL_BRIDGE_NODE;
  // Point every home-derived location at the empty fixture so a developer's
  // real pinned runtime can't leak into the test.
  env.HOME = root;
  env.USERPROFILE = root;
  env.LOCALAPPDATA = path.join(root, "AppData", "Local");
  return { ...env, ...extra };
}

async function runLauncher(launcher, args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [launcher, ...args],
      { env }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("launch.mjs runs the bridge on the current runtime, forwarding args and exit codes", async (t) => {
  const { root, launcher } = await makeLauncherFixture(t);
  const result = await runLauncher(
    launcher,
    ["--client-name", "Claude", "--exit", "66"],
    launchEnvironment(root)
  );

  assert.equal(result.code, 66);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.args, ["--client-name", "Claude", "--exit", "66"]);
  assert.equal(report.execPath, process.execPath);
});

test("an explicit RECALL_BRIDGE_NODE override wins", async (t) => {
  const { root, launcher } = await makeLauncherFixture(t);
  const overrideName =
    process.platform === "win32" ? "custom-node.exe" : "custom-node";
  const override = path.join(root, overrideName);
  await copyFile(process.execPath, override);
  if (process.platform !== "win32") {
    await chmod(override, 0o755);
  }

  const result = await runLauncher(
    launcher,
    ["--client-name", "Codex"],
    launchEnvironment(root, { RECALL_BRIDGE_NODE: override })
  );

  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  // Compare real paths: macOS tmpdir sits behind the /var -> /private/var
  // symlink and Node reports the resolved execPath.
  assert.equal(await realpath(report.execPath), await realpath(override));
});

test("a broken RECALL_BRIDGE_NODE errors loudly instead of falling back", async (t) => {
  const { root, launcher } = await makeLauncherFixture(t);
  const result = await runLauncher(
    launcher,
    ["--client-name", "Claude"],
    launchEnvironment(root, {
      RECALL_BRIDGE_NODE: path.join(root, "missing-node"),
    })
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /RECALL_BRIDGE_NODE/);
});

test(
  "the macOS pinned runtime is preferred over the current runtime",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, launcher } = await makeLauncherFixture(t);
    const bundledBin = path.join(
      root,
      "Library",
      "Application Support",
      "Recall",
      "AgentRuntime",
      "bin"
    );
    await mkdir(bundledBin, { recursive: true });
    const bundled = path.join(bundledBin, "recall-node");
    await writeFile(
      bundled,
      `#!/bin/sh\nRECALL_TEST_VIA=bundled exec "${process.execPath}" "$@"\n`
    );
    await chmod(bundled, 0o755);

    const result = await runLauncher(
      launcher,
      ["--client-name", "Claude"],
      launchEnvironment(root)
    );

    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).via, "bundled");
  }
);

test(
  "the Windows pinned runtime location is preferred when present",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, launcher } = await makeLauncherFixture(t);
    const bundledBin = path.join(
      root,
      "AppData",
      "Local",
      "NerdOut",
      "Recall",
      "AgentRuntime",
      "bin"
    );
    await mkdir(bundledBin, { recursive: true });
    const bundled = path.join(bundledBin, "node.exe");
    await copyFile(process.execPath, bundled);

    const result = await runLauncher(
      launcher,
      ["--client-name", "Claude"],
      launchEnvironment(root)
    );

    assert.equal(result.code, 0);
    assert.equal(
      await realpath(JSON.parse(result.stdout).execPath),
      await realpath(bundled)
    );
  }
);
