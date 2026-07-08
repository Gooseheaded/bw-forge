const fs = require("fs");
const path = require("path");

const root = __dirname;
const defaultInput = path.join(root, "build-order.html");
const defaultOutput = path.join(root, "dist", "build-order.single-file.html");
const externalScripts = [
  {
    marker: '<script src="vendor/jszip.min.js"></script>',
    path: path.join(root, "vendor", "jszip.min.js"),
    licensePath: path.join(root, "vendor", "jszip.LICENSE.markdown"),
    licenseClassName: "embedded-jszip-license",
  },
  {
    marker: '<script src="build-order.override.js"></script>',
    path: path.join(root, "build-order.override.js"),
  },
];

function escapeInlineScript(text) {
  return text.replace(/<\/script>/gi, "<\\/script>");
}

function replaceOnce(haystack, needle, replacement) {
  const idx = haystack.indexOf(needle);
  if (idx === -1) {
    throw new Error(`Expected marker not found: ${needle}`);
  }
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}
function buildInlineScript({ path: scriptPath, licensePath, licenseClassName }) {
  const blocks = [];
  if (licensePath) {
    const licenseText = fs.readFileSync(licensePath, "utf8");
    blocks.push(
      `<script type="text/plain" class="${licenseClassName}" hidden>`,
      escapeInlineScript(licenseText),
      "</script>",
    );
  }
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  blocks.push("<script>", escapeInlineScript(scriptText), "</script>");
  return blocks.join("\n");
}

function parseArgs(argv) {
  let input = defaultInput;
  let output = defaultOutput;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      input = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--output") {
      output = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { input, output };
}

function buildSingleFile(inputHtmlPath, outputHtmlPath) {
  const html = fs.readFileSync(inputHtmlPath, "utf8");
  let built = html;
  for (const scriptSpec of externalScripts) {
    if (!built.includes(scriptSpec.marker)) {
      throw new Error(`Source HTML is not in modular form: missing ${scriptSpec.marker} script tag.`);
    }
    built = replaceOnce(built, scriptSpec.marker, buildInlineScript(scriptSpec));
  }

  fs.mkdirSync(path.dirname(outputHtmlPath), { recursive: true });
  fs.writeFileSync(outputHtmlPath, built, "utf8");
  return outputHtmlPath;
}

function main() {
  const { input, output } = parseArgs(process.argv.slice(2));
  const written = buildSingleFile(input, output);
  console.log(`Wrote ${written}`);
}

main();
