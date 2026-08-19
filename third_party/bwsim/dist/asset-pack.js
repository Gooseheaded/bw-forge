import { gunzipSync } from "node:zlib";
function readUint32LE(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}
/** Parse the proven sim.pack format, preserving manifest order. */
export function parseAssetPack(input) {
    let bytes = input;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        try {
            bytes = gunzipSync(bytes);
        }
        catch (error) {
            throw new Error("invalid gzip-compressed asset pack", { cause: error });
        }
    }
    if (bytes.length < 4) {
        throw new Error("asset pack is shorter than its 4-byte header");
    }
    const manifestLength = readUint32LE(bytes, 0);
    const manifestEnd = 4 + manifestLength;
    if (!Number.isSafeInteger(manifestEnd) || manifestEnd > bytes.length) {
        throw new Error("asset-pack manifest is truncated");
    }
    let manifest;
    try {
        manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, manifestEnd)));
    }
    catch (error) {
        throw new Error("invalid asset-pack manifest JSON or UTF-8", { cause: error });
    }
    if (!Array.isArray(manifest)) {
        throw new Error("asset-pack manifest is not an array");
    }
    let offset = manifestEnd;
    const entries = [];
    for (let index = 0; index < manifest.length; index += 1) {
        const candidate = manifest[index];
        if (typeof candidate !== "object" ||
            candidate === null ||
            typeof candidate.name !== "string" ||
            !Number.isSafeInteger(candidate.len) ||
            candidate.len < 0) {
            throw new Error(`invalid asset-pack manifest entry ${index}`);
        }
        const entry = candidate;
        const end = offset + entry.len;
        if (!Number.isSafeInteger(end) || end > bytes.length) {
            throw new Error(`asset-pack entry is truncated: ${entry.name}`);
        }
        entries.push({ name: entry.name, bytes: bytes.subarray(offset, end) });
        offset = end;
    }
    if (offset !== bytes.length) {
        throw new Error(`asset pack has ${bytes.length - offset} trailing byte(s) after its declared entries`);
    }
    return entries;
}
//# sourceMappingURL=asset-pack.js.map