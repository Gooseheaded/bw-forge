import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

describe("Discord deployment script", () => {
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
});
