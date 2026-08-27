import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import {
  APP_LIFECYCLE_TOOL,
  LOCAL_HOOK_TOOL,
  LOCAL_BEGIN_TOOL,
  LOCAL_STATUS_TOOL,
  LifecycleError,
  MAX_RECEIPTS,
  appSupportsLifecycle,
  lifecycleDigest,
  validateLocalEvent,
} from "../plugins/recall/bridge/session-lifecycle-contract.mjs";
import { SessionLifecycleAdapter } from "../plugins/recall/bridge/session-lifecycle-adapter.mjs";
import { LifecycleStateStore } from "../plugins/recall/bridge/session-lifecycle-state.mjs";
import {
  readLifecycleConfig,
  resolveLifecycleScope,
  sanitizedRemote,
  inspectRepository,
} from "../plugins/recall/bridge/session-lifecycle-routing.mjs";
import {
  JsonLineReader,
  MAX_LIFECYCLE_RESPONSE_BYTES,
  SessionRpcInterposer,
} from "../plugins/recall/bridge/session-rpc.mjs";
import { startSessionAdapter } from "../plugins/recall/bridge/session-adapter.mjs";
import { lifecycleContext } from "../plugins/recall/hooks/session-lifecycle-context.mjs";
import { lifecycleHookProfile } from "../plugins/recall/hooks/session-lifecycle-profiles.mjs";

const fields = [
  "protocolVersion",
  "operation",
  "workspaceId",
  "projectUuid",
  "host",
  "conversationDigest",
  "participantDigest",
  "eventDigest",
  "sequence",
  "occurredAtMs",
  "source",
];
const catalog = [
  {
    name: APP_LIFECYCLE_TOOL,
    inputSchema: {
      type: "object",
      required: fields,
      properties: {
        ...Object.fromEntries(
          [...fields, "expectedSessionUuid", "expectedPrincipalDigest"].map(
            (key) => [
              key,
              {
                type: ["protocolVersion", "sequence", "occurredAtMs"].includes(
                  key,
                )
                  ? "integer"
                  : "string",
              },
            ],
          ),
        ),
        protocolVersion: { type: "integer", enum: [1] },
        operation: {
          type: "string",
          enum: ["begin", "observe", "yield", "end", "status"],
        },
        host: { type: "string", enum: ["claude-code", "codex"] },
        source: {
          type: "string",
          enum: [
            "mutating_tool",
            "explicit_begin",
            "prompt",
            "tool",
            "stop",
            "session_end",
            "recovery",
          ],
        },
      },
    },
  },
];
const config = (directory) => ({
  enabled: true,
  directory,
  defaultProject: { workspaceId: "workspace-one", projectUuid: "project-one" },
});
const event = (overrides = {}) => ({
  protocolVersion: 1,
  host: "claude-code",
  eventName: "PreToolUse",
  cwd: "/fixture/work",
  conversationId: "conversation-one",
  participantId: null,
  turnId: "turn-one",
  toolUseId: "call-one",
  toolName: "Edit",
  ...overrides,
});
const jsonResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const decode = (value) =>
  value.structuredContent ?? JSON.parse(value.content[0].text);
const hookContext = (value) =>
  decode(value).hookSpecificOutput?.additionalContext ?? "";

function fakeApp() {
  const calls = [];
  const roots = new Map();
  const receipts = new Map();
  let principalDigest = "a".repeat(64);
  let failAfterApply = 0;
  let statusUnavailable = false;
  let reserveNextBegin = false;
  let pendingDeliveries;
  let resolution = {
    match: "exact",
    project: { id: "project-one", workspaceId: "workspace-one" },
  };
  const keyFor = (input) =>
    JSON.stringify([
      principalDigest,
      input.conversationDigest,
      input.participantDigest,
      input.workspaceId,
      input.projectUuid,
    ]);
  const status = (root) => ({
    protocolVersion: 1,
    status: root
      ? root.sessionState === "ACTIVE"
        ? root.phase
        : "ended"
      : "not_started",
    principalDigest,
    lastSequence: root?.lastSequence ?? 0,
    ...(pendingDeliveries ? { pendingDeliveries } : {}),
    ...(root
      ? {
          sessionUuid: root.sessionUuid,
          sessionState: root.sessionState,
          segmentGeneration: root.generation,
          observationRevision: root.revision,
        }
      : {}),
  });
  const call = async (tool, input) => {
    calls.push({ tool, input: structuredClone(input) });
    if (tool === "resolve_project") return jsonResult(resolution);
    assert.equal(tool, APP_LIFECYCLE_TOOL);
    const key = keyFor(input);
    let root = roots.get(key);
    if (input.operation === "status") {
      if (statusUnavailable) throw new LifecycleError("transport_unavailable");
      return jsonResult(status(root));
    }
    if (input.expectedPrincipalDigest !== principalDigest)
      return jsonResult({
        ...status(root),
        status: "conflict",
        reasonCode: "principal_mismatch",
      });
    const receiptKey = `${key}/${input.eventDigest}`;
    if (receipts.has(receiptKey)) {
      if (failAfterApply > 0) {
        failAfterApply--;
        throw new LifecycleError("transport_unavailable");
      }
      return jsonResult(receipts.get(receiptKey));
    }
    const reservedRetry =
      root?.phase === "queued" &&
      root.reservedEventDigest === input.eventDigest;
    if (root && input.sequence <= root.lastSequence && !reservedRetry)
      return jsonResult({
        ...status(root),
        status: "conflict",
        reasonCode: "receipt_conflict",
      });
    if (
      root &&
      input.expectedSessionUuid !== root.sessionUuid &&
      !reservedRetry
    )
      return jsonResult({
        ...status(root),
        status: "conflict",
        reasonCode: "receipt_conflict",
      });
    if (input.operation === "begin") {
      if (!root || root.sessionState !== "ACTIVE")
        root = {
          sessionUuid: randomUUID(),
          sessionState: "ACTIVE",
          phase: "recording",
          generation: (root?.generation ?? 0) + 1,
          revision: root?.revision ?? 0,
          lastSequence: 0,
        };
      if (reserveNextBegin) {
        reserveNextBegin = false;
        root.phase = "queued";
        root.lastSequence = input.sequence;
        root.reservedEventDigest = input.eventDigest;
        roots.set(key, root);
        return jsonResult(status(root));
      }
      root.phase = "recording";
    } else if (!root) return jsonResult(status(root));
    else if (input.operation === "yield") root.phase = "yielded";
    else if (input.operation === "observe") root.phase = "recording";
    else if (input.operation === "end") root.sessionState = "ABANDONED";
    root.lastSequence = input.sequence;
    root.revision++;
    roots.set(key, root);
    const result = status(root);
    receipts.set(receiptKey, result);
    if (failAfterApply > 0) {
      failAfterApply--;
      throw new LifecycleError("transport_unavailable");
    }
    return jsonResult(result);
  };
  return {
    calls,
    roots,
    receipts,
    call,
    setPrincipal: (value) => {
      principalDigest = value;
    },
    failAfterApply: (count) => {
      failAfterApply = count;
    },
    setStatusUnavailable: (value) => {
      statusUnavailable = value;
    },
    setResolution: (value) => {
      resolution = value;
    },
    reserveNextBegin: () => {
      reserveNextBegin = true;
    },
    setPendingDeliveries: (value) => {
      pendingDeliveries = value;
    },
  };
}

async function rig(t, options = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-lifecycle-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const app = options.app ?? fakeApp();
  const makeAdapter = () =>
    new SessionLifecycleAdapter({
      host: options.host ?? "claude-code",
      call: app.call,
      clock: () => 1_000_000,
      readConfig: async () => ({ ...config(directory), ...options.config }),
      inspectRepository: async () => options.repository ?? { kind: "absent" },
      ...options.adapterOptions,
    });
  const adapter = makeAdapter();
  await adapter.catalog(catalog);
  return { directory, app, adapter, makeAdapter };
}

test("v6 writes require the complete native capability and explicit opt-in", async (t) => {
  const { adapter, app } = await rig(t, { config: { enabled: false } });
  assert.deepEqual(
    (await adapter.catalog(catalog)).map((tool) => tool.name),
    [LOCAL_STATUS_TOOL],
  );
  assert.equal(
    decode(
      await adapter.handle(
        LOCAL_BEGIN_TOOL,
        event({ eventName: "ExplicitBegin", requestId: "begin-one" }),
      ),
    ).reasonCode,
    "disabled",
  );
  assert.equal(app.calls.length, 0);
  const incomplete = structuredClone(catalog);
  delete incomplete[0].inputSchema.properties.expectedPrincipalDigest;
  assert.equal(appSupportsLifecycle(incomplete), false);
});

test("raw event bodies and unproved participant identities fail before any app call", async (t) => {
  const { adapter, app } = await rig(t);
  const unsafe = await adapter.handle(
    LOCAL_HOOK_TOOL,
    event({ tool_input: { command: "secret" } }),
  );
  assert.match(hookContext(unsafe), /invalid_event/);
  assert.equal(app.calls.length, 0);
  assert.throws(
    () =>
      validateLocalEvent(
        event({ host: "codex", toolName: "apply_patch" }),
        "codex",
      ),
    /participant_unavailable/,
  );
  assert.notEqual(
    lifecycleDigest("conversation", "ab", "c"),
    lifecycleDigest("conversation", "a", "bc"),
  );
});

test("mutating tools and explicit begin share a segment across prompts and yields", async (t) => {
  const { adapter, app } = await rig(t);
  const shell = await adapter.handle(
    LOCAL_HOOK_TOOL,
    event({ toolName: "Bash" }),
  );
  assert.match(hookContext(shell), /No Recall segment/);
  assert.equal(
    app.calls.filter((call) => call.input.operation === "begin").length,
    0,
  );
  const started = decode(
    await adapter.handle(
      LOCAL_BEGIN_TOOL,
      event({
        eventName: "ExplicitBegin",
        requestId: "begin-one",
        toolUseId: null,
        toolName: null,
      }),
    ),
  );
  assert.equal(started.status, "recording");
  assert.equal(started.eventOrigin, "client_reported");
  const session = started.sessionUuid;
  await adapter.handle(
    LOCAL_HOOK_TOOL,
    event({ toolUseId: "edit-two", turnId: "turn-two" }),
  );
  await adapter.handle(
    LOCAL_HOOK_TOOL,
    event({
      eventName: "UserPromptSubmit",
      turnId: "turn-three",
      toolUseId: null,
      toolName: null,
    }),
  );
  assert.deepEqual(
    decode(
      await adapter.handle(
        LOCAL_HOOK_TOOL,
        event({
          eventName: "Stop",
          turnId: "turn-three",
          toolUseId: null,
          toolName: null,
        }),
      ),
    ),
    {},
  );
  assert.equal([...app.roots.values()][0].phase, "yielded");
  await adapter.handle(
    LOCAL_HOOK_TOOL,
    event({ toolUseId: "edit-four", turnId: "turn-four" }),
  );
  assert.equal(app.roots.size, 1);
  assert.equal([...app.roots.values()][0].sessionUuid, session);
  assert.equal([...app.roots.values()][0].phase, "recording");
  for (const { input } of app.calls) {
    assert.equal(JSON.stringify(input).includes("/fixture/work"), false);
    assert.equal(JSON.stringify(input).includes("conversation-one"), false);
    assert.equal(JSON.stringify(input).includes("turn-"), false);
  }
});

test("terminal predecessor advances once at the next work boundary, never on Stop or replay", async (t) => {
  const { adapter, app } = await rig(t);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  const root = [...app.roots.values()][0];
  const prior = root.sessionUuid;
  root.sessionState = "ABANDONED";
  await adapter.handle(
    LOCAL_HOOK_TOOL,
    event({ eventName: "Stop", toolUseId: null, toolName: null }),
  );
  assert.equal([...app.roots.values()][0].sessionUuid, prior);
  const endedContext = hookContext(
    await adapter.handle(
      LOCAL_HOOK_TOOL,
      event({
        eventName: "UserPromptSubmit",
        toolUseId: null,
        toolName: null,
        turnId: "after-predecessor-end",
      }),
    ),
  );
  assert.equal(endedContext.includes(prior), true);
  assert.match(endedContext, /has ended/);
  assert.match(endedContext, /next validated edit boundary/);
  assert.match(
    endedContext,
    /confirming the predecessor's end does not confirm delivery/,
  );
  assert.doesNotMatch(endedContext, /recording is unavailable/);
  assert.equal(
    app.calls.filter((call) => call.input.operation === "begin").length,
    1,
  );
  const nextEvent = event({
    toolUseId: "next-work",
    turnId: "same-or-new-turn",
  });
  await adapter.handle(LOCAL_HOOK_TOOL, nextEvent);
  const successor = [...app.roots.values()][0].sessionUuid;
  assert.notEqual(successor, prior);
  assert.equal([...app.roots.values()][0].generation, 2);
  assert.deepEqual(
    decode(await adapter.handle(LOCAL_HOOK_TOOL, nextEvent)),
    {},
  );
  assert.equal([...app.roots.values()][0].sessionUuid, successor);
  assert.equal([...app.roots.values()][0].generation, 2);
});

test("PostToolUse observes only its exact acknowledged PreToolUse segment", async (t) => {
  const { adapter, app } = await rig(t);
  const opening = event();
  await adapter.handle(LOCAL_HOOK_TOOL, opening);
  const original = [...app.roots.values()][0].sessionUuid;
  const before = app.calls.length;
  await adapter.handle(LOCAL_HOOK_TOOL, {
    ...opening,
    eventName: "PostToolUse",
  });
  const mutations = app.calls
    .slice(before)
    .filter((call) => call.input.operation !== "status");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].input.operation, "observe");
  assert.equal(mutations[0].input.source, "tool");
  assert.equal(mutations[0].input.expectedSessionUuid, original);
  assert.equal([...app.roots.values()][0].generation, 1);
});

test("PostToolUse cannot begin a successor after the same tool's predecessor ends", async (t) => {
  const { adapter, app } = await rig(t);
  const opening = event();
  await adapter.handle(LOCAL_HOOK_TOOL, opening);
  const root = [...app.roots.values()][0];
  root.sessionState = "ABANDONED";
  const before = app.calls.length;
  const output = await adapter.handle(LOCAL_HOOK_TOOL, {
    ...opening,
    eventName: "PostToolUse",
  });
  assert.deepEqual(decode(output), {});
  assert.equal(
    app.calls.slice(before).filter((call) => call.input.operation !== "status")
      .length,
    0,
  );
  assert.equal([...app.roots.values()][0].sessionUuid, root.sessionUuid);
  assert.equal([...app.roots.values()][0].generation, 1);
  assert.equal([...app.roots.values()][0].sessionState, "ABANDONED");
});

test("a delayed PostToolUse cannot observe a successor created by different work", async (t) => {
  const { adapter, app } = await rig(t);
  const oldTool = event();
  await adapter.handle(LOCAL_HOOK_TOOL, oldTool);
  [...app.roots.values()][0].sessionState = "ABANDONED";
  await adapter.handle(LOCAL_HOOK_TOOL, event({ toolUseId: "successor-work" }));
  const successor = structuredClone([...app.roots.values()][0]);
  const before = app.calls.length;
  const output = await adapter.handle(LOCAL_HOOK_TOOL, {
    ...oldTool,
    eventName: "PostToolUse",
  });
  assert.deepEqual(decode(output), {});
  assert.equal(
    app.calls.slice(before).filter((call) => call.input.operation !== "status")
      .length,
    0,
  );
  assert.deepEqual([...app.roots.values()][0], successor);
});

test("an uncertain PostToolUse retains its frozen predecessor after restart and pre-receipt loss", async (t) => {
  const { adapter, app, directory, makeAdapter } = await rig(t);
  const opening = event();
  await adapter.handle(LOCAL_HOOK_TOOL, opening);
  const predecessor = [...app.roots.values()][0].sessionUuid;
  app.failAfterApply(2);
  const output = await adapter.handle(LOCAL_HOOK_TOOL, {
    ...opening,
    eventName: "PostToolUse",
  });
  assert.match(hookContext(output), /queued, not acknowledged/);
  const frozen = app.calls.find(
    (call) => call.input.operation === "observe",
  ).input;
  assert.equal(frozen.expectedSessionUuid, predecessor);

  const stateDirectory = path.join(directory, "recall-session-recording", "v1");
  for (const name of await fs.readdir(stateDirectory)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(stateDirectory, name);
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.receipts = [];
    await fs.writeFile(file, JSON.stringify(state));
  }
  [...app.roots.values()][0].sessionState = "ABANDONED";
  const restarted = makeAdapter();
  await restarted.catalog(catalog);
  await restarted.handle(
    LOCAL_HOOK_TOOL,
    event({ toolUseId: "new-work-after-restart" }),
  );
  const retries = app.calls.filter(
    (call) =>
      call.input.operation === "observe" &&
      call.input.eventDigest === frozen.eventDigest,
  );
  assert.equal(retries.length, 3);
  for (const retry of retries) assert.deepEqual(retry.input, frozen);
  assert.equal([...app.roots.values()][0].generation, 2);
  assert.notEqual([...app.roots.values()][0].sessionUuid, predecessor);
});

for (const receiptState of ["missing", "evicted", "legacy"]) {
  test(`PostToolUse with ${receiptState} PreToolUse evidence does not record fresh work`, async (t) => {
    const { adapter, app, directory } = await rig(t);
    const original = event();
    await adapter.handle(
      LOCAL_HOOK_TOOL,
      receiptState === "missing"
        ? event({ toolUseId: "other-observed-work" })
        : original,
    );
    if (receiptState === "evicted") {
      for (let index = 0; index < MAX_RECEIPTS; index++) {
        await adapter.handle(
          LOCAL_HOOK_TOOL,
          event({ toolUseId: `newer-work-${index}` }),
        );
      }
    }
    if (receiptState === "legacy") {
      const stateDirectory = path.join(
        directory,
        "recall-session-recording",
        "v1",
      );
      for (const name of await fs.readdir(stateDirectory)) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(stateDirectory, name);
        const state = JSON.parse(await fs.readFile(file, "utf8"));
        for (const receipt of state.receipts) delete receipt.sessionUuid;
        await fs.writeFile(file, JSON.stringify(state));
      }
    }
    const before = app.calls.length;
    const unchanged = structuredClone([...app.roots.values()][0]);
    const output = await adapter.handle(LOCAL_HOOK_TOOL, {
      ...original,
      eventName: "PostToolUse",
    });
    assert.deepEqual(decode(output), {});
    assert.equal(
      app.calls
        .slice(before)
        .filter((call) => call.input.operation !== "status").length,
      0,
    );
    assert.deepEqual([...app.roots.values()][0], unchanged);
  });
}

for (const pendingDeliveries of [
  undefined,
  { checkpoints: 2, closes: 1, scope: "this_device" },
]) {
  test(`an evicted predecessor receipt keeps the current segment and ${pendingDeliveries ? "reported" : "unknown"} delivery state`, async (t) => {
    const { adapter, app, directory } = await rig(t);
    const originalEvent = event();
    await adapter.handle(LOCAL_HOOK_TOOL, originalEvent);
    const predecessor = [...app.roots.values()][0];
    predecessor.sessionState = "ABANDONED";
    // Exercise actual receipt eviction, not a synthetic cache with no history.
    for (let index = 0; index < MAX_RECEIPTS; index++) {
      await adapter.handle(
        LOCAL_HOOK_TOOL,
        event({ toolUseId: `successor-edit-${index}` }),
      );
    }
    const current = [...app.roots.values()][0];
    assert.equal(current.generation, 2);
    const [receiptKey, originalReceipt] = [...app.receipts.entries()][0];
    app.receipts.set(receiptKey, {
      ...originalReceipt,
      status: "ended",
      sessionState: "ABANDONED",
      lastSequence: current.lastSequence,
      ...(pendingDeliveries ? { pendingDeliveries } : {}),
    });
    // Run-wide delivery coverage is separate from generation monotonicity.
    // The later receipt may report new counts or omit a previously known view.
    app.setPendingDeliveries({
      checkpoints: 0,
      closes: 0,
      scope: "this_device",
    });
    const beforeReplay = app.calls.length;
    const context = hookContext(
      await adapter.handle(LOCAL_HOOK_TOOL, originalEvent),
    );
    assert.equal(context.includes(current.sessionUuid), true);
    assert.equal(context.includes(predecessor.sessionUuid), false);
    if (pendingDeliveries) {
      assert.match(
        context,
        /2 pending checkpoint\(s\) and 1 pending close\(s\)/,
      );
    } else {
      assert.match(context, /delivery state is unavailable/);
    }
    assert.equal(
      app.calls
        .slice(beforeReplay)
        .filter((call) => call.input.operation === "begin").length,
      1,
    );
    const stateDirectory = path.join(
      directory,
      "recall-session-recording",
      "v1",
    );
    const states = await Promise.all(
      (await fs.readdir(stateDirectory)).map(async (name) =>
        JSON.parse(await fs.readFile(path.join(stateDirectory, name), "utf8")),
      ),
    );
    const state = states.find((value) => value.acknowledged);
    assert.equal(state.acknowledged.sessionUuid, current.sessionUuid);
    assert.deepEqual(state.acknowledged.pendingDeliveries, pendingDeliveries);
    assert.equal(state.pending.length, 0);
  });
}

test("distinct participants cannot adopt the parent's segment", async (t) => {
  const { adapter, app } = await rig(t);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  await adapter.handle(LOCAL_HOOK_TOOL, event({ participantId: "child-one" }));
  assert.equal(app.roots.size, 2);
  assert.equal(
    new Set([...app.roots.values()].map((root) => root.sessionUuid)).size,
    2,
  );
});

test("lost responses preserve the exact frozen request across adapter restart", async (t) => {
  const { adapter, app, makeAdapter, directory } = await rig(t);
  app.failAfterApply(2);
  assert.match(
    hookContext(await adapter.handle(LOCAL_HOOK_TOOL, event())),
    /queued, not acknowledged/,
  );
  const first = app.calls.find(
    (call) => call.input.operation === "begin",
  ).input;
  const restarted = makeAdapter();
  await restarted.catalog(catalog);
  await restarted.handle(
    LOCAL_HOOK_TOOL,
    event({ toolUseId: "later-work", turnId: "turn-two" }),
  );
  const retries = app.calls.filter(
    (call) =>
      call.input.eventDigest === first.eventDigest &&
      call.input.operation === "begin",
  );
  assert.ok(retries.length >= 3);
  for (const retry of retries) assert.deepEqual(retry.input, first);
  assert.equal(app.roots.size, 1);
  const stateDirectory = path.join(directory, "recall-session-recording", "v1");
  for (const name of await fs.readdir(stateDirectory)) {
    if (!name.endsWith(".json")) continue;
    const body = await fs.readFile(path.join(stateDirectory, name), "utf8");
    assert.equal(body.includes("conversation-one"), false);
    assert.equal(body.includes("/fixture/work"), false);
    assert.equal(
      (await fs.stat(path.join(stateDirectory, name))).mode & 0o077,
      0,
    );
  }
});

test("a changed principal never receives an old account's frozen outbox", async (t) => {
  const { adapter, app } = await rig(t);
  app.failAfterApply(2);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  const split = app.calls.length;
  app.setPrincipal("b".repeat(64));
  await adapter.handle(
    LOCAL_HOOK_TOOL,
    event({ toolUseId: "new-account-work" }),
  );
  const newMutations = app.calls
    .slice(split)
    .filter((call) => call.input.operation !== "status");
  assert.ok(newMutations.length > 0);
  assert.ok(
    newMutations.every(
      (call) => call.input.expectedPrincipalDigest === "b".repeat(64),
    ),
  );
  assert.ok(
    newMutations.every((call) => call.input.expectedSessionUuid === undefined),
  );
});

for (const recoveryAccount of ["same", "different"]) {
  test(`unread retry coverage stays unknown before ${recoveryAccount}-account recovery`, async (t) => {
    const stateAccesses = [];
    const { adapter, app, directory, makeAdapter } = await rig(t, {
      adapterOptions: {
        storeFactory: (stateDirectory) => {
          const store = new LifecycleStateStore(stateDirectory);
          return {
            withState(identity, callback) {
              stateAccesses.push(identity);
              return store.withState(identity, callback);
            },
          };
        },
      },
    });
    const begin = event({
      eventName: "ExplicitBegin",
      requestId: "queued-begin",
      toolName: null,
      toolUseId: null,
    });
    const statusEvent = event({
      eventName: "Status",
      toolName: null,
      toolUseId: null,
    });
    app.failAfterApply(2);
    const queued = decode(await adapter.handle(LOCAL_BEGIN_TOOL, begin));
    assert.equal(queued.status, "queued");
    assert.equal(queued.unresolvedLifecycleEvents, 1);

    const [runIdentity, diagnosticIdentity] = stateAccesses;
    const stateDirectory = path.join(
      directory,
      "recall-session-recording",
      "v1",
    );
    const runFile = path.join(stateDirectory, `${runIdentity}.json`);
    const diagnosticFile = path.join(
      stateDirectory,
      `${diagnosticIdentity}.json`,
    );
    const originalBytes = await fs.readFile(runFile);
    const originalRequest = JSON.parse(originalBytes).pending[0];
    const originalSessionUuid = [...app.roots.values()][0].sessionUuid;
    assert.equal(
      JSON.parse(await fs.readFile(diagnosticFile, "utf8")).diagnostic
        .retryState,
      "pending",
    );

    // A restarted adapter must authenticate before reading any account's queue.
    const restarted = makeAdapter();
    await restarted.catalog(catalog);
    const principal = (recoveryAccount === "same" ? "a" : "b").repeat(64);
    app.setPrincipal(principal);
    app.setStatusUnavailable(true);
    stateAccesses.length = 0;
    const beforeFailure = app.calls.length;
    const unavailable = decode(
      await restarted.handle(LOCAL_STATUS_TOOL, statusEvent),
    );
    assert.ok(
      app.calls
        .slice(beforeFailure)
        .every((call) => call.input.operation === "status"),
    );
    assert.deepEqual(stateAccesses, [diagnosticIdentity]);
    assert.deepEqual(await fs.readFile(runFile), originalBytes);
    assert.deepEqual(
      {
        status: unavailable.status,
        reasonCode: unavailable.reasonCode,
        hasQueueCount: Object.hasOwn(unavailable, "unresolvedLifecycleEvents"),
        retryState: JSON.parse(await fs.readFile(diagnosticFile, "utf8"))
          .diagnostic.retryState,
      },
      {
        status: "unavailable",
        reasonCode: "transport_unavailable",
        hasQueueCount: false,
        retryState: "unknown",
      },
    );

    app.setStatusUnavailable(false);
    stateAccesses.length = 0;
    const beforeStatus = app.calls.length;
    const recovered = decode(
      await restarted.handle(LOCAL_STATUS_TOOL, statusEvent),
    );
    assert.equal(recovered.principalDigest, principal);
    assert.equal(
      recovered.unresolvedLifecycleEvents,
      recoveryAccount === "same" ? 1 : 0,
    );
    assert.equal(
      stateAccesses.includes(runIdentity),
      recoveryAccount === "same",
    );
    assert.ok(
      app.calls
        .slice(beforeStatus)
        .every((call) => call.input.operation === "status"),
    );
    assert.deepEqual(await fs.readFile(runFile), originalBytes);
    assert.equal(
      JSON.parse(await fs.readFile(diagnosticFile, "utf8")).diagnostic
        .retryState,
      recoveryAccount === "same" ? "pending" : "none",
    );

    if (recoveryAccount === "different") {
      stateAccesses.length = 0;
      const beforeOtherAccount = app.calls.length;
      const other = decode(
        await restarted.handle(LOCAL_BEGIN_TOOL, {
          ...begin,
          requestId: "other-account-work",
        }),
      );
      assert.equal(other.status, "recording");
      assert.equal(other.unresolvedLifecycleEvents, 0);
      assert.notEqual(other.sessionUuid, originalSessionUuid);
      assert.equal(stateAccesses.includes(runIdentity), false);
      assert.ok(
        app.calls
          .slice(beforeOtherAccount)
          .filter((call) => call.input.operation !== "status")
          .every((call) => call.input.expectedPrincipalDigest === principal),
      );
      assert.deepEqual(await fs.readFile(runFile), originalBytes);
      app.setPrincipal("a".repeat(64));
    }

    // The original account can settle only its exact previously frozen request.
    const beforeReplay = app.calls.length;
    const settled = decode(await restarted.handle(LOCAL_BEGIN_TOOL, begin));
    assert.equal(settled.status, "recording");
    assert.equal(settled.sessionUuid, originalSessionUuid);
    assert.equal(settled.unresolvedLifecycleEvents, 0);
    assert.deepEqual(
      app.calls
        .slice(beforeReplay)
        .filter((call) => call.input.operation !== "status")
        .map((call) => call.input),
      [originalRequest],
    );
    assert.equal(
      JSON.parse(await fs.readFile(runFile, "utf8")).pending.length,
      0,
    );
    assert.equal(
      JSON.parse(await fs.readFile(diagnosticFile, "utf8")).diagnostic
        .retryState,
      "none",
    );
  });
}

test("an authorized queued reservation replays frozen bytes and is never an acknowledgement", async (t) => {
  const { adapter, app, makeAdapter } = await rig(t);
  app.reserveNextBegin();
  assert.match(
    hookContext(await adapter.handle(LOCAL_HOOK_TOOL, event())),
    /queued, not acknowledged/,
  );
  const first = app.calls.find(
    (call) => call.input.operation === "begin",
  ).input;
  const reserved = [...app.roots.values()][0].sessionUuid;
  const restarted = makeAdapter();
  await restarted.catalog(catalog);
  await restarted.handle(
    LOCAL_HOOK_TOOL,
    event({ toolUseId: "after-restart" }),
  );
  const retries = app.calls.filter(
    (call) =>
      call.input.operation === "begin" &&
      call.input.eventDigest === first.eventDigest,
  );
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[1].input, first);
  assert.equal([...app.roots.values()][0].sessionUuid, reserved);
  assert.equal([...app.roots.values()][0].phase, "recording");
});

test("a new begin recovers the same reservation after local state loss", async (t) => {
  const { adapter, app, makeAdapter, directory } = await rig(t);
  app.reserveNextBegin();
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  const reserved = [...app.roots.values()][0].sessionUuid;
  await fs.rm(path.join(directory, "recall-session-recording"), {
    recursive: true,
  });
  const restarted = makeAdapter();
  await restarted.catalog(catalog);
  const status = decode(
    await restarted.handle(LOCAL_STATUS_TOOL, event({ eventName: "Status" })),
  );
  assert.equal(status.status, "queued");
  const before = app.calls.length;
  await restarted.handle(
    LOCAL_HOOK_TOOL,
    event({ eventName: "UserPromptSubmit", toolUseId: null, toolName: null }),
  );
  assert.ok(
    app.calls.slice(before).every((call) => call.input.operation === "status"),
  );
  await restarted.handle(
    LOCAL_HOOK_TOOL,
    event({ toolUseId: "recover-reservation" }),
  );
  const recovery = app.calls
    .filter((call) => call.input.operation === "begin")
    .at(-1).input;
  assert.equal(recovery.expectedSessionUuid, reserved);
  assert.equal(recovery.sequence, 2);
  assert.equal([...app.roots.values()][0].sessionUuid, reserved);
  assert.equal([...app.roots.values()][0].generation, 1);
});

test("parallel duplicate events serialize one begin and never roll back its acknowledgement", async (t) => {
  const { adapter, app, makeAdapter } = await rig(t);
  const second = makeAdapter();
  await second.catalog(catalog);
  await Promise.all([
    adapter.handle(LOCAL_HOOK_TOOL, event()),
    second.handle(LOCAL_HOOK_TOOL, event()),
  ]);
  assert.equal(
    app.calls.filter((call) => call.input.operation === "begin").length,
    1,
  );
  const result = decode(
    await second.handle(LOCAL_STATUS_TOOL, event({ eventName: "Status" })),
  );
  assert.equal(result.status, "recording");
});

test("local state loss raises only the allocator floor, never an existing queued sequence", async (t) => {
  const { adapter, app, makeAdapter, directory } = await rig(t);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  await adapter.handle(LOCAL_HOOK_TOOL, event({ toolUseId: "second-edit" }));
  await fs.rm(path.join(directory, "recall-session-recording"), {
    recursive: true,
  });
  const restarted = makeAdapter();
  await restarted.catalog(catalog);
  await restarted.handle(LOCAL_HOOK_TOOL, event({ toolUseId: "third-edit" }));
  assert.deepEqual(
    app.calls
      .filter((call) => call.input.operation === "begin")
      .map((call) => call.input.sequence),
    [1, 2, 3],
  );
  assert.equal(app.roots.size, 1);
});

test("corrupted frozen envelopes and substituted scopes are rejected before replay", async (t) => {
  const { adapter, app, makeAdapter, directory } = await rig(t);
  app.failAfterApply(2);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  const stateDirectory = path.join(directory, "recall-session-recording", "v1");
  const stateFile = (
    await Promise.all(
      (await fs.readdir(stateDirectory))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const file = path.join(stateDirectory, name);
          return { file, value: JSON.parse(await fs.readFile(file, "utf8")) };
        }),
    )
  ).find((item) => item.value.pending.length);
  const original = structuredClone(stateFile.value);
  for (const change of [
    (request) => {
      request.text = "must never reach tools/call";
    },
    (request) => {
      request.workspaceId = "different-workspace";
    },
  ]) {
    const altered = structuredClone(original);
    change(altered.pending[0]);
    await fs.writeFile(stateFile.file, JSON.stringify(altered), {
      mode: 0o600,
    });
    const restarted = makeAdapter();
    await restarted.catalog(catalog);
    const before = app.calls.length;
    assert.match(
      hookContext(
        await restarted.handle(
          LOCAL_HOOK_TOOL,
          event({ toolUseId: "later-edit" }),
        ),
      ),
      /state_unavailable/,
    );
    assert.ok(
      app.calls
        .slice(before)
        .every((call) => call.input.operation === "status"),
    );
  }
});

test("a stalled native call returns within the event budget with frozen work still pending", async (t) => {
  const app = fakeApp();
  const calls = app.call;
  app.call = (tool, input) =>
    input.operation === "status" ? calls(tool, input) : new Promise(() => {});
  const { adapter, directory } = await rig(t, {
    app,
    adapterOptions: { eventTimeoutMs: 80, requestTimeoutMs: 30 },
  });
  const start = Date.now();
  assert.match(
    hookContext(await adapter.handle(LOCAL_HOOK_TOOL, event())),
    /queued, not acknowledged/,
  );
  assert.ok(Date.now() - start < 600);
  const files = await fs.readdir(
    path.join(directory, "recall-session-recording", "v1"),
  );
  assert.ok(files.some((name) => name.endsWith(".json")));
});

test("routing rejects unavailable repositories and never tries the default after no match", async (t) => {
  const { adapter, app } = await rig(t, {
    repository: {
      kind: "present",
      remoteUrl: "https://github.com/example/project.git",
      repoRootBasename: "project",
    },
  });
  app.setResolution({ match: "none" });
  assert.match(
    hookContext(await adapter.handle(LOCAL_HOOK_TOOL, event())),
    /project_unresolved/,
  );
  assert.deepEqual(
    app.calls.map((call) => call.tool),
    ["resolve_project"],
  );
  for (const remote of [
    "/tmp/project",
    "file:///tmp/project",
    "https://token@github.com/example/project",
    "https://github.com/example/project?token=secret",
    "ssh://git@localhost/project",
  ])
    assert.equal(sanitizedRemote(remote), null);
  assert.equal(
    sanitizedRemote("git@github.com:example/project.git"),
    "ssh://git@github.com/example/project.git",
  );
});

test("status is read-only and cached diagnostics contain no account or session identity", async (t) => {
  const { adapter, app, directory } = await rig(t);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  const before = app.calls.length;
  const result = decode(
    await adapter.handle(
      LOCAL_STATUS_TOOL,
      event({ eventName: "Status", toolUseId: null, toolName: null }),
    ),
  );
  assert.equal(result.status, "recording");
  assert.ok(
    app.calls.slice(before).every((call) => call.input.operation === "status"),
  );
  const diagnostics = [];
  for (const name of await fs.readdir(
    path.join(directory, "recall-session-recording", "v1"),
  )) {
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(
      await fs.readFile(
        path.join(directory, "recall-session-recording", "v1", name),
        "utf8",
      ),
    );
    if (value.diagnostic) diagnostics.push(value.diagnostic);
  }
  assert.equal(diagnostics.length, 1);
  assert.equal(Object.hasOwn(diagnostics[0], "sessionUuid"), false);
  assert.equal(Object.hasOwn(diagnostics[0], "principalDigest"), false);
});

test("only explicit /clear end is eligible, and shutdown output never steers", async (t) => {
  const { adapter, app } = await rig(t);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  for (const endReason of ["resume", "other", "prompt_input_exit"]) {
    assert.deepEqual(
      decode(
        await adapter.handle(
          LOCAL_HOOK_TOOL,
          event({
            eventName: "SessionEnd",
            toolUseId: null,
            toolName: null,
            endReason,
          }),
        ),
      ),
      {},
    );
    assert.equal([...app.roots.values()][0].sessionState, "ACTIVE");
  }
  assert.deepEqual(
    decode(
      await adapter.handle(
        LOCAL_HOOK_TOOL,
        event({
          eventName: "SessionEnd",
          toolUseId: null,
          toolName: null,
          endReason: "clear",
        }),
      ),
    ),
    {},
  );
  assert.equal([...app.roots.values()][0].sessionState, "ABANDONED");
});

test("successor acknowledgement keeps predecessor checkpoint and close uncertainty visible", async (t) => {
  const { adapter, app } = await rig(t);
  const unknown = decode(
    await adapter.handle(LOCAL_STATUS_TOOL, event({ eventName: "Status" })),
  );
  assert.equal(unknown.pendingDeliveriesAvailable, false);
  assert.equal(unknown.pendingDeliveries, undefined);
  await adapter.handle(LOCAL_HOOK_TOOL, event());
  [...app.roots.values()][0].sessionState = "ABANDONED";
  app.setPendingDeliveries({ checkpoints: 2, closes: 1, scope: "this_device" });
  const context = hookContext(
    await adapter.handle(
      LOCAL_HOOK_TOOL,
      event({ toolUseId: "successor-edit" }),
    ),
  );
  assert.match(context, /2 pending checkpoint\(s\) and 1 pending close\(s\)/);
  assert.match(context, /including predecessors/);
  assert.match(context, /not checkpoint or outcome prose/);
  const current = decode(
    await adapter.handle(LOCAL_STATUS_TOOL, event({ eventName: "Status" })),
  );
  assert.equal(current.segmentGeneration, 2);
  assert.equal(current.pendingDeliveriesAvailable, true);
  assert.equal(current.pendingDeliveries.checkpoints, 2);
});

test("state locks reject symlinks and preserve incomplete pending state", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-lifecycle-state-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = "f".repeat(64);
  await fs.symlink("/tmp", path.join(directory, `${identity}.lock`));
  await assert.rejects(
    new LifecycleStateStore(directory).withState(identity, () => {}),
    /state_unavailable/,
  );
});

test("concurrent dead-owner recovery never steals the replacement live lock", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-lifecycle-lock-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = "f".repeat(64);
  const lock = path.join(directory, `${identity}.lock`);
  await fs.mkdir(lock, { mode: 0o700 });
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "dead-owner" }),
    { mode: 0o600 },
  );
  let active = 0;
  let maximum = 0;
  let count = 0;
  const enter = async (state, save) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await save();
    count++;
    active--;
  };
  const options = { processAlive: (pid) => pid === process.pid };
  await Promise.all([
    new LifecycleStateStore(directory, options).withState(identity, enter),
    new LifecycleStateStore(directory, options).withState(identity, enter),
  ]);
  assert.equal(count, 2);
  assert.equal(maximum, 1);
});

const version6Config = {
  version: 6,
  projectMemory: {
    enabled: true,
    defaultProject: {
      workspace: { id: "workspace-one", name: "Workspace" },
      recallProject: { id: "project-one", name: "Project" },
    },
  },
  sessionLifecycle: { enabled: true },
};

test("v6 config is exact, separate from older modes, and disabled by default", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-lifecycle-config-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: directory };
  assert.equal((await readLifecycleConfig("claude-code", env)).enabled, false);
  const file = path.join(directory, "recall-journal.json");
  await fs.writeFile(
    file,
    JSON.stringify({ version: 5, projectMemory: version6Config.projectMemory }),
  );
  assert.equal((await readLifecycleConfig("claude-code", env)).enabled, false);
  await fs.writeFile(file, JSON.stringify(version6Config));
  assert.deepEqual(
    (await readLifecycleConfig("claude-code", env)).defaultProject,
    { workspaceId: "workspace-one", projectUuid: "project-one" },
  );
  for (const value of [
    { ...version6Config, global: {} },
    { ...version6Config, sessionLifecycle: { enabled: true, unknown: true } },
  ]) {
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(
      readLifecycleConfig("claude-code", env),
      /config_invalid/,
    );
  }
});

test("v6 prompt context names explicit begin/status and rejects unproved or malformed participants", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-lifecycle-context-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "recall-journal.json"),
    JSON.stringify(version6Config),
  );
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "context-session",
  };
  const env = { CLAUDE_CONFIG_DIR: directory, CODEX_HOME: directory };
  const context = (await lifecycleContext(input, "claude-code", env))
    .hookSpecificOutput.additionalContext;
  assert.match(context, /begin_session_recording/);
  assert.match(context, /get_session_recording_status/);
  assert.match(context, /Stop is only a yield/);
  assert.match(
    (await lifecycleContext(input, "codex", env)).hookSpecificOutput
      .additionalContext,
    /participant identity/,
  );
  assert.match(
    (
      await lifecycleContext(
        { ...input, agent_id: "${agent_id}" },
        "claude-code",
        env,
      )
    ).hookSpecificOutput.additionalContext,
    /participant identity/,
  );
  const conversation = lifecycleDigest(
    "conversation",
    "claude-code",
    input.session_id,
  );
  const participant = lifecycleDigest(
    "participant",
    "claude-code",
    input.session_id,
    "main",
  );
  const key = lifecycleDigest(
    "diagnostic",
    "claude-code",
    conversation,
    participant,
  );
  const stateDirectory = path.join(directory, "recall-session-recording", "v1");
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(stateDirectory, `${key}.json`),
    JSON.stringify({ diagnostic: { reasonCode: "UNTRUSTED_INSTRUCTION" } }),
    { mode: 0o600 },
  );
  assert.doesNotMatch(
    (await lifecycleContext(input, "claude-code", env)).hookSpecificOutput
      .additionalContext,
    /UNTRUSTED_INSTRUCTION/,
  );
});

test("opt-in profiles expose only metadata and never register SessionStart or a Codex shutdown MCP hook", () => {
  for (const host of ["claude-code", "codex"]) {
    const profile = lifecycleHookProfile(host);
    assert.equal(profile.hooks.SessionStart, undefined);
    if (host === "codex") assert.equal(profile.hooks.SessionEnd, undefined);
    for (const [eventName, groups] of Object.entries(profile.hooks)) {
      for (const group of groups)
        for (const handler of group.hooks) {
          assert.equal(handler.type, "mcp_tool");
          assert.equal(handler.tool, LOCAL_HOOK_TOOL);
          assert.equal(handler.input.eventName, eventName);
          assert.equal(
            handler.server,
            host === "claude-code" ? "plugin:recall:recall" : "recall",
          );
          for (const field of [
            "prompt",
            "transcript_path",
            "tool_input",
            "tool_response",
            "command",
          ])
            assert.equal(Object.hasOwn(handler.input, field), false);
        }
    }
    const command = spawnSync(
      process.execPath,
      [
        new URL(
          "../plugins/recall/hooks/session-lifecycle-profiles.mjs",
          import.meta.url,
        ).pathname,
        "--host",
        host,
      ],
      { encoding: "utf8", timeout: 1000 },
    );
    assert.equal(command.status, 0);
    assert.deepEqual(JSON.parse(command.stdout), profile);
  }
});

test("repository discovery uses defaults only outside an actual repository and strips environment routing overrides", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-lifecycle-repo-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await inspectRepository(directory), { kind: "absent" });
  await fs.writeFile(
    path.join(directory, ".git"),
    "gitdir: /fixture/not-read-by-this-test\n",
  );
  let invocation;
  const repository = await inspectRepository(directory, {
    env: {
      GIT_DIR: "/unrelated",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "remote.origin.url",
      GIT_CONFIG_VALUE_0: "https://bad.example/remote",
    },
    execute: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "git@github.com:example/repository.git\n" };
    },
  });
  assert.deepEqual(repository, {
    kind: "present",
    remoteUrl: "ssh://git@github.com/example/repository.git",
  });
  assert.equal(invocation.command, "git");
  assert.equal(invocation.options.env.GIT_DIR, undefined);
  assert.equal(invocation.options.env.GIT_CONFIG_VALUE_0, undefined);
  await assert.rejects(
    inspectRepository(directory, {
      execute: async () => {
        throw new Error("no remote");
      },
    }),
    /repository_unavailable/,
  );
});

test("repository routing never adopts an origin supplied only by global Git config", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-lifecycle-global-config-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const globalConfig = path.join(directory, "global.gitconfig");
  await fs.writeFile(
    globalConfig,
    '[remote "origin"]\n\turl = https://global.example/other-project.git\n',
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args) => {
    const result = spawnSync("git", ["-C", directory, ...args], {
      env,
      encoding: "utf8",
      timeout: 1000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  assert.equal(
    git("config", "--get", "remote.origin.url"),
    "https://global.example/other-project.git",
  );
  await assert.rejects(
    inspectRepository(directory, { env }),
    /repository_unavailable/,
  );
  git(
    "config",
    "--local",
    "remote.origin.url",
    "https://local.example/this-project.git",
  );
  assert.deepEqual(await inspectRepository(directory, { env }), {
    kind: "present",
    remoteUrl: "https://local.example/this-project.git",
  });
});

test("NDJSON framing handles split Unicode and fails closed on oversized or malformed frames", () => {
  const seen = [];
  const sizes = [];
  let failed = 0;
  const reader = new JsonLineReader(
    100,
    (value, bytes) => {
      seen.push(value);
      sizes.push(bytes);
    },
    () => failed++,
  );
  const frame = Buffer.from('{"text":"café"}\n');
  for (const byte of frame) reader.push(Buffer.from([byte]));
  assert.deepEqual(seen, [{ text: "café" }]);
  reader.push(Buffer.from('{"next":'));
  reader.push(Buffer.from('"line"}\n\n{}\n'));
  assert.deepEqual(seen, [{ text: "café" }, { next: "line" }, {}]);
  assert.deepEqual(sizes, [frame.length - 1, 15, 2]);
  reader.push(Buffer.alloc(101, 65));
  reader.push(Buffer.from("{}\n"));
  assert.equal(failed, 1);
  assert.equal(seen.length, 3);
});

async function transportRig(t, host, journalConfig) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "recall-session-transport-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "recall-journal.json"),
    JSON.stringify(journalConfig),
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal);
    child.emit("exit", null, signal);
    return true;
  };
  const messages = (stream) => {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    t.after(() => lines.close());
    return async () => {
      const next = await iterator.next();
      assert.equal(next.done, false);
      return JSON.parse(next.value);
    };
  };
  const nextHost = messages(output);
  const nextPeer = messages(child.stdin);
  const { rpc } = startSessionAdapter({
    argv: ["--host", host],
    input,
    output,
    env: { CLAUDE_CONFIG_DIR: directory, CODEX_HOME: directory },
    spawnProcess: () => child,
  });
  t.after(() => {
    rpc.close();
    for (const stream of [input, output, child.stdin, child.stdout])
      stream.destroy();
  });
  const sendHost = (value) => input.write(`${JSON.stringify(value)}\n`);
  const sendPeer = (value, suffix = "") => {
    const bytes = Buffer.from(`${JSON.stringify(value)}${suffix}\n`);
    for (let offset = 0; offset < bytes.length; offset += 65521)
      child.stdout.write(bytes.subarray(offset, offset + 65521));
    return bytes.length;
  };
  return { kills, nextHost, nextPeer, rpc, sendHost, sendPeer };
}

for (const host of ["claude-code", "codex"]) {
  for (const [mode, journalConfig, enabled] of [
    [
      "legacy v5",
      { version: 5, projectMemory: version6Config.projectMemory },
      false,
    ],
    [
      "v6 disabled",
      { ...version6Config, sessionLifecycle: { enabled: false } },
      false,
    ],
    ["v6 enabled", version6Config, true],
  ]) {
    test(
      `large full-note replies preserve the connection for ${host}, ${mode}`,
      { timeout: 5000 },
      async (t) => {
        const transport = await transportRig(t, host, journalConfig);
        transport.sendHost({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const listRequest = await transport.nextPeer();
        transport.sendPeer({
          jsonrpc: "2.0",
          id: listRequest.id,
          result: { tools: catalog },
        });
        const listed = await transport.nextHost();
        assert.equal(
          listed.result.tools.some((tool) => tool.name === LOCAL_BEGIN_TOOL),
          enabled,
        );

        const request = {
          jsonrpc: "2.0",
          id: "full-note-read",
          method: "tools/call",
          params: {
            name: "read_note",
            arguments: {
              noteType: "NamedNote",
              uuid: "large-note",
              format: "both",
            },
          },
        };
        transport.sendHost(request);
        const forwarded = await transport.nextPeer();
        assert.deepEqual(forwarded.params, request.params);
        const text = "Review notes. ".repeat(200_000) + '\ncafé "quoted" 📝';
        const result = jsonResult({
          noteType: "NamedNote",
          uuid: "large-note",
          title: "A large review note",
          href: "https://recall.example/notes/large-note",
          revision: "fixture-revision",
          text,
          html: `<p>${text}</p>`,
          tags: [],
          createdAt: 1,
          updatedAt: 1,
          workspace: { id: "workspace-one", name: "Workspace" },
        });
        const bytes = transport.sendPeer({
          jsonrpc: "2.0",
          id: forwarded.id,
          result,
        });
        assert.ok(bytes > MAX_LIFECYCLE_RESPONSE_BYTES);
        const received = await transport.nextHost();
        assert.equal(received.id, request.id);
        const digest = (value) =>
          createHash("sha256").update(JSON.stringify(value)).digest("hex");
        assert.equal(digest(received.result), digest(result));

        const notification = {
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        };
        transport.sendPeer(notification);
        assert.deepEqual(await transport.nextHost(), notification);
        transport.sendHost({ jsonrpc: "2.0", id: 2, method: "ping" });
        const ping = await transport.nextPeer();
        transport.sendPeer({ jsonrpc: "2.0", id: ping.id, result: {} });
        assert.deepEqual(await transport.nextHost(), {
          jsonrpc: "2.0",
          id: 2,
          result: {},
        });
        assert.deepEqual(transport.kills, []);
        assert.equal(transport.rpc.closed, false);
      },
    );
  }
}

test(
  "an oversized adapter-owned reply fails only its call and preserves the shared connection",
  { timeout: 5000 },
  async (t) => {
    const transport = await transportRig(t, "claude-code", version6Config);
    const rejected = assert.rejects(
      transport.rpc.call(APP_LIFECYCLE_TOOL, { operation: "status" }),
      /protocol_mismatch/,
    );
    const request = await transport.nextPeer();
    // JSON whitespace counts toward the wire budget even though parsing drops it.
    transport.sendPeer(
      {
        jsonrpc: "2.0",
        id: request.id,
        result: jsonResult({ status: "not_started" }),
      },
      " ".repeat(MAX_LIFECYCLE_RESPONSE_BYTES),
    );
    await rejected;
    transport.sendHost({
      jsonrpc: "2.0",
      id: "still-connected",
      method: "ping",
    });
    const ping = await transport.nextPeer();
    transport.sendPeer({ jsonrpc: "2.0", id: ping.id, result: {} });
    assert.deepEqual(await transport.nextHost(), {
      jsonrpc: "2.0",
      id: "still-connected",
      result: {},
    });
    const status = transport.rpc.call(APP_LIFECYCLE_TOOL, {
      operation: "status",
    });
    const retry = await transport.nextPeer();
    const result = jsonResult({ status: "not_started" });
    transport.sendPeer({ jsonrpc: "2.0", id: retry.id, result });
    assert.deepEqual(await status, result);
    assert.deepEqual(transport.kills, []);
    assert.equal(transport.rpc.closed, false);
  },
);

test("same-stream multiplexing cannot confuse client IDs and internal IDs", async () => {
  const peer = [];
  const host = [];
  const adapter = { handles: () => false, catalog: async () => [] };
  const rpc = new SessionRpcInterposer({
    adapter,
    sendPeer: (value) => peer.push(value),
    sendHost: (value) => host.push(value),
    timeoutMs: 100,
  });
  const internal = rpc.call("record_session_lifecycle", {
    operation: "status",
  });
  const internalId = peer[0].id;
  await rpc.fromHost({ jsonrpc: "2.0", id: internalId, method: "tools/list" });
  assert.notEqual(peer[1].id, internalId);
  await rpc.fromPeer({ jsonrpc: "2.0", id: peer[1].id, result: { tools: [] } });
  assert.equal(host[0].id, internalId);
  await rpc.fromPeer({
    jsonrpc: "2.0",
    id: internalId,
    result: { known: true },
  });
  assert.deepEqual(await internal, { known: true });
  assert.equal(host.length, 1);
  rpc.close();
});

test("ordinary cancellation and server-originated requests survive ID remapping", async () => {
  const peer = [];
  const host = [];
  const adapter = { handles: () => false, catalog: async () => [] };
  const rpc = new SessionRpcInterposer({
    adapter,
    sendPeer: (value) => peer.push(value),
    sendHost: (value) => host.push(value),
  });
  await rpc.fromHost({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "list_notes", arguments: {} },
  });
  const mapped = peer[0].id;
  await rpc.fromHost({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7 },
  });
  assert.equal(peer[1].params.requestId, mapped);
  await rpc.fromPeer({ jsonrpc: "2.0", id: mapped, result: {} });
  assert.equal(host.length, 0);
  const request = { jsonrpc: "2.0", id: "server-id", method: "ping" };
  await rpc.fromPeer(request);
  assert.deepEqual(host[0], request);
  const reply = { jsonrpc: "2.0", id: "server-id", result: {} };
  await rpc.fromHost(reply);
  assert.deepEqual(peer[2], reply);
  rpc.close();
});

test("a local lifecycle tool cannot mutate through a request without a valid ID", async () => {
  let calls = 0;
  const host = [];
  const rpc = new SessionRpcInterposer({
    adapter: {
      handles: () => true,
      handle: async () => {
        calls++;
        return {};
      },
    },
    sendPeer: () => {},
    sendHost: (value) => host.push(value),
  });
  await rpc.fromHost({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: LOCAL_BEGIN_TOOL, arguments: {} },
  });
  await rpc.fromHost({
    jsonrpc: "2.0",
    id: {},
    method: "tools/call",
    params: { name: LOCAL_BEGIN_TOOL, arguments: {} },
  });
  assert.equal(calls, 0);
  assert.equal(host[0].error.code, -32600);
  rpc.close();
});

test("old apps retain their original tools and only gain local read-only status", async (t) => {
  const { adapter } = await rig(t);
  const local = await adapter.catalog([{ name: "list_notes" }]);
  assert.deepEqual(
    local.map((tool) => tool.name),
    [LOCAL_STATUS_TOOL],
  );
  assert.equal(local[0].annotations.readOnlyHint, true);
  assert.equal(adapter.handles(LOCAL_BEGIN_TOOL), false);
});
