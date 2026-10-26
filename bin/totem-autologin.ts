#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, validate, type Config } from "../src/config.ts";
import { check, serverRunning, type CheckResult } from "../src/check.ts";
import { login } from "../src/cognito.ts";
import { waitForCode, notify, ping } from "../src/relay.ts";
import { saveTokens } from "../src/targets.ts";
import { upsertEnvFile } from "../src/envfile.ts";

const MIN_GAP_MS = 6 * 3600_000; // at most one login attempt every 6 hours
const CONFIRM_DELAY_MS = 120_000; // check again before logging in
const ERRORS_BEFORE_EMAIL = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const HELP = `Usage: totem-autologin [command] [--config <file>]

Commands:
  run     check, and log in again if the Whoop login expired (default; what the scheduler runs)
  check   check only, plus the relay connection
  login   log in now, even if the login still works (sends a code email)
  setup   ask for your Whoop email, password and relay URL, save them to the config, create the relay key

Config file: --config, else $TOTEM_AUTOLOGIN_CONFIG, else ./autologin.env`;

const args = process.argv.slice(2);
const configIdx = args.indexOf("--config");
const configPath = configIdx >= 0 ? args[configIdx + 1] : process.env.TOTEM_AUTOLOGIN_CONFIG || "autologin.env";
const command = args.includes("--help")
  ? "help"
  : args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--config") || "run";

interface State {
  lastAttempt?: number;
  errors?: number;
}

function readState(cfg: Config): State {
  try { return JSON.parse(readFileSync(cfg.stateFile, "utf8")); } catch { return {}; }
}
function writeState(cfg: Config, state: State): void {
  writeFileSync(cfg.stateFile, JSON.stringify(state) + "\n");
}

function loadOrExit(forLogin: boolean): Config {
  const cfg = loadConfig(configPath);
  const problems = validate(cfg, { forLogin });
  if (problems.length) {
    console.error(`Config problems in ${cfg.path}:\n  ${problems.join("\n  ")}`);
    process.exit(2);
  }
  return cfg;
}

async function relogin(cfg: Config, { force }: { force: boolean }): Promise<boolean> {
  const state = readState(cfg);
  if (!force && Date.now() - (state.lastAttempt ?? 0) < MIN_GAP_MS) {
    log("login expired, but the last attempt was less than 6 h ago: waiting");
    return false;
  }
  writeState(cfg, { ...state, lastAttempt: Date.now() });

  log("logging into Whoop");
  const since = Date.now() - 60_000; // margin for clock differences with Google
  try {
    const tokens = await login(cfg.email, cfg.password, () => {
      log("Whoop sent a code by email, waiting for it");
      return waitForCode(cfg, since);
    });
    log(`logged in, saving tokens (target: ${cfg.target})`);
    await saveTokens(cfg, tokens);
  } catch (err) {
    const message = (err as Error).message;
    log(`login failed: ${message}`);
    await notify(cfg, "Whoop login FAILED", `totem-autologin could not log in: ${message}`);
    return false;
  }

  if (cfg.check === "refresh") {
    const hint = serverRunning(cfg) ? " totem is running with the old tokens: restart your MCP client." : "";
    log(`done.${hint}`);
    await notify(cfg, "Whoop login OK", `totem-autologin logged in again.${hint}`);
    return true;
  }

  // A platform redeploy can take a few minutes.
  let after: CheckResult = { status: "error", detail: "not checked" };
  for (let i = 0; i < 20; i++) {
    await sleep(15_000);
    after = await check(cfg);
    if (after.status === "ok") break;
  }
  log(`after login: ${after.status} (${after.detail})`);
  if (after.status === "ok") {
    await notify(cfg, "Whoop login OK", "totem-autologin logged in again.");
    return true;
  }
  await notify(cfg, "Whoop login FAILED", `Logged in and saved the tokens, but totem still fails: ${after.detail}`);
  return false;
}

async function run(cfg: Config): Promise<boolean> {
  let result = await check(cfg);
  if (result.status === "expired" && cfg.check === "mcp") {
    // totem doesn't retry a 401, so make sure it wasn't a one-off.
    log(`auth error (${result.detail}), checking again in 2 min`);
    await sleep(CONFIRM_DELAY_MS);
    result = await check(cfg);
  }

  const state = readState(cfg);
  if (result.status === "ok") {
    log(`ok (${result.detail})`);
    if (state.errors) writeState(cfg, { ...state, errors: 0 });
    return true;
  }
  if (result.status === "expired") {
    log(`Whoop login expired (${result.detail})`);
    return relogin(cfg, { force: false });
  }
  // Whoop down, network, server stopped: not a login problem, so don't log in.
  const errors = (state.errors ?? 0) + 1;
  writeState(cfg, { ...state, errors });
  log(`check failed (${errors} in a row): ${result.detail}`);
  if (errors === ERRORS_BEFORE_EMAIL) {
    await notify(cfg, "totem check failing", `${errors} checks in a row failed (not a login problem): ${result.detail}`);
  }
  return false;
}

async function checkOnly(cfg: Config): Promise<boolean> {
  const result = await check(cfg);
  console.log(`totem: ${result.status} (${result.detail})`);
  if (cfg.codeUrl && cfg.codeKey) {
    try { await ping(cfg); console.log("relay: ok"); } catch (err) { console.log(`relay: ${(err as Error).message}`); }
  } else {
    console.log("relay: not configured (CODE_URL / CODE_KEY)");
  }
  return result.status === "ok";
}

async function hidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  return new Promise((done) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return done(value);
        }
        if (ch === "\u0003") { stdin.setRawMode(false); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function setup(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("setup needs a terminal (ssh -t … for a remote machine)");
    process.exit(2);
  }
  if (!existsSync(configPath)) {
    const example = join(dirname(fileURLToPath(import.meta.url)), "..", "autologin.env.example");
    copyFileSync(example, configPath);
    console.log(`Created ${configPath} from the example. Fill in the other settings there.`);
  }
  const cfg = loadConfig(configPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question(`Whoop email${cfg.raw.WHOOP_EMAIL ? ` [${cfg.raw.WHOOP_EMAIL}]` : ""}: `)).trim() || cfg.raw.WHOOP_EMAIL;
  const url = (await rl.question(`Relay URL (Apps Script, ends in /exec)${cfg.raw.CODE_URL ? " [keep current]" : ""}: `)).trim() || cfg.raw.CODE_URL;
  rl.close();
  const password = (await hidden("Whoop password (hidden): ")) || cfg.raw.WHOOP_PASSWORD;
  const key = randomBytes(24).toString("hex");

  upsertEnvFile(configPath, { WHOOP_EMAIL: email ?? "", WHOOP_PASSWORD: password ?? "", CODE_URL: url ?? "", CODE_KEY: key });
  console.log(`\nSaved to ${configPath}.`);
  console.log(`Relay key (set it as the KEY script property in the Apps Script):\n\n  ${key}\n`);
}

try {
  let ok: boolean;
  switch (command) {
    case "run": ok = await run(loadOrExit(true)); break;
    case "check": ok = await checkOnly(loadOrExit(false)); break;
    case "login": ok = await relogin(loadOrExit(true), { force: true }); break;
    case "setup": await setup(); ok = true; break;
    case "help": case "-h": console.log(HELP); ok = true; break;
    default: console.error(HELP); process.exit(2);
  }
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
