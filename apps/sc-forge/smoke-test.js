const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = __dirname;
const buildOrderPath = path.join(root, "build-order.html");
const buildScriptPath = path.join(root, "build_single_file.js");
const tempOutputPath = path.join(os.tmpdir(), `sc-forge-smoke-${process.pid}.html`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function fileExists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function run() {
  const sourceHtml = read(buildOrderPath);
  const sourceJs = read(path.join(root, "build-order.override.js"));
  assert(!/onclick=|oninput=/.test(sourceHtml), "build-order.html still contains inline action wiring");
  assert(sourceHtml.includes('<script src="vendor/jszip.min.js"></script>'), "build-order.html is missing the JSZip source script");
  assert(sourceHtml.includes('<script src="build-order.override.js"></script>'), "build-order.html is missing the replay-analysis source script");
  assert(sourceHtml.includes("runtime v2026.05.15.2"), "build-order.html is missing the visible runtime version marker");
  assert(sourceJs.includes("function classifyCombatDeaths(set)"), "combat classification helper is missing");
  assert(sourceJs.includes("ZERG_CONSTRUCTION_DRONE_MATCH_WINDOW_SECS"), "construction-drone match window is missing");
  assert(sourceJs.includes("combatDeathsForSet(set)"), "combat consumers are not routed through the classified death view");
  assert(sourceJs.includes("builtFrom: src.builtFrom"), "replay-analysis items are not preserving builtFrom");
  assert(sourceHtml.includes("builtFrom: src.builtFrom"), "base build-order items are not preserving builtFrom");

  execFileSync(process.execPath, [buildScriptPath, "--output", tempOutputPath], {
    cwd: root,
    stdio: "pipe",
  });

  const builtHtml = read(tempOutputPath);
  assert(!builtHtml.includes('<script src="vendor/jszip.min.js"></script>'), "single-file output still references external JSZip");
  assert(!builtHtml.includes('<script src="build-order.override.js"></script>'), "single-file output still references external replay-analysis code");
  assert(builtHtml.includes("waitForAnalysisDocumentReady"), "single-file output is missing analysis readiness helpers");
  assert(builtHtml.includes("Copy full analysis report"), "single-file output is missing the analysis export UI");
  assert(builtHtml.includes("function classifyCombatDeaths(set)"), "single-file output is missing combat classification");
  assert(builtHtml.includes("runtime v2026.05.15.2"), "single-file output is missing the visible runtime version marker");

  assert(fileExists("README.md"), "README.md is missing");
  assert(fileExists(path.join("docs", "replay-analysis-cleanup-audit.md")), "cleanup audit document is missing");
  assert(fileExists(path.join("raw-data", "README.md")), "raw-data legacy note is missing");
  assert(!fileExists("index.html"), "deprecated quiz page still exists");
  assert(!fileExists("glossary.html"), "deprecated glossary page still exists");

  fs.unlinkSync(tempOutputPath);
  console.log("Smoke test passed.");
}

run();
