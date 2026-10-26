// Save new Whoop tokens where totem reads them. Same platforms as `totem auth`.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { upsertEnvFile } from "./envfile.ts";
import type { Tokens } from "./cognito.ts";
import type { Config } from "./config.ts";

const ACCESS = "WHOOP_IOS_BEARER_TOKEN";
const REFRESH = "WHOOP_COGNITO_REFRESH_TOKEN";

interface Target {
  needs: string[];
  save: (cfg: Config, t: Tokens) => void | Promise<void>;
}

export const TARGETS: Record<string, Target> = {
  envfile: { needs: ["ENV_FILE"], save: saveEnvFile },
  fly: { needs: ["FLY_APP"], save: saveFly },
  railway: { needs: [], save: saveRailway },
  cloudrun: { needs: ["CLOUDRUN_SERVICE", "CLOUDRUN_REGION"], save: saveCloudRun },
  huggingface: { needs: ["HF_SPACE", "HF_TOKEN"], save: saveHuggingFace },
  command: { needs: ["TOKENS_COMMAND"], save: saveCommand },
};

export async function saveTokens(cfg: Config, t: Tokens): Promise<void> {
  await TARGETS[cfg.target].save(cfg, t);
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const r = spawnSync(cmd, args, { stdio: ["pipe", "inherit", "inherit"], ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

function runShell(command: string, env: Record<string, string> = {}): void {
  run("sh", ["-c", command], { env: { ...process.env, ...env } });
}

function saveEnvFile(cfg: Config, t: Tokens): void {
  if (existsSync(cfg.envFile)) copyFileSync(cfg.envFile, `${cfg.envFile}.bak-autologin`);
  upsertEnvFile(cfg.envFile, { [ACCESS]: t.accessToken, [REFRESH]: t.refreshToken });
  if (cfg.restartCommand) runShell(cfg.restartCommand);
}

function saveFly(cfg: Config, t: Tokens): void {
  // Values go through stdin, not the command line.
  run("fly", ["secrets", "import", "-a", cfg.flyApp], { input: `${ACCESS}=${t.accessToken}\n${REFRESH}=${t.refreshToken}\n` });
}

function saveRailway(cfg: Config, t: Tokens): void {
  if (cfg.railwayProject) run("railway", ["link", "--project", cfg.railwayProject]);
  const service = cfg.railwayService ? ["--service", cfg.railwayService] : [];
  run("railway", ["variables", ...service, "--set", `${ACCESS}=${t.accessToken}`, "--set", `${REFRESH}=${t.refreshToken}`]);
}

function saveCloudRun(cfg: Config, t: Tokens): void {
  run("gcloud", [
    "run", "services", "update", cfg.cloudrunService,
    "--region", cfg.cloudrunRegion,
    ...(cfg.cloudrunProject ? ["--project", cfg.cloudrunProject] : []),
    "--update-env-vars", `${ACCESS}=${t.accessToken},${REFRESH}=${t.refreshToken}`,
    "--quiet",
  ]);
}

// Updating a Space secret restarts the Space.
async function saveHuggingFace(cfg: Config, t: Tokens): Promise<void> {
  for (const [key, value] of [[ACCESS, t.accessToken], [REFRESH, t.refreshToken]]) {
    const res = await fetch(`https://huggingface.co/api/spaces/${cfg.hfSpace}/secrets`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.hfToken}`, "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status} for ${key}`);
  }
}

function saveCommand(cfg: Config, t: Tokens): void {
  runShell(cfg.tokensCommand, { [ACCESS]: t.accessToken, [REFRESH]: t.refreshToken });
}
