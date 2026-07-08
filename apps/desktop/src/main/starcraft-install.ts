import { access } from "node:fs/promises";
import { join } from "node:path";

const REQUIRED_FILES = [
  join("x86", "StarCraft.exe"),
  join("x86", "clientsdk.dll")
] as const;

export interface StarcraftInstallValidation {
  valid: boolean;
  missingFiles: string[];
}

export async function validateStarcraftInstall(pathValue: string): Promise<StarcraftInstallValidation> {
  const normalized = pathValue.trim();
  if (!normalized) {
    return {
      valid: false,
      missingFiles: [...REQUIRED_FILES]
    };
  }

  const missingFiles: string[] = [];
  for (const relativePath of REQUIRED_FILES) {
    try {
      await access(join(normalized, relativePath));
    } catch {
      missingFiles.push(relativePath);
    }
  }

  return {
    valid: missingFiles.length === 0,
    missingFiles
  };
}

export async function detectStarcraftInstallPath(): Promise<string> {
  const candidates = [
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "StarCraft") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "StarCraft") : ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    if ((await validateStarcraftInstall(candidate)).valid) {
      return candidate;
    }
  }

  return "";
}
