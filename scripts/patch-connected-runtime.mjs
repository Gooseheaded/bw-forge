import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const inputPath = "third_party/bwsim/bwsim_wasm.wasm";
const outputPath = process.argv[2] ?? "tmp/bwsim_wasm.with-instance.wasm";
const source = new Uint8Array(await readFile(inputPath));
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const EXPECTED_SOURCE_SHA256 = "fa32729abbef46853f89c2ed60b4b22130c6e9cb40471ba446c3f8193404b760";
const EXPECTED_PATCHED_SHA256 = "3f41196ff3f15cbadcb5afedca5ebdeae8905c018bc1a696f3d008963280bf5e";
if (sourceSha256 !== EXPECTED_SOURCE_SHA256) throw new Error(`unexpected source SHA-256 ${sourceSha256}`);

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const bytes = (...values) => Uint8Array.from(values);
function readUleb(data, start) {
  let value = 0, shift = 0, position = start;
  for (;;) {
    const valueByte = data[position++];
    value += (valueByte & 0x7f) * 2 ** shift;
    if ((valueByte & 0x80) === 0) return { value, next: position };
    shift += 7;
  }
}
function encodeUleb(value) {
  const result = [];
  do {
    let valueByte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) valueByte |= 0x80;
    result.push(valueByte);
  } while (value);
  return bytes(...result);
}
function appendVector(payload, item, expectedCount) {
  const count = readUleb(payload, 0);
  if (count.value !== expectedCount) throw new Error(`unexpected vector count ${count.value}`);
  return cat(encodeUleb(expectedCount + 1), payload.subarray(count.next), item);
}

const sections = [];
let position = 8;
while (position < source.length) {
  const id = source[position++];
  const size = readUleb(source, position);
  const end = size.next + size.value;
  sections.push({ id, payload: source.subarray(size.next, end) });
  position = end;
}

let clonedBody;
for (const section of sections) {
  if (section.id !== 10) continue;
  const count = readUleb(section.payload, 0);
  if (count.value !== 1284) throw new Error(`unexpected function count ${count.value}`);
  let p = count.next;
  const bodies = [];
  for (let index = 0; index < count.value; index += 1) {
    const size = readUleb(section.payload, p);
    const end = size.next + size.value;
    bodies.push(section.payload.subarray(size.next, end));
    p = end;
  }
  clonedBody = bodies[110].slice();
  const pattern = bytes(0x29, 0x03, 0x98, 0x02);
  let matches = 0;
  for (let i = 0; i <= clonedBody.length - pattern.length; i += 1) {
    if (pattern.every((valueByte, j) => clonedBody[i + j] === valueByte)) {
      clonedBody.set(bytes(0x01, 0x01, 0x01, 0x01), i);
      matches += 1;
    }
  }
  if (matches !== 1) throw new Error(`expected one parent load, found ${matches}`);
  section.payload = appendVector(section.payload, cat(encodeUleb(clonedBody.length), clonedBody), count.value);
}
if (!clonedBody) throw new Error("missing code section");

for (const section of sections) {
  if (section.id === 3) section.payload = appendVector(section.payload, encodeUleb(61), 1284);
  if (section.id !== 7) continue;
  const count = readUleb(section.payload, 0);
  const name = new TextEncoder().encode("bw_unit_instance_id");
  const entry = cat(encodeUleb(name.length), name, bytes(0), encodeUleb(1284));
  section.payload = cat(encodeUleb(count.value + 1), section.payload.subarray(count.next), entry);
}

const patched = cat(
  source.subarray(0, 8),
  ...sections.flatMap(({ id, payload }) => [bytes(id), encodeUleb(payload.length), payload])
);
await WebAssembly.compile(patched);
const patchedSha256 = createHash("sha256").update(patched).digest("hex");
if (patchedSha256 !== EXPECTED_PATCHED_SHA256) throw new Error(`unexpected patched SHA-256 ${patchedSha256}`);
await writeFile(outputPath, patched);
console.log(JSON.stringify({ sourceSha256, patchedSha256, outputPath, outputBytes: patched.length, clonedFunction: 110, addedExport: "bw_unit_instance_id", replacedParentLoads: 1 }));
