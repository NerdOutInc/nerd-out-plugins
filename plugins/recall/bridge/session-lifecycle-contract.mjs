import { createHash } from "node:crypto";

export const LIFECYCLE_PROTOCOL_VERSION = 1;
export const APP_LIFECYCLE_TOOL = "record_session_lifecycle";
export const LOCAL_HOOK_TOOL = "session_lifecycle_hook";
export const LOCAL_BEGIN_TOOL = "begin_session_recording";
export const LOCAL_STATUS_TOOL = "get_session_recording_status";
export const MAX_LOCAL_INPUT_BYTES = 16 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;
export const MAX_PENDING_EVENTS = 16;
export const MAX_RECEIPTS = 32;

export const REASON_CODES = Object.freeze([
  "disabled",
  "unsupported_host",
  "unsupported_event",
  "participant_unavailable",
  "invalid_event",
  "config_invalid",
  "repository_unavailable",
  "project_unresolved",
  "project_ambiguous",
  "project_not_ready",
  "scope_unavailable",
  "lifecycle_unavailable",
  "transport_unavailable",
  "protocol_mismatch",
  "state_unavailable",
  "state_busy",
  "queue_full",
  "delivery_pending",
  "receipt_conflict",
  "predecessor_terminal",
  "no_segment",
  "principal_mismatch",
]);

export class LifecycleError extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = "LifecycleError";
    this.reasonCode = REASON_CODES.includes(reasonCode)
      ? reasonCode
      : "protocol_mismatch";
  }
}

export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isToken = (value) =>
  typeof value === "string" && /^[\w.:-]{1,256}$/.test(value);
export const isDigest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isUuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
export const isSafeTime = (value) => Number.isSafeInteger(value) && value >= 0;

// The array encoding is intentional: concatenated identifiers are ambiguous.
// The app adds its authenticated-principal domain. These hashes never authorize.
export function lifecycleDigest(domain, ...parts) {
  return createHash("sha256")
    .update(JSON.stringify([`recall-session-adapter/v1/${domain}`, ...parts]))
    .digest("hex");
}

const automaticTools = Object.freeze({
  "claude-code": new Set(["Edit", "Write"]),
  codex: new Set(["apply_patch"]),
});
const observedTools = Object.freeze({
  "claude-code": new Set(["Edit", "Write", "Read", "Bash", "Glob", "Grep"]),
  codex: new Set(["apply_patch", "Bash", "read_file", "view_image"]),
});

export function isOpeningTool(host, name) {
  return automaticTools[host]?.has(name) === true;
}

export function isObservedTool(host, name) {
  return observedTools[host]?.has(name) === true;
}

const localProperties = Object.freeze({
  protocolVersion: { type: "integer", enum: [1] },
  host: { type: "string", enum: ["claude-code", "codex"] },
  eventName: {
    type: "string",
    enum: [
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "SessionEnd",
      "ExplicitBegin",
      "Status",
    ],
  },
  cwd: { type: "string", minLength: 1, maxLength: 4096 },
  conversationId: { type: "string", minLength: 1, maxLength: 256 },
  participantId: { type: ["string", "null"], maxLength: 256 },
  turnId: { type: ["string", "null"], maxLength: 256 },
  toolUseId: { type: ["string", "null"], maxLength: 256 },
  toolName: { type: ["string", "null"], maxLength: 128 },
  requestId: { type: ["string", "null"], maxLength: 256 },
  endReason: {
    type: ["string", "null"],
    enum: [null, "clear", "resume", "logout", "prompt_input_exit", "other"],
  },
});

export function localToolDefinitions(canWrite) {
  const definition = (name, description, readOnlyHint) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: localProperties,
      required: [
        "protocolVersion",
        "host",
        "eventName",
        "cwd",
        "conversationId",
      ],
    },
    annotations: {
      readOnlyHint,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });
  const status = definition(
    LOCAL_STATUS_TOOL,
    "Inspect this exact host run's Recall recording status. Use only the identity supplied by the lifecycle hook; no transcript, prompt, shell body, or guessed participant. This local adapter does not read arbitrary files.",
    true,
  );
  if (!canWrite) return [status];
  return [
    definition(
      LOCAL_HOOK_TOOL,
      "Receives bounded lifecycle metadata from configured hooks on this existing Recall connection. Event origin is client-reported, not independently attested; this is an ordinary authorized MCP tool, not a host-only endpoint. Agents must use begin_session_recording or get_session_recording_status instead of synthesizing hook events. Stop observes yield and never closes a segment.",
      false,
    ),
    definition(
      LOCAL_BEGIN_TOOL,
      "Explicitly begin or resume recording substantive read-only, shell-only, or reasoning work in this exact conversation segment. Use ExplicitBegin and a stable caller-minted requestId; never call open_session alongside this adapter.",
      false,
    ),
    status,
  ];
}

export function validateLocalEvent(
  value,
  expectedHost,
  { codexParticipantVerified = false } = {},
) {
  if (
    !isObject(value) ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_LOCAL_INPUT_BYTES ||
    Object.keys(value).some((key) => !Object.hasOwn(localProperties, key)) ||
    value.protocolVersion !== 1 ||
    value.host !== expectedHost ||
    !automaticTools[value.host] ||
    !localProperties.eventName.enum.includes(value.eventName) ||
    typeof value.cwd !== "string" ||
    value.cwd.length === 0 ||
    value.cwd.length > 4096 ||
    value.cwd.includes("\0") ||
    !isToken(value.conversationId)
  )
    throw new LifecycleError("invalid_event");
  for (const key of [
    "participantId",
    "turnId",
    "toolUseId",
    "toolName",
    "requestId",
  ]) {
    if (value[key] !== undefined && value[key] !== null && !isToken(value[key]))
      throw new LifecycleError("invalid_event");
  }
  if (value.toolName?.length > 128) throw new LifecycleError("invalid_event");
  if (
    value.endReason !== undefined &&
    !localProperties.endReason.enum.includes(value.endReason)
  )
    throw new LifecycleError("invalid_event");

  // Claude documents absence of agent_id as the main participant. Codex's
  // ordinary tool-event participant behavior must pass a real-host probe before
  // that same interpretation can be enabled. Never adopt a parent by guessing.
  let participant = value.participantId;
  if (!participant) {
    if (expectedHost === "claude-code" || codexParticipantVerified)
      participant = "main";
    else throw new LifecycleError("participant_unavailable");
  }
  const conversationDigest = lifecycleDigest(
    "conversation",
    expectedHost,
    value.conversationId,
  );
  const participantDigest = lifecycleDigest(
    "participant",
    expectedHost,
    value.conversationId,
    participant,
  );
  const eventIdentity = value.toolUseId ?? value.requestId ?? value.turnId;
  if (!eventIdentity && value.eventName !== "Status")
    throw new LifecycleError("invalid_event");
  if (
    ["PreToolUse", "PostToolUse"].includes(value.eventName) &&
    (!value.toolUseId || !value.toolName)
  )
    throw new LifecycleError("invalid_event");
  if (value.eventName === "ExplicitBegin" && !value.requestId)
    throw new LifecycleError("invalid_event");
  return {
    ...value,
    conversationDigest,
    participantDigest,
    eventDigest: lifecycleDigest(
      "observation",
      expectedHost,
      conversationDigest,
      participantDigest,
      value.eventName,
      eventIdentity ?? "status",
      value.toolName ?? null,
    ),
  };
}

export function appSupportsLifecycle(tools) {
  const tool = Array.isArray(tools)
    ? tools.find((item) => item?.name === APP_LIFECYCLE_TOOL)
    : undefined;
  const schema = tool?.inputSchema;
  if (!isObject(schema?.properties) || !Array.isArray(schema.required))
    return false;
  const required = [
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
  if (
    required.some(
      (key) =>
        !schema.required.includes(key) ||
        !Object.hasOwn(schema.properties, key),
    )
  )
    return false;
  if (schema.required.some((key) => !required.includes(key))) return false;
  if (
    !Object.hasOwn(schema.properties, "expectedSessionUuid") ||
    !Object.hasOwn(schema.properties, "expectedPrincipalDigest")
  )
    return false;
  for (const key of [
    ...required,
    "expectedSessionUuid",
    "expectedPrincipalDigest",
  ]) {
    const type = ["protocolVersion", "sequence", "occurredAtMs"].includes(key)
      ? "integer"
      : "string";
    if (schema.properties[key]?.type !== type) return false;
  }
  return (
    schema.properties.protocolVersion?.enum?.includes(1) === true &&
    ["claude-code", "codex"].every((host) =>
      schema.properties.host?.enum?.includes(host),
    ) &&
    [
      "mutating_tool",
      "explicit_begin",
      "prompt",
      "tool",
      "stop",
      "session_end",
      "recovery",
    ].every((source) => schema.properties.source?.enum?.includes(source)) &&
    ["begin", "observe", "yield", "end", "status"].every((operation) =>
      schema.properties.operation?.enum?.includes(operation),
    )
  );
}

const appRequestKeys = [
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
  "expectedSessionUuid",
  "expectedPrincipalDigest",
];
const operationSources = Object.freeze({
  status: ["recovery"],
  begin: ["mutating_tool", "explicit_begin"],
  observe: ["tool", "prompt"],
  yield: ["stop"],
  end: ["session_end"],
});

// Also validates frozen outbox envelopes before replay. Local state is not a
// trusted extension of tools/call: extra keys and scope substitutions fail shut.
export function validateAppRequest(value, { queued = false } = {}) {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !appRequestKeys.includes(key)) ||
    value.protocolVersion !== 1 ||
    !Object.hasOwn(operationSources, value.operation) ||
    !operationSources[value.operation].includes(value.source) ||
    !["claude-code", "codex"].includes(value.host) ||
    !isToken(value.workspaceId) ||
    value.workspaceId.length > 128 ||
    !isToken(value.projectUuid) ||
    value.projectUuid.length > 128 ||
    ![
      value.conversationDigest,
      value.participantDigest,
      value.eventDigest,
    ].every(isDigest) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !isSafeTime(value.occurredAtMs) ||
    (value.expectedSessionUuid !== undefined &&
      !isUuid(value.expectedSessionUuid)) ||
    (value.expectedPrincipalDigest !== undefined &&
      !isDigest(value.expectedPrincipalDigest)) ||
    (value.operation !== "status" &&
      !isDigest(value.expectedPrincipalDigest)) ||
    (!["begin", "status"].includes(value.operation) &&
      !isUuid(value.expectedSessionUuid)) ||
    (queued && value.operation === "status")
  )
    throw new LifecycleError("state_unavailable");
  return value;
}

export function parseToolResult(result) {
  if (!isObject(result) || result.isError === true)
    throw new LifecycleError("scope_unavailable");
  if (isObject(result.structuredContent)) {
    if (
      Buffer.byteLength(JSON.stringify(result.structuredContent)) >
      MAX_STATE_BYTES
    )
      throw new LifecycleError("protocol_mismatch");
    return result.structuredContent;
  }
  const texts = result.content?.filter(
    (item) => item?.type === "text" && typeof item.text === "string",
  );
  if (texts?.length !== 1 || Buffer.byteLength(texts[0].text) > MAX_STATE_BYTES)
    throw new LifecycleError("protocol_mismatch");
  try {
    return JSON.parse(texts[0].text);
  } catch {
    throw new LifecycleError("protocol_mismatch");
  }
}

export function validateAppResult(result) {
  const value = parseToolResult(result);
  const statuses = [
    "recording",
    "yielded",
    "ended",
    "not_started",
    "queued",
    "unavailable",
    "conflict",
  ];
  if (
    !isObject(value) ||
    value.protocolVersion !== 1 ||
    !statuses.includes(value.status)
  )
    throw new LifecycleError("protocol_mismatch");
  const allowed = [
    "protocolVersion",
    "status",
    "sessionUuid",
    "segmentGeneration",
    "observationRevision",
    "sessionState",
    "reasonCode",
    "principalDigest",
    "lastSequence",
    "pendingDeliveries",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new LifecycleError("protocol_mismatch");
  if (value.sessionUuid !== undefined && !isUuid(value.sessionUuid))
    throw new LifecycleError("protocol_mismatch");
  if (value.principalDigest !== undefined && !isDigest(value.principalDigest))
    throw new LifecycleError("protocol_mismatch");
  if (
    value.sessionState !== undefined &&
    !["ACTIVE", "CLOSED", "ABANDONED"].includes(value.sessionState)
  )
    throw new LifecycleError("protocol_mismatch");
  if (
    value.reasonCode !== undefined &&
    !REASON_CODES.includes(value.reasonCode)
  )
    throw new LifecycleError("protocol_mismatch");
  if (value.pendingDeliveries !== undefined) {
    const pending = value.pendingDeliveries;
    if (
      !isObject(pending) ||
      Object.keys(pending).some(
        (key) => !["checkpoints", "closes", "scope"].includes(key),
      ) ||
      ![pending.checkpoints, pending.closes].every(isSafeTime) ||
      pending.scope !== "this_device"
    )
      throw new LifecycleError("protocol_mismatch");
  }
  for (const key of [
    "segmentGeneration",
    "observationRevision",
    "lastSequence",
  ]) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || value[key] < 0)
    )
      throw new LifecycleError("protocol_mismatch");
  }
  if (
    ["recording", "yielded", "ended"].includes(value.status) &&
    (!value.sessionUuid || !value.principalDigest)
  )
    throw new LifecycleError("protocol_mismatch");
  if (value.principalDigest && !Number.isSafeInteger(value.lastSequence))
    throw new LifecycleError("protocol_mismatch");
  return value;
}
