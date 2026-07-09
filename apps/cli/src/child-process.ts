import type { SpawnOptions } from "node:child_process";

export function buildCommandSpawnOptions(params: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): SpawnOptions {
  return {
    cwd: params.cwd,
    env: params.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true
  };
}
