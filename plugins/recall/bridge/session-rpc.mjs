import { randomUUID } from "node:crypto";
import {
  LifecycleError,
  LOCAL_BEGIN_TOOL,
  LOCAL_HOOK_TOOL,
  LOCAL_STATUS_TOOL,
} from "./session-lifecycle-contract.mjs";

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 128;
const LOCAL_NAMES = new Set([
  LOCAL_BEGIN_TOOL,
  LOCAL_HOOK_TOOL,
  LOCAL_STATUS_TOOL,
]);

export class JsonLineReader {
  constructor(limit, receive, fail) {
    this.limit = limit;
    this.receive = receive;
    this.fail = fail;
    this.buffer = Buffer.alloc(0);
    this.failed = false;
  }
  push(chunk) {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const index = this.buffer.indexOf(10);
      if (index < 0) break;
      if (index > this.limit) return this.reject();
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (line.length === 0) continue;
      let value;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        return this.reject();
      }
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return this.reject();
      this.receive(value);
    }
    if (this.buffer.length > this.limit) this.reject();
  }
  end() {
    if (this.buffer.length) this.reject();
  }
  reject() {
    if (this.failed) return;
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.fail(new LifecycleError("protocol_mismatch"));
  }
}

// Both normal host requests and adapter-internal requests use the ONE existing
// stream. Rewriting all client request IDs prevents collisions, even if a host
// deliberately chooses a string that resembles an internal request ID.
export class SessionRpcInterposer {
  constructor({
    sendHost,
    sendPeer,
    adapter,
    onFailure = () => {},
    timeoutMs = 1500,
  }) {
    this.sendHost = sendHost;
    this.sendPeer = sendPeer;
    this.adapter = adapter;
    this.onFailure = onFailure;
    this.timeoutMs = timeoutMs;
    this.prefix = `recall-adapter/${randomUUID()}/`;
    this.counter = 0;
    this.requests = new Map();
    this.closed = false;
    this.localCalls = 0;
  }
  allocate() {
    if (this.closed) throw new LifecycleError("transport_unavailable");
    if (this.requests.size >= MAX_REQUESTS)
      throw new LifecycleError("queue_full");
    return `${this.prefix}${++this.counter}`;
  }
  async fromHost(message) {
    try {
      if (
        Object.hasOwn(message, "id") &&
        typeof message.id !== "string" &&
        typeof message.id !== "number"
      ) {
        this.sendHost({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Invalid JSON-RPC request identifier.",
          },
        });
        return;
      }
      if (
        message.method === "notifications/cancelled" &&
        Object.hasOwn(message.params ?? {}, "requestId")
      ) {
        const match = [...this.requests].find(
          ([, pending]) =>
            !pending.internal && pending.hostId === message.params.requestId,
        );
        if (match) {
          this.sendPeer({
            ...message,
            params: { ...message.params, requestId: match[0] },
          });
          this.requests.delete(match[0]);
          return;
        }
        if (
          typeof message.params.requestId === "string" &&
          message.params.requestId.startsWith(this.prefix)
        )
          return;
      }
      if (
        message.method === "tools/call" &&
        LOCAL_NAMES.has(message.params?.name) &&
        this.adapter.handles(message.params.name)
      ) {
        if (!Object.hasOwn(message, "id") || this.localCalls >= 16) {
          if (Object.hasOwn(message, "id"))
            this.sendHost({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32000,
                message: "Recall recording adapter is busy.",
              },
            });
          return;
        }
        this.localCalls++;
        try {
          const result = await this.adapter.handle(
            message.params.name,
            message.params.arguments ?? {},
          );
          this.sendHost({ jsonrpc: "2.0", id: message.id, result });
        } finally {
          this.localCalls--;
        }
        return;
      }
      if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
        const id = this.allocate();
        this.requests.set(id, { hostId: message.id, method: message.method });
        this.sendPeer({ ...message, id });
        return;
      }
      // Notifications and responses to server-originated requests are not ours.
      this.sendPeer(message);
    } catch (error) {
      if (Object.hasOwn(message, "id"))
        this.sendHost({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: "Recall recording adapter is unavailable.",
          },
        });
    }
  }
  async fromPeer(message) {
    const pending = this.requests.get(message.id);
    if (!pending || typeof message.method === "string") {
      // A timed-out internal response must not leak an unknown response ID into
      // the host. Server-originated requests still pass through unchanged.
      if (
        typeof message.id === "string" &&
        message.id.startsWith(this.prefix) &&
        typeof message.method !== "string"
      )
        return;
      this.sendHost(message);
      return;
    }
    this.requests.delete(message.id);
    if (pending.internal) {
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new LifecycleError("scope_unavailable"));
      else pending.resolve(message.result);
      return;
    }
    const output = { ...message, id: pending.hostId };
    if (
      pending.method === "tools/list" &&
      Array.isArray(message.result?.tools)
    ) {
      try {
        const local = await this.adapter.catalog(message.result.tools);
        output.result = {
          ...message.result,
          tools: [...message.result.tools, ...local],
        };
      } catch {
        /* The original catalog is always usable if decoration fails. */
      }
    }
    this.sendHost(output);
  }
  call(tool, args, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let id;
      try {
        id = this.allocate();
        const timer = setTimeout(
          () => {
            this.requests.delete(id);
            reject(new LifecycleError("transport_unavailable"));
          },
          Math.max(1, Math.min(timeoutMs, this.timeoutMs)),
        );
        this.requests.set(id, { internal: true, resolve, reject, timer });
        this.sendPeer({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: args },
        });
      } catch (error) {
        const pending = this.requests.get(id);
        if (pending?.internal) clearTimeout(pending.timer);
        this.requests.delete(id);
        reject(error);
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.requests.values()) {
      if (pending.internal) {
        clearTimeout(pending.timer);
        pending.reject(new LifecycleError("transport_unavailable"));
      }
    }
    this.requests.clear();
  }
}
