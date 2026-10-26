import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..", "..", "..");

describe("Discord deployment script", () => {
  it("exposes an opt-in independent community worker without changing the professional defaults", () => {
    const source = readFileSync(join(root, "Deploy-BwForge.ps1"), "utf8");
    expect(source).toContain("DeployCommunityWorker");
    expect(source).toContain("RemoteCommunityRoot");
    expect(source).toContain("--community-corpus-root");
    const installer = readFileSync(join(root, "ops/systemd/install.sh"), "utf8");
    expect(installer).toContain("--community-db");
    expect(installer).toContain("community-worker.env");
    expect(installer).toContain("bw-forge-community-worker.service");
    expect(installer).toContain("community corpus must be distinct");
  });

  it("does not install dependencies from the registry on the offline target", () => {
    const source = readFileSync(join(root, "Deploy-BwForge.ps1"), "utf8");
    const remote = source.match(
      /\$remoteScript = @'\r?\n([\s\S]*?)\r?\n'@/,
    )![1];
    expect(remote).not.toMatch(/\bbun\s+install\b/);
  });
  const powershell =
    process.platform === "win32"
      ? join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : Bun.which("pwsh");
  (powershell ? it : it.skip)(
    "parses as PowerShell without executing deployment",
    async () => {
      const script = join(root, "Deploy-BwForge.ps1");
      const escaped = script.replaceAll("'", "''");
      const proc = Bun.spawn(
        [
          powershell!,
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$null = [scriptblock]::Create([IO.File]::ReadAllText('${escaped}')); exit 0`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(0);
    },
  );

  it("emits a syntactically valid remote bash script with isolated Discord state", async () => {
    const source = readFileSync(join(root, "Deploy-BwForge.ps1"), "utf8");
    const match = source.match(/\$remoteScript = @'\r?\n([\s\S]*?)\r?\n'@/);
    expect(match).not.toBeNull();
    const remote = match![1]
      .replaceAll("__DEPLOYDISCORD__", "1")
      .replaceAll("__REGISTERDISCORD__", "0")
      .replaceAll("__DISCORDENV__", "/etc/bw-forge/discord-bot.env")
      .replaceAll("__DISCORDSTATE__", "/srv/bw-forge/discord-bot-state");
    const directory = mkdtempSync(join(tmpdir(), "bwf-deploy-check-"));
    const temp = join(directory, "remote.sh");
    await Bun.write(temp, remote.replaceAll("\r\n", "\n"));
    try {
      const bash = existsSync("C:/Program Files/Git/bin/bash.exe")
        ? "C:/Program Files/Git/bin/bash.exe"
        : Bun.which("bash");
      if (bash) {
        const proc = Bun.spawn([bash, "-n", temp], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await proc.exited).toBe(0);
      }
      expect(remote).toContain(
        "DISCORD_BOT_DATABASE_PATH=$DISCORD_STATE/bot.sqlite",
      );
      expect(remote).toContain('if [ ! -f "$DISCORD_ENV" ]');
      expect(remote).toContain("REGISTER_DISCORD");
      expect(remote).not.toContain('DISCORD_BOT_TOKEN="');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const bash = existsSync("C:/Program Files/Git/bin/bash.exe")
    ? "C:/Program Files/Git/bin/bash.exe"
    : Bun.which("bash");
  (bash ? it : it.skip)(
    "installs and imports the real bundle without node_modules or registry commands",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "bwf-offline-artifact-"));
      const slashPath = (path: string) =>
        process.platform === "win32"
          ? path
              .replaceAll("\\", "/")
              .replace(
                /^([A-Za-z]):/,
                (_, drive: string) => `/${drive.toLowerCase()}`,
              )
          : path;
      try {
        const dist = join(directory, "bundle");
        const build = spawnSync(
          process.execPath,
          [
            "build",
            "./apps/discord-bot/src/main.ts",
            "./apps/discord-bot/src/discord/register.ts",
            "--target=bun",
            "--packages=bundle",
            `--outdir=${dist}`,
          ],
          { cwd: root, encoding: "utf8", windowsHide: true },
        );
        expect(build.status, build.stderr).toBe(0);
        const archive = join(directory, "discord-bot-bundle.tar.gz");
        const packed = spawnSync(
          "tar",
          ["-czf", archive, "-C", dist, "main.js", "discord/register.js"],
          { encoding: "utf8", windowsHide: true },
        );
        expect(packed.status, packed.stderr).toBe(0);
        const sha = createHash("sha256")
          .update(readFileSync(archive))
          .digest("hex");
        const source = readFileSync(join(root, "Deploy-BwForge.ps1"), "utf8");
        const block = source.match(
          /# BEGIN OFFLINE DISCORD INSTALL\r?\n([\s\S]*?)# END OFFLINE DISCORD INSTALL/,
        );
        expect(block).not.toBeNull();
        const runner = join(directory, "install.sh");
        await Bun.write(
          runner,
          `set -euo pipefail
DEPLOY_DISCORD=1
BUILD="$1/build"
DROP="$1"
DISCORD_BUNDLE_SHA="$2"
BUN_EXECUTABLE="$3"
mkdir -p "$BUILD/app"
bun() {
  if [ "$1" != "--eval" ]; then echo "Remote package resolution is forbidden" >&2; return 97; fi
  "$BUN_EXECUTABLE" "$@"
}
npm() { return 97; }
pnpm() { return 97; }
curl() { return 97; }
wget() { return 97; }
${block![1].replaceAll("\r\n", "\n")}
test ! -e "$BUILD/app/node_modules"
test ! -e "$BUILD/app/apps/discord-bot/node_modules"
`,
        );
        const execute = (hash: string) =>
          spawnSync(
            bash!,
            [
              slashPath(runner),
              slashPath(directory),
              hash,
              slashPath(process.execPath),
            ],
            {
              cwd: directory,
              env: {
                ...process.env,
                DISCORD_BOT_TOKEN: "",
                LLM_API_KEY: "",
                HTTP_PROXY: "http://127.0.0.1:1",
                HTTPS_PROXY: "http://127.0.0.1:1",
              },
              encoding: "utf8",
              windowsHide: true,
            },
          );
        const installed = execute(sha);
        expect(installed.status, installed.stdout + installed.stderr).toBe(0);
        const rejected = execute("0".repeat(64));
        expect(rejected.status).not.toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15000,
  );
});
