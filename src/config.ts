import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readEnvFile } from "./envfile.ts";
import { TARGETS } from "./targets.ts";

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(path: string) {
  if (!existsSync(path)) throw new Error(`config file not found: ${path} (copy autologin.env.example)`);
  const c = readEnvFile(path);
  const envFile = c.ENV_FILE ? resolve(dirname(resolve(path)), c.ENV_FILE) : "";
  return {
    path: resolve(path),
    raw: c,
    email: c.WHOOP_EMAIL || (envFile && readEnvFile(envFile).WHOOP_EMAIL),
    password: c.WHOOP_PASSWORD,
    codeUrl: c.CODE_URL,
    codeKey: c.CODE_KEY,
    notify: c.NOTIFY !== "0",
    check: c.CHECK || "mcp",
    totemUrl: c.TOTEM_URL,
    totemToken: c.TOTEM_TOKEN,
    serverMatch: c.SERVER_MATCH,
    target: c.TARGET || "envfile",
    envFile,
    restartCommand: c.RESTART_COMMAND,
    flyApp: c.FLY_APP,
    railwayProject: c.RAILWAY_PROJECT,
    railwayService: c.RAILWAY_SERVICE,
    cloudrunService: c.CLOUDRUN_SERVICE,
    cloudrunRegion: c.CLOUDRUN_REGION,
    cloudrunProject: c.CLOUDRUN_PROJECT,
    hfSpace: c.HF_SPACE,
    hfToken: c.HF_TOKEN,
    tokensCommand: c.TOKENS_COMMAND,
    stateFile: resolve(dirname(resolve(path)), c.STATE_FILE || "autologin-state.json"),
  };
}

export function validate(cfg: Config, { forLogin }: { forLogin: boolean }): string[] {
  const problems: string[] = [];
  const need = (key: string, ok: string | undefined = cfg.raw[key]) => {
    if (!ok) problems.push(`${key} is missing`);
  };

  if (!["mcp", "refresh"].includes(cfg.check)) problems.push(`CHECK must be mcp or refresh, not "${cfg.check}"`);
  if (cfg.check === "mcp") { need("TOTEM_URL"); need("TOTEM_TOKEN"); }
  if (cfg.check === "refresh") need("ENV_FILE");

  const target = TARGETS[cfg.target];
  if (!target) problems.push(`TARGET "${cfg.target}" is not one of: ${Object.keys(TARGETS).join(", ")}`);
  else for (const key of target.needs) need(key);

  if (forLogin) {
    need("WHOOP_EMAIL", cfg.email);
    need("WHOOP_PASSWORD");
    need("CODE_URL");
    need("CODE_KEY");
  }
  return problems;
}
