// Client for the Gmail relay in apps-script/Code.gs.
import type { Config } from "./config.ts";

const WAIT_MS = 150_000; // Whoop's login session expires after ~3 minutes
const POLL_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RelayAnswer {
  code?: string | null;
  error?: string;
}

async function call(cfg: Config, body: object): Promise<RelayAnswer> {
  // Apps Script answers a POST with a redirect; fetch follows it and returns the script's output.
  const res = await fetch(cfg.codeUrl, {
    method: "POST",
    body: JSON.stringify({ key: cfg.codeKey, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({ error: `relay answered HTTP ${res.status} without JSON` }))) as RelayAnswer;
  if (data.error) throw new Error(`relay: ${data.error}`);
  return data;
}

export async function waitForCode(cfg: Config, sinceMs: number): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const { code } = await call(cfg, { action: "code", since: sinceMs });
    if (code) return code;
  }
  throw new Error(`no Whoop code email within ${WAIT_MS / 1000} s`);
}

export async function notify(cfg: Config, subject: string, msg: string): Promise<void> {
  if (!cfg.notify || !cfg.codeUrl) return;
  try {
    await call(cfg, { action: "notify", subject, msg });
  } catch (err) {
    console.log(`notification failed: ${(err as Error).message}`);
  }
}

// Confirms the URL and key work, without needing a Whoop email.
export async function ping(cfg: Config): Promise<void> {
  await call(cfg, { action: "code", since: Date.now() });
}
