import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.resolve(".cr2dep.json");

export type LocalConfig = {
  factoryAddress?: string;
  implementationAddress?: string;
};

export function loadConfig(): LocalConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function saveConfig(c: LocalConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n");
}

export function env(name: string, required = false): string | undefined {
  const v = process.env[name];
  if (required && !v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
