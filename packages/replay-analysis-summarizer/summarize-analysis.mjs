import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const inputDir = process.argv[2] ?? "./reports";
const outputPath = process.argv[3] ?? "./combined-analysis-reports.txt";

async function findHtmlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await findHtmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
      files.push(fullPath);
    }
  }

  return files;
}
const files = (await findHtmlFiles(path.resolve(inputDir))).sort();

const browser = await chromium.launch({ headless: true });

const combined = [];

for (const fullPath of files) {
  const file = path.relative(inputDir, fullPath);
  const url = pathToFileURL(fullPath).href;

  console.log(`Processing ${file}...`);

  const page = await browser.newPage();
  const consoleMessages = [];
  const pageErrors = [];

  page.on("console", message => {
    consoleMessages.push(`[${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", error => {
    pageErrors.push(error && error.stack ? error.stack : String(error));
  });

  await page.goto(url, { waitUntil: "load" });

  let diagnostics = null;
  let reportText = "";

  try {
    diagnostics = await page.evaluate(async () => {
      if (typeof window.waitForAnalysisDocumentReady === "function") {
        await window.waitForAnalysisDocumentReady();
      }

      const base = typeof window.getAnalysisDocumentDiagnostics === "function"
        ? window.getAnalysisDocumentDiagnostics()
        : {};

      return {
        ...base,
        hasCopyFullAnalysisReport: typeof window.copyFullAnalysisReport === "function",
        hasBuildFullAnalysisReport: typeof window.buildFullAnalysisReport === "function",
        hasBuildFullAnalysisReportForCurrentDocument: typeof window.buildFullAnalysisReportForCurrentDocument === "function",
        hasSets: Array.isArray(window.sets),
        setsLengthViaWindow: Array.isArray(window.sets) ? window.sets.length : null,
        readyState: document.readyState,
      };
    });
    reportText = await page.evaluate(async () => {
      if (typeof window.waitForAnalysisDocumentReady === "function") {
        await window.waitForAnalysisDocumentReady();
      }
      if (typeof window.buildFullAnalysisReportForCurrentDocument !== "function") {
        throw new Error("buildFullAnalysisReportForCurrentDocument() not found");
      }
      return String(window.buildFullAnalysisReportForCurrentDocument() ?? "");
    });
    if (!reportText.trim()) {
      throw new Error(`No report text returned from ${file}`);
    }
  } catch (error) {
    console.error(`Failed extracting ${file}`);
    console.error(error);
    console.error("Diagnostics:", diagnostics);
    if (consoleMessages.length) {
      console.error("Browser console:");
      console.error(consoleMessages.join("\n"));
    }
    if (pageErrors.length) {
      console.error("Page errors:");
      console.error(pageErrors.join("\n"));
    }
    await page.close();
    continue;
  }

  combined.push(
    [
      "################################################################",
      `# SOURCE FILE: ${file}`,
      "################################################################",
      "",
      reportText.trim(),
      "",
    ].join("\n")
  );

  await page.close();
}

await browser.close();

await fs.writeFile(outputPath, combined.join("\n\n"), "utf8");

console.log(`Done. Wrote ${files.length} reports to ${outputPath}`);
