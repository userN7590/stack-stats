import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StackStatsConfig { token: string; port: number; databasePath: string }
export const dataDirectory = process.env.STACK_STATS_HOME ?? join(homedir(), ".stackstats");
export const configPath = join(dataDirectory, "config.json");

export function initializeConfig(): StackStatsConfig {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  if (existsSync(configPath)) return loadConfig();
  const config = { token: randomBytes(32).toString("hex"), port: 17321, databasePath: join(dataDirectory, "stack-stats.db") };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

export function loadConfig(): StackStatsConfig {
  if (!existsSync(configPath)) throw new Error("Stack Stats is not initialized. Run: pnpm stackstats init");
  return JSON.parse(readFileSync(configPath, "utf8")) as StackStatsConfig;
}

