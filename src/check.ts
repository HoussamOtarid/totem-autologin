// Is totem still logged into Whoop?
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { refresh, jwtExpiry, CognitoError } from "./cognito.ts";
import { readEnvFile, upsertEnvFile } from "./envfile.ts";
import type { Config } from "./config.ts";

const AUTH_ERROR = /token expired|totem auth|NotAuthorized|Refresh Token/i;
const PROTOCOL = "2025-06-18";

export interface CheckResult {
  status: "ok" | "expired" | "error";
  detail: string;
}

interface McpMessage {
  result?: { isError?: boolean; content?: { text?: string }[] };
  error?: { message?: string };
}

export function check(cfg: Config): Promise<CheckResult> {
  return cfg.check === "refresh" ? refreshCheck(cfg) : mcpCheck(cfg);
}

// CHECK=mcp: one real tool call through the running server.
async function mcpCheck(cfg: Config): Promise<CheckResult> {
  const headers = {
    authorization: `Bearer ${cfg.totemToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const post = (body: object, extra: Record<string, string> = {}) =>
    fetch(cfg.totemUrl, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

  try {
    const init = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "totem-autologin", version: "1" } },
    });
    if (init.status === 401) return { status: "error", detail: "the server refused TOTEM_TOKEN" };
    if (!init.ok) return { status: "error", detail: `initialize answered HTTP ${init.status}` };
    const session = init.headers.get("mcp-session-id");
    await init.text();
    const sessionHeaders = { "mcp-session-id": session ?? "", "mcp-protocol-version": PROTOCOL };
    await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders)).text();

    const res = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoop_daily_brief", arguments: {} } },
      sessionHeaders,
    );
    const msg = parseMessage(await res.text());
    fetch(cfg.totemUrl, { method: "DELETE", headers: { ...headers, ...sessionHeaders } }).catch(() => {});

    if (msg?.result && !msg.result.isError) return { status: "ok", detail: "tool call worked" };
    const text = msg?.result?.content?.[0]?.text ?? msg?.error?.message ?? "unreadable answer";
    if (AUTH_ERROR.test(text)) return { status: "expired", detail: text.slice(0, 200) };
    return { status: "error", detail: text.slice(0, 200) };
  } catch (err) {
    return { status: "error", detail: (err as Error).message };
  }
}

// The answer is either plain JSON or a server-sent event ("data: {...}").
function parseMessage(body: string): McpMessage | null {
  const line = body.split("\n").find((l) => l.startsWith("data:"));
  try {
    return JSON.parse(line ? line.slice(5) : body);
  } catch {
    return null;
  }
}

// CHECK=refresh: for local installs, where the server only runs while Claude (or another client) is open.
// A refresh replaces the refresh token, and a running server keeps the old one in memory,
// so this never refreshes while the server is running.
async function refreshCheck(cfg: Config): Promise<CheckResult> {
  const env = readEnvFile(cfg.envFile);
  if (!env.WHOOP_COGNITO_REFRESH_TOKEN) return { status: "expired", detail: "no refresh token in ENV_FILE" };
  if (jwtExpiry(env.WHOOP_IOS_BEARER_TOKEN ?? "") * 1000 > Date.now() + 5 * 60_000) {
    return { status: "ok", detail: "access token still valid" };
  }
  if (serverRunning(cfg)) return { status: "ok", detail: "totem is running and refreshes its own token" };
  try {
    const t = await refresh(env.WHOOP_COGNITO_REFRESH_TOKEN);
    upsertEnvFile(cfg.envFile, { WHOOP_IOS_BEARER_TOKEN: t.accessToken, WHOOP_COGNITO_REFRESH_TOKEN: t.refreshToken });
    return { status: "ok", detail: "refreshed the token" };
  } catch (err) {
    const expired = err instanceof CognitoError && err.notAuthorized;
    return { status: expired ? "expired" : "error", detail: (err as Error).message };
  }
}

// totem's server is <totem folder>/dist/server.js; ENV_FILE is <totem folder>/.env.
export function serverRunning(cfg: Config): boolean {
  const needle = cfg.serverMatch || join(dirname(resolve(cfg.envFile)), "dist", "server.js");
  try {
    return execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" })
      .split("\n")
      .some((cmd) => cmd.includes(needle));
  } catch {
    return false;
  }
}
