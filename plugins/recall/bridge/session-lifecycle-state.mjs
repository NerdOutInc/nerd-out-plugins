import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LifecycleError,
  MAX_STATE_BYTES,
  MAX_PENDING_EVENTS,
  MAX_RECEIPTS,
  REASON_CODES,
  isDigest,
  isObject,
  isSafeTime,
  isUuid,
  validateAppRequest,
  validateAppResult,
} from "./session-lifecycle-contract.mjs";

const MAX_RUN_FILES = 256;
const LOCK_WAIT_MS = 250;

async function readBoundedJson(file, limit) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0)
      throw new LifecycleError("state_unavailable");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle?.close();
  }
}

function validateState(value, identity) {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.identity !== identity ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "identity",
          "nextSequence",
          "updatedAtMs",
          "pending",
          "receipts",
          "acknowledged",
          "diagnostic",
        ].includes(key),
    ) ||
    !Number.isSafeInteger(value.nextSequence) ||
    value.nextSequence < 1 ||
    !Array.isArray(value.pending) ||
    value.pending.length > MAX_PENDING_EVENTS ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > MAX_RECEIPTS ||
    !isSafeTime(value.updatedAtMs)
  )
    throw new LifecycleError("state_unavailable");
  for (const pending of value.pending) {
    validateAppRequest(pending, { queued: true });
    Object.freeze(pending);
  }
  for (const receipt of value.receipts) {
    if (
      !isObject(receipt) ||
      Object.keys(receipt).some(
        (key) => !["eventDigest", "sequence", "sessionUuid"].includes(key),
      ) ||
      !isDigest(receipt.eventDigest) ||
      !Number.isSafeInteger(receipt.sequence) ||
      receipt.sequence < 1 ||
      (receipt.sessionUuid !== undefined && !isUuid(receipt.sessionUuid))
    )
      throw new LifecycleError("state_unavailable");
  }
  const entries = [...value.pending, ...value.receipts];
  if (
    new Set(entries.map((entry) => entry.eventDigest)).size !==
      entries.length ||
    entries.some((entry) => entry.sequence >= value.nextSequence)
  )
    throw new LifecycleError("state_unavailable");
  if (value.acknowledged !== null) {
    const acknowledged = validateAppResult({
      structuredContent: value.acknowledged,
    });
    if (
      !["recording", "yielded", "ended", "not_started"].includes(
        acknowledged.status,
      ) ||
      !acknowledged.principalDigest
    )
      throw new LifecycleError("state_unavailable");
  }
  if (value.diagnostic !== undefined) {
    const diagnostic = value.diagnostic;
    if (
      !isObject(diagnostic) ||
      Object.keys(diagnostic).some(
        (key) =>
          ![
            "protocolVersion",
            "adapterVersion",
            "status",
            "reasonCode",
            "observedAtMs",
            "retryState",
            "stage",
          ].includes(key),
      ) ||
      diagnostic.protocolVersion !== 1 ||
      diagnostic.adapterVersion !== 1 ||
      ![
        "recording",
        "yielded",
        "ended",
        "not_started",
        "queued",
        "unavailable",
        "conflict",
      ].includes(diagnostic.status) ||
      (diagnostic.reasonCode !== null &&
        !REASON_CODES.includes(diagnostic.reasonCode)) ||
      !isSafeTime(diagnostic.observedAtMs) ||
      !["pending", "none"].includes(diagnostic.retryState) ||
      !["acknowledged", "unavailable"].includes(diagnostic.stage)
    )
      throw new LifecycleError("state_unavailable");
  }
  return value;
}

// Local bookkeeping only. Session identity and generation remain authoritative
// in Recall. A crash may leave a lock; only a provably dead owner is reaped.
export class LifecycleStateStore {
  constructor(
    directory,
    {
      clock = Date.now,
      processAlive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error?.code !== "ESRCH";
        }
      },
    } = {},
  ) {
    this.directory = directory;
    this.clock = clock;
    this.processAlive = processAlive;
  }

  async prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    )
      throw new LifecycleError("state_unavailable");
  }

  async withState(identity, callback) {
    if (!isDigest(identity)) throw new LifecycleError("state_unavailable");
    await this.prepare();
    const file = path.join(this.directory, `${identity}.json`);
    const lock = path.join(this.directory, `${identity}.lock`);
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await fs.writeFile(
          path.join(lock, "owner.json"),
          JSON.stringify({ pid: process.pid, token }),
          { mode: 0o600, flag: "wx" },
        );
        break;
      } catch (error) {
        if (error.code !== "EEXIST")
          throw new LifecycleError("state_unavailable");
        // Never follow a substituted lock or steal from a live/unknown process.
        const stat = await fs.lstat(lock).catch(() => null);
        if (!stat && Date.now() < deadline) continue;
        if (stat?.isSymbolicLink() || !stat?.isDirectory())
          throw new LifecycleError("state_unavailable");
        const owner = await readBoundedJson(
          path.join(lock, "owner.json"),
          1024,
        ).catch(() => null);
        if (
          Number.isSafeInteger(owner?.pid) &&
          owner.pid > 0 &&
          typeof owner.token === "string" &&
          !this.processAlive(owner.pid)
        ) {
          // Claim this particular dead lock before rechecking its inode/owner.
          // Concurrent reapers must not rename a newly acquired live lock. A
          // crash during reaping leaves a visible busy state; never use age as
          // authority to steal an unknown owner or an unfinished reaper claim.
          const claim = path.join(lock, "reaper.json");
          let claimed = false;
          try {
            await fs.writeFile(
              claim,
              JSON.stringify({ pid: process.pid, token }),
              { mode: 0o600, flag: "wx" },
            );
            claimed = true;
            const currentStat = await fs.lstat(lock);
            const currentOwner = await readBoundedJson(
              path.join(lock, "owner.json"),
              1024,
            );
            if (
              currentStat.dev === stat.dev &&
              currentStat.ino === stat.ino &&
              currentOwner.token === owner.token &&
              currentOwner.pid === owner.pid &&
              !this.processAlive(currentOwner.pid)
            ) {
              const parked = `${lock}.dead-${token}`;
              await fs.rename(lock, parked);
              claimed = false;
              await fs.rm(parked, { recursive: true, force: true });
              continue;
            }
          } catch (error) {
            if (!["EEXIST", "ENOENT"].includes(error.code))
              throw new LifecycleError("state_unavailable");
          } finally {
            if (claimed) {
              const currentClaim = await readBoundedJson(claim, 1024).catch(
                () => null,
              );
              if (currentClaim?.token === token)
                await fs.unlink(claim).catch(() => {});
            }
          }
        }
        if (Date.now() >= deadline) throw new LifecycleError("state_busy");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      let state;
      try {
        state = validateState(
          await readBoundedJson(file, MAX_STATE_BYTES),
          identity,
        );
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new LifecycleError("state_unavailable");
        const files = await fs.readdir(this.directory);
        if (
          files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length >=
          MAX_RUN_FILES
        )
          throw new LifecycleError("queue_full");
        state = {
          version: 1,
          identity,
          nextSequence: 1,
          updatedAtMs: this.clock(),
          pending: [],
          receipts: [],
          acknowledged: null,
        };
      }
      const save = async () => {
        state.updatedAtMs = this.clock();
        validateState(state, identity);
        const body = JSON.stringify(state);
        if (Buffer.byteLength(body) > MAX_STATE_BYTES)
          throw new LifecycleError("state_unavailable");
        const temporary = `${file}.${token}.tmp`;
        let handle;
        try {
          handle = await fs.open(
            temporary,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              constants.O_NOFOLLOW,
            0o600,
          );
          await handle.writeFile(body);
          await handle.sync();
          await handle.close();
          handle = null;
          await fs.rename(temporary, file);
          const directory = await fs.open(this.directory, constants.O_RDONLY);
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await handle?.close();
          await fs.unlink(temporary).catch(() => {});
        }
      };
      return await callback(state, save);
    } finally {
      const owner = await readBoundedJson(
        path.join(lock, "owner.json"),
        1024,
      ).catch(() => null);
      if (owner?.token === token)
        await fs.rm(lock, { recursive: true, force: true });
    }
  }
}
