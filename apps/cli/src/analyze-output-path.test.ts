import { describe, expect, test } from "bun:test";
import { assertSafeAnalyzeOutputRoot } from "./analyze-output-path.js";

const repoRoot = String.raw`C:\Users\gctri\Documents\_\bw-forge`;

describe("assertSafeAnalyzeOutputRoot", () => {
  test("rejects repo root", () => {
    expect(() => assertSafeAnalyzeOutputRoot(repoRoot, repoRoot)).toThrow(/Refusing to write analyze output to protected path/u);
  });

  test("rejects source directories", () => {
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`C:\Users\gctri\Documents\_\bw-forge\apps`, repoRoot)).toThrow(/protected path/u);
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`C:\Users\gctri\Documents\_\bw-forge\packages\legacy-replay-analysis\out`, repoRoot)).toThrow(/protected source directory/u);
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`C:\Users\gctri\Documents\_\bw-forge\third_party\shieldbattery\tmp`, repoRoot)).toThrow(/protected source directory/u);
  });

  test("allows generated output directories inside the repo", () => {
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`C:\Users\gctri\Documents\_\bw-forge\out`, repoRoot)).not.toThrow();
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`C:\Users\gctri\Documents\_\bw-forge\out\fixture`, repoRoot)).not.toThrow();
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`C:\Users\gctri\Documents\_\bw-forge\tmp`, repoRoot)).not.toThrow();
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`C:\Users\gctri\Documents\_\bw-forge\tmp\runs\commit-smoke`, repoRoot)).not.toThrow();
  });

  test("allows output outside the repo", () => {
    expect(() => assertSafeAnalyzeOutputRoot(String.raw`D:\bwforge-output\commit-smoke`, repoRoot)).not.toThrow();
  });
});

