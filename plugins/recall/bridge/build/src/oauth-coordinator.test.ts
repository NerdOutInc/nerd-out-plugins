import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerUrlHash } from "../vendor/mcp-remote/src/lib/utils";
import {
  inspectCache,
  parseCoordinatorArguments,
  validateAuthorizationUrl,
} from "./oauth-coordinator";

const temporaryDirectories: string[] = [];
const previousConfigDirectory = process.env.MCP_REMOTE_CONFIG_DIR;

afterEach(async () => {
  if (previousConfigDirectory === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR;
  else process.env.MCP_REMOTE_CONFIG_DIR = previousConfigDirectory;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true }))
  );
  vi.restoreAllMocks();
});

describe("coordinator arguments", () => {
  it("accepts only fixed clients, modes, and MCP resources", () => {
    expect(
      parseCoordinatorArguments([
        "--mode",
        "authorize",
        "--client-name",
        "Claude",
        "--server-url",
        "http://127.0.0.1:38474/mcp",
      ])
    ).toEqual({
      clientName: "Claude",
      mode: "authorize",
      serverUrl: "http://127.0.0.1:38474/mcp",
    });
    expect(() =>
      parseCoordinatorArguments(["--mode", "authorize", "--client-name", "Claude Desktop"])
    ).toThrow("Unsupported coordinator client");
    expect(() =>
      parseCoordinatorArguments([
        "--mode",
        "authorize",
        "--client-name",
        "Claude",
        "--server-url",
        "http://127.0.0.1:9999/mcp",
      ])
    ).toThrow("Unsupported MCP server URL");
  });
});

describe("inspect mode cache facts", () => {
  it("reports missing without network access or creating a directory", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recall-inspect-"));
    temporaryDirectories.push(temporaryRoot);
    const absentCache = path.join(temporaryRoot, "absent", "recall", "claude");
    process.env.MCP_REMOTE_CONFIG_DIR = absentCache;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(inspectCache(getServerUrlHash("http://127.0.0.1:38473/mcp"))).resolves.toEqual({
      clientId: null,
      state: "missing",
    });
    await expect(fs.access(path.join(temporaryRoot, "absent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports structurally complete credentials as present without exposing tokens", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recall-inspect-"));
    temporaryDirectories.push(temporaryRoot);
    process.env.MCP_REMOTE_CONFIG_DIR = path.join(temporaryRoot, "recall", "codex");
    const cacheDirectory = path.join(process.env.MCP_REMOTE_CONFIG_DIR, "mcp-remote-0.1.38");
    await fs.mkdir(cacheDirectory, { recursive: true });
    const hash = getServerUrlHash("http://127.0.0.1:38473/mcp");
    await Promise.all([
      fs.writeFile(
        path.join(cacheDirectory, `${hash}_client_info.json`),
        JSON.stringify({
          client_id: "local-client-id",
          redirect_uris: ["http://127.0.0.1:45678/oauth/callback"],
          token_endpoint_auth_method: "none",
        })
      ),
      fs.writeFile(
        path.join(cacheDirectory, `${hash}_tokens.json`),
        JSON.stringify({
          access_token: "secret-access-token",
          refresh_token: "secret-refresh-token",
          token_type: "bearer",
        })
      ),
    ]);

    const snapshot = await inspectCache(hash);
    expect(snapshot).toEqual({ clientId: "local-client-id", state: "present" });
    expect(JSON.stringify(snapshot)).not.toContain("secret-");
  });
});

describe("authorization URL validation", () => {
  const callback = "http://127.0.0.1:45678/oauth/callback";
  const resource = "http://127.0.0.1:38473/mcp" as const;
  const makeUrl = () =>
    new URL(
      "https://recall.example/oauth/authorize?" +
        new URLSearchParams({
          client_id: "client-id",
          code_challenge: "challenge",
          code_challenge_method: "S256",
          redirect_uri: callback,
          resource,
          response_type: "code",
          scope: "notes:read notes:write",
          state: "expected-state",
        })
    );

  it("accepts the byte-bound Recall authorization request", () => {
    expect(() =>
      validateAuthorizationUrl(
        makeUrl(),
        "https://recall.example",
        callback,
        "expected-state",
        resource
      )
    ).not.toThrow();
  });

  it("rejects origin, state, callback, scope, and repeated security parameters", () => {
    const mutations: Array<(url: URL) => void> = [
      (url) => (url.hostname = "evil.example"),
      (url) => url.searchParams.set("state", "wrong"),
      (url) => url.searchParams.set("redirect_uri", "http://127.0.0.1:9/oauth/callback"),
      (url) => url.searchParams.set("scope", "notes:read"),
      (url) => url.searchParams.append("state", "expected-state"),
    ];
    for (const mutate of mutations) {
      const url = makeUrl();
      mutate(url);
      expect(() =>
        validateAuthorizationUrl(
          url,
          "https://recall.example",
          callback,
          "expected-state",
          resource
        )
      ).toThrow();
    }
  });
});
