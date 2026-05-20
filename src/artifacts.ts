import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Hex } from "viem";

export type Artifact = { abi: unknown[]; bytecode: Hex };

function loadArtifact(name: string): Artifact {
  const candidate = path.resolve(
    "artifacts",
    "contracts",
    `${name}.sol`,
    `${name}.json`,
  );
  if (!existsSync(candidate)) {
    throw new Error(
      `Artifact for ${name} not found at ${candidate}. Run \`pnpm compile\` first.`,
    );
  }
  const json = JSON.parse(readFileSync(candidate, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode as Hex };
}

export function implArtifact(): Artifact {
  return loadArtifact("BoundCaller");
}

export function factoryArtifact(): Artifact {
  return loadArtifact("ProxyFactory");
}
