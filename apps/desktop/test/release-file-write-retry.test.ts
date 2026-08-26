import { describe, expect, it, vi } from "vitest";
import {
  isTransientFileLockError,
  writeFileWithRetry
} from "app-builder-lib/out/util/writeFileWithRetry.js";

describe("Electron Builder executable write retry patch", () => {
  it.each(["EBUSY", "EACCES", "EPERM"])("classifies %s as transient", (code) => {
    expect(isTransientFileLockError(Object.assign(new Error(code), { code }))).toBe(true);
  });

  it("does not retry unrelated filesystem errors", async () => {
    const writeFile = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await expect(
      writeFileWithRetry("BW Forge.exe", new Uint8Array(), {
        writeFile,
        maxRetries: 3,
        minDelayMs: 0,
        maxDelayMs: 0
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("retries transient locks and eventually writes", async () => {
    const locked = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    const writeFile = vi.fn().mockRejectedValueOnce(locked).mockRejectedValueOnce(locked).mockResolvedValue(undefined);

    await writeFileWithRetry("BW Forge.exe", new Uint8Array(), {
      writeFile,
      maxRetries: 3,
      minDelayMs: 0,
      maxDelayMs: 0
    });

    expect(writeFile).toHaveBeenCalledTimes(3);
  });
});
