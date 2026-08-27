import path from "node:path";
import {
  APP_LIFECYCLE_TOOL,
  LOCAL_HOOK_TOOL,
  LOCAL_BEGIN_TOOL,
  LOCAL_STATUS_TOOL,
  LifecycleError,
  MAX_PENDING_EVENTS,
  MAX_RECEIPTS,
  appSupportsLifecycle,
  isDigest,
  isUuid,
  isOpeningTool,
  isObservedTool,
  lifecycleDigest,
  localToolDefinitions,
  validateAppResult,
  validateAppRequest,
  validateLocalEvent,
} from "./session-lifecycle-contract.mjs";
import {
  readLifecycleConfig,
  resolveLifecycleScope,
} from "./session-lifecycle-routing.mjs";
import { LifecycleStateStore } from "./session-lifecycle-state.mjs";

const HOOK_EVENTS_WITH_CONTEXT = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
]);
const TERMINAL_STATES = new Set(["CLOSED", "ABANDONED"]);
const unavailable = (reasonCode) => ({
  protocolVersion: 1,
  status: "unavailable",
  reasonCode,
});

function eventOperation(event) {
  if (event.eventName === "Status")
    return { operation: "status", source: "recovery" };
  if (event.eventName === "ExplicitBegin")
    return { operation: "begin", source: "explicit_begin" };
  if (["PreToolUse", "PostToolUse"].includes(event.eventName)) {
    if (
      event.eventName === "PreToolUse" &&
      isOpeningTool(event.host, event.toolName)
    )
      return { operation: "begin", source: "mutating_tool" };
    if (isObservedTool(event.host, event.toolName))
      return { operation: "observe", source: "tool" };
    throw new LifecycleError("unsupported_event");
  }
  if (event.eventName === "UserPromptSubmit")
    return { operation: "observe", source: "prompt" };
  if (event.eventName === "Stop") return { operation: "yield", source: "stop" };
  // /clear is an explicit conversation end. Switching/resuming or terminating a
  // host process alone is not proof that the conversation segment ended.
  if (
    event.host === "claude-code" &&
    event.eventName === "SessionEnd" &&
    event.endReason === "clear"
  )
    return { operation: "end", source: "session_end" };
  throw new LifecycleError("unsupported_event");
}

function publicStatus(result, pending, scope) {
  return {
    ...result,
    ...(scope ? { scope } : {}),
    adapterVersion: 1,
    // Only an authenticated run-state read can establish even an empty queue.
    ...(pending !== undefined ? { unresolvedLifecycleEvents: pending } : {}),
    pendingDeliveriesAvailable: result.pendingDeliveries !== undefined,
    coverage: "mutating_tools_or_explicit_begin",
    eventOrigin: "client_reported",
  };
}

function responseFor(name, eventName, result, { replayed = false } = {}) {
  if (name !== LOCAL_HOOK_TOOL)
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  // Never emit Stop feedback: Claude can treat even context as continuation.
  if (!HOOK_EVENTS_WITH_CONTEXT.has(eventName) || replayed)
    return { content: [{ type: "text", text: "{}" }] };
  let message;
  if (["recording", "yielded"].includes(result.status) && result.sessionUuid) {
    const scope = result.scope
      ? ` in workspaceId ${result.scope.workspaceId}, projectUuid ${result.scope.projectUuid}`
      : "";
    message = `Recall segment ${result.sessionUuid}${scope} is acknowledged. This acknowledges session recording, not checkpoint or outcome prose. Append checkpoints to that exact scope and sessionUuid and close that same session when the segment actually ends. Do not also call open_session. A new prompt or Stop does not end the segment.`;
  } else if (result.status === "not_started") {
    message =
      "No Recall segment is recording yet. The automatic pilot starts on an explicit edit/write tool only. For substantive reviews, investigation, shell-only, or reasoning work, use begin_session_recording with the exact lifecycle identity; do not call open_session separately.";
  } else if (result.status === "ended" && result.sessionUuid) {
    message = `Recall confirms that segment ${result.sessionUuid} has ended. A new segment has not been acknowledged. The next validated edit boundary or an explicit begin_session_recording for new substantive work can create its successor. Keep every uncertain checkpoint or close on its original UUID, idempotency key, and payload; confirming the predecessor's end does not confirm delivery. An eligible close can still finish that predecessor.`;
  } else if (result.reasonCode === "disabled") {
    return { content: [{ type: "text", text: "{}" }] };
  } else {
    message = `Recall recording is ${result.status === "queued" ? "queued, not acknowledged" : "unavailable"} (${result.reasonCode ?? "lifecycle_unavailable"}). Continue the user's work, disclose the recording status, and do not create a second v5 session as a workaround.`;
  }
  if (
    result.pendingDeliveries?.checkpoints > 0 ||
    result.pendingDeliveries?.closes > 0
  ) {
    message += ` This device still has ${result.pendingDeliveries.checkpoints} pending checkpoint(s) and ${result.pendingDeliveries.closes} pending close(s) for this run, including predecessors. They remain unresolved even if a successor is recording.`;
  } else if (result.pendingDeliveries === undefined)
    message +=
      " Checkpoint and close delivery state is unavailable; omission does not mean zero.";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: eventName,
            additionalContext: message,
          },
        }),
      },
    ],
  };
}

export class SessionLifecycleAdapter {
  constructor({
    host,
    call,
    env = process.env,
    clock = Date.now,
    inspectRepository,
    readConfig = readLifecycleConfig,
    storeFactory = (directory) => new LifecycleStateStore(directory, { clock }),
    eventTimeoutMs = 4000,
    requestTimeoutMs = 1500,
  }) {
    this.host = host;
    this.call = call;
    this.env = env;
    this.clock = clock;
    this.inspectRepository = inspectRepository;
    this.readConfig = readConfig;
    this.storeFactory = storeFactory;
    this.eventTimeoutMs = eventTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.capable = false;
    this.busy = 0;
    this.localNames = new Set();
  }

  async catalog(tools) {
    this.capable = appSupportsLifecycle(tools);
    let config;
    try {
      config = await this.readConfig(this.host, this.env);
    } catch {
      config = { enabled: false };
    }
    const names = new Set(tools.map((tool) => tool?.name));
    const local = localToolDefinitions(this.capable && config.enabled).filter(
      (tool) => !names.has(tool.name),
    );
    this.localNames = new Set(local.map((tool) => tool.name));
    return local;
  }

  handles(name) {
    return this.localNames.has(name);
  }

  async handle(name, input) {
    if (![LOCAL_HOOK_TOOL, LOCAL_BEGIN_TOOL, LOCAL_STATUS_TOOL].includes(name))
      throw new LifecycleError("unsupported_event");
    let event;
    let result;
    let replayed = false;
    let config;
    if (this.busy >= 16)
      return responseFor(
        name,
        input?.eventName,
        publicStatus(unavailable("queue_full")),
      );
    this.busy++;
    const deadline =
      Date.now() +
      Math.min(
        this.eventTimeoutMs,
        input?.eventName === "SessionEnd" ? 1000 : this.eventTimeoutMs,
      );
    const call = (tool, args) => this.callBefore(deadline, tool, args);
    try {
      config = await this.readConfig(this.host, this.env);
      if (!config.enabled)
        return responseFor(
          name,
          input?.eventName,
          publicStatus(unavailable("disabled")),
        );
      event = validateLocalEvent(input, this.host, config);
      if (name === LOCAL_BEGIN_TOOL && event.eventName !== "ExplicitBegin")
        throw new LifecycleError("invalid_event");
      if (name === LOCAL_STATUS_TOOL && event.eventName !== "Status")
        throw new LifecycleError("invalid_event");
      if (
        name === LOCAL_HOOK_TOOL &&
        ["Status", "ExplicitBegin"].includes(event.eventName)
      )
        throw new LifecycleError("invalid_event");
      const behavior = eventOperation(event);
      if (!this.capable) throw new LifecycleError("lifecycle_unavailable");
      const occurredAtMs = this.clock();
      const scope = await resolveLifecycleScope(
        event,
        config,
        call,
        this.inspectRepository,
      );
      const base = {
        protocolVersion: 1,
        ...scope,
        host: this.host,
        conversationDigest: event.conversationDigest,
        participantDigest: event.participantDigest,
        eventDigest: event.eventDigest,
      };
      // A fresh same-connection handshake precedes all local outbox access.
      // A remembered account, connection count, or prior session is not proof.
      const principal = validateAppResult(
        await call(APP_LIFECYCLE_TOOL, {
          ...base,
          operation: "status",
          source: "recovery",
          sequence: 1,
          occurredAtMs,
        }),
      );
      if (!isDigest(principal.principalDigest))
        throw new LifecycleError(principal.reasonCode ?? "scope_unavailable");
      if (["unavailable", "conflict"].includes(principal.status)) {
        await this.recordDiagnostic(config, event, principal);
        return responseFor(name, event.eventName, publicStatus(principal));
      }
      const identity = lifecycleDigest(
        "local-state",
        principal.principalDigest,
        this.host,
        event.conversationDigest,
        event.participantDigest,
        scope.workspaceId,
        scope.projectUuid,
      );
      const visibleStatus = (reply, pending) =>
        publicStatus(reply, pending, scope);
      const store = this.storeFactory(
        path.join(config.directory, "recall-session-recording", "v1"),
      );
      result = await store.withState(identity, async (state, save) => {
        // The account handshake can recover an acknowledged mapping after local
        // state loss. It never adopts an arbitrary ACTIVE lineage predecessor.
        this.remember(state, principal);
        state.nextSequence = Math.max(
          state.nextSequence,
          principal.lastSequence + 1,
        );
        if (!Number.isSafeInteger(state.nextSequence))
          throw new LifecycleError("state_unavailable");
        if (
          state.acknowledged &&
          state.acknowledged.principalDigest !== principal.principalDigest
        )
          throw new LifecycleError("principal_mismatch");
        if (behavior.operation === "status")
          return visibleStatus(principal, state.pending.length);

        // Replay bounded work within the hook deadline, never re-key a frozen
        // event. A lost response stays pending even on a healthy new socket.
        for (const pending of state.pending.slice(0, 4)) {
          if (pending.expectedPrincipalDigest !== principal.principalDigest)
            throw new LifecycleError("principal_mismatch");
          for (const key of [
            "host",
            "workspaceId",
            "projectUuid",
            "conversationDigest",
            "participantDigest",
          ]) {
            if (pending[key] !== base[key])
              throw new LifecycleError("state_unavailable");
          }
          const replay = await this.deliver(pending, call);
          if (!replay)
            return visibleStatus(
              { ...unavailable("delivery_pending"), status: "queued" },
              state.pending.length,
            );
          if (["unavailable", "conflict", "queued"].includes(replay.status))
            return visibleStatus(replay, state.pending.length);
          this.accept(state, pending, replay);
          await save();
        }
        if (state.pending.length)
          return visibleStatus(
            { ...unavailable("delivery_pending"), status: "queued" },
            state.pending.length,
          );

        if (
          state.receipts.some(
            (receipt) => receipt.eventDigest === event.eventDigest,
          )
        ) {
          replayed = true;
          return visibleStatus(
            state.acknowledged ?? principal,
            state.pending.length,
          );
        }
        const current = state.acknowledged;
        let postSessionUuid;
        if (event.eventName === "PostToolUse") {
          const preDigest = lifecycleDigest(
            "observation",
            event.host,
            event.conversationDigest,
            event.participantDigest,
            "PreToolUse",
            event.toolUseId,
            event.toolName,
          );
          const preReceipt = state.receipts.find(
            (receipt) => receipt.eventDigest === preDigest,
          );
          // Completion is not a new work boundary. A missing/evicted/legacy
          // receipt supplies no segment identity, and a delayed completion must
          // not follow a generic current-run pointer into a successor. Already
          // frozen post requests above still reconcile with their original IDs.
          if (
            !isUuid(preReceipt?.sessionUuid) ||
            preReceipt.sessionUuid !== current?.sessionUuid ||
            current.sessionState !== "ACTIVE"
          ) {
            replayed = true; // Suppress context as well as an uncorrelated write.
            return visibleStatus(current ?? principal, state.pending.length);
          }
          postSessionUuid = preReceipt.sessionUuid;
        }
        const reserved =
          principal.status === "queued" &&
          principal.sessionUuid &&
          (!current?.sessionUuid ||
            (current.segmentGeneration ?? 0) <
              (principal.segmentGeneration ?? 0));
        // A native reservation is not an acknowledged recording. Exact pending
        // retries above can finish it; after local state loss, an eligible begin
        // may recover the same reservation without creating a successor.
        if (reserved && behavior.operation !== "begin")
          return visibleStatus(principal, state.pending.length);
        if (
          behavior.operation !== "begin" &&
          (!current?.sessionUuid || TERMINAL_STATES.has(current.sessionState))
        ) {
          return visibleStatus(current ?? principal, state.pending.length);
        }
        if (state.pending.length >= MAX_PENDING_EVENTS)
          throw new LifecycleError("queue_full");
        const request = {
          ...base,
          ...behavior,
          occurredAtMs,
          sequence: state.nextSequence++,
          expectedPrincipalDigest: principal.principalDigest,
          ...(postSessionUuid
            ? { expectedSessionUuid: postSessionUuid }
            : reserved || current?.sessionUuid
              ? {
                  expectedSessionUuid: reserved
                    ? principal.sessionUuid
                    : current.sessionUuid,
                }
              : {}),
        };
        validateAppRequest(request, { queued: true });
        state.pending.push(Object.freeze(request));
        await save(); // Freeze identity, sequence, account, and bytes before IO.
        const accepted = await this.deliver(request, call);
        if (!accepted)
          return visibleStatus(
            { ...unavailable("delivery_pending"), status: "queued" },
            state.pending.length,
          );
        if (!["unavailable", "conflict", "queued"].includes(accepted.status)) {
          this.accept(state, request, accepted);
          await save();
          // A durable receipt can describe an older segment after local cache
          // eviction. Complete that event without routing new prose backward.
          return visibleStatus(
            state.acknowledged ?? accepted,
            state.pending.length,
          );
        }
        return visibleStatus(accepted, state.pending.length);
      });
    } catch (error) {
      result = publicStatus(
        unavailable(
          error instanceof LifecycleError
            ? error.reasonCode
            : "state_unavailable",
        ),
      );
    } finally {
      this.busy--;
    }
    await this.recordDiagnostic(config, event, result);
    return responseFor(name, event?.eventName ?? input?.eventName, result, {
      replayed,
    });
  }

  async recordDiagnostic(config, event, result) {
    if (!config?.enabled || !event || !result) return;
    try {
      const identity = lifecycleDigest(
        "diagnostic",
        this.host,
        event.conversationDigest,
        event.participantDigest,
      );
      const store = this.storeFactory(
        path.join(config.directory, "recall-session-recording", "v1"),
      );
      await store.withState(identity, async (state, save) => {
        // No account, session, Project, path, or host identifier is stored in
        // the account-unknown diagnostic. A cached success is never live proof.
        state.diagnostic = {
          protocolVersion: 1,
          adapterVersion: 1,
          status: result.status,
          reasonCode: result.reasonCode ?? null,
          observedAtMs: this.clock(),
          retryState:
            result.unresolvedLifecycleEvents === undefined
              ? "unknown"
              : result.unresolvedLifecycleEvents > 0
                ? "pending"
                : "none",
          stage: ["recording", "yielded", "ended"].includes(result.status)
            ? "acknowledged"
            : "unavailable",
        };
        await save();
      });
    } catch {
      /* Status persistence must never break the user's work. */
    }
  }

  async callBefore(deadline, tool, input) {
    const timeoutMs = Math.min(this.requestTimeoutMs, deadline - Date.now());
    if (timeoutMs <= 0) throw new LifecycleError("transport_unavailable");
    let timer;
    try {
      return await Promise.race([
        this.call(tool, input, { timeoutMs }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new LifecycleError("transport_unavailable")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async deliver(request, call) {
    validateAppRequest(request, { queued: true });
    // No retry is sent after a typed refusal. Transport uncertainty alone gets
    // one identical retry; a future event can resume the same frozen envelope.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = validateAppResult(
          await call(APP_LIFECYCLE_TOOL, request),
        );
        if (
          value.principalDigest &&
          value.principalDigest !== request.expectedPrincipalDigest
        )
          throw new LifecycleError("principal_mismatch");
        return value;
      } catch (error) {
        if (
          error instanceof LifecycleError &&
          error.reasonCode !== "transport_unavailable"
        )
          throw error;
      }
    }
    return null;
  }

  accept(state, request, result) {
    state.pending = state.pending.filter(
      (item) => item.eventDigest !== request.eventDigest,
    );
    state.receipts.push({
      eventDigest: request.eventDigest,
      sequence: request.sequence,
      ...(result.sessionUuid ? { sessionUuid: result.sessionUuid } : {}),
    });
    state.receipts = state.receipts.slice(-MAX_RECEIPTS);
    this.remember(state, result);
  }

  remember(state, result) {
    if (
      !["recording", "yielded", "ended", "not_started"].includes(result.status)
    )
      return;
    // An old request receipt must not roll the remembered generation backward.
    const nextGeneration = result.segmentGeneration ?? 0;
    const oldGeneration = state.acknowledged?.segmentGeneration ?? 0;
    const nextRevision = result.observationRevision ?? 0;
    const oldRevision = state.acknowledged?.observationRevision ?? 0;
    const sameRevision =
      nextGeneration === oldGeneration && nextRevision === oldRevision;
    if (
      !state.acknowledged ||
      nextGeneration > oldGeneration ||
      (nextGeneration === oldGeneration && nextRevision > oldRevision) ||
      (sameRevision &&
        !(
          TERMINAL_STATES.has(state.acknowledged.sessionState) &&
          result.sessionState === "ACTIVE"
        ) &&
        (result.lastSequence ?? 0) >= (state.acknowledged.lastSequence ?? 0))
    )
      state.acknowledged = result;
    // Delivery coverage describes the whole run on this device, not a segment
    // generation. Preserve the latest reply's omission as unknown rather than
    // retaining an earlier snapshot of apparently delivered prose.
    const acknowledged = { ...state.acknowledged };
    delete acknowledged.pendingDeliveries;
    state.acknowledged = {
      ...acknowledged,
      ...(result.pendingDeliveries === undefined
        ? {}
        : { pendingDeliveries: result.pendingDeliveries }),
    };
  }
}
