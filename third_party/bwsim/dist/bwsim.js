import { readFile } from "node:fs/promises";
import { parseAssetPack } from "./asset-pack.js";
import { normalizeScrReplayUnitIds } from "./replay-unit-id.js";
const MiB = 1024 * 1024;
const INITIAL_DRPL_CAPACITY = 8 * MiB;
const MAX_DRPL_CAPACITY = 64 * MiB;
const HUD_UNIT_RECORD_SIZE = 72;
const HUD_UNIT_CAPACITY = 4000;
const HUD_PLAYER_COUNT = 12;
const HUD_PLAYER_RECORD_SIZE = 40;
const REPLAY_HEADER_CAPACITY = 600;
const REPLAY_HEADER_PLAYER_OFFSET = 36;
const REPLAY_HEADER_PLAYER_SIZE = 44;
const REPLAY_HEADER_MIN_SIZE = REPLAY_HEADER_PLAYER_OFFSET + HUD_PLAYER_COUNT * REPLAY_HEADER_PLAYER_SIZE;
const UNIT_BUILD_QUEUE_CAPACITY = 5;
const UNIT_BUILD_QUEUE_BYTES = UNIT_BUILD_QUEUE_CAPACITY * Uint16Array.BYTES_PER_ELEMENT;
const HP_SCALE = 256;
function toSafeOffset(pointer, description = "Wasm pointer") {
    const offset = Number(pointer);
    if (!Number.isSafeInteger(offset) || offset < 0 || BigInt(offset) !== pointer) {
        throw new RangeError(`${description} is not a safe JavaScript byte offset: ${pointer}`);
    }
    return offset;
}
function validateFrameCount(frames, description) {
    if (!Number.isInteger(frames) || frames < 0 || frames > 0x7fff_ffff) {
        throw new RangeError(`${description} must be a non-negative signed 32-bit integer`);
    }
}
function validateExports(exports) {
    if (!(exports.memory instanceof WebAssembly.Memory)) {
        throw new Error("missing Wasm memory export");
    }
    for (const name of [
        "bw_alloc",
        "bw_free",
        "bw_add_file",
        "bw_rep_to_drpl",
        "bw_load",
        "bw_step",
        "bw_current_frame",
        "bw_replay_header",
        "bw_hud_players",
        "bw_hud_units",
        "bw_unit_instance_id",
        "bw_unit_build_queue",
    ]) {
        if (typeof exports[name] !== "function") {
            throw new Error(`missing Wasm export: ${name}`);
        }
    }
    return exports;
}
/** Headless wrapper around the established bwsim WebAssembly host contract. */
export class Bwsim {
    assetCount;
    #wasm;
    #rawReplay;
    #drplReplay;
    constructor(wasm, assetCount) {
        this.#wasm = wasm;
        this.assetCount = assetCount;
    }
    static async create(options) {
        const [wasmBytes, packBytes] = await Promise.all([
            readFile(options.wasmPath),
            readFile(options.assetPackPath),
        ]);
        let instantiated;
        try {
            instantiated = await WebAssembly.instantiate(wasmBytes, {});
        }
        catch (error) {
            throw new Error("direct WebAssembly instantiation failed; this Memory64 build requires a compatible Node.js release", { cause: error });
        }
        const wasm = validateExports(instantiated.instance.exports);
        const entries = parseAssetPack(packBytes);
        const sim = new Bwsim(wasm, entries.length);
        for (const entry of entries) {
            sim.#addAsset(entry.name, entry.bytes);
        }
        return sim;
    }
    async loadReplay(path) {
        await this.loadReplayBytes(await readFile(path));
    }
    async loadReplayBytes(bytes) {
        const raw = Uint8Array.from(bytes);
        const convertedDrpl = this.#convertReplay(raw);
        this.#loadDrpl(convertedDrpl);
        // Resolve the SCR replay command namespace against the exact generation-
        // bearing IDs in the freshly loaded initial state. Affected replay-local
        // IDs are normalized in DRPL, then the corrected replay is loaded once.
        const initialLiveUnitIds = new Set();
        for (const unit of this.units()) {
            const id = this.unitInstanceId(unit.index);
            if (id !== null)
                initialLiveUnitIds.add(id);
        }
        const normalized = normalizeScrReplayUnitIds(convertedDrpl, initialLiveUnitIds);
        const drpl = normalized.drpl;
        if (normalized.mode === "translated")
            this.#loadDrpl(drpl);
        this.#rawReplay = raw;
        this.#drplReplay = drpl;
    }
    replayData() {
        if (this.#rawReplay === undefined || this.#drplReplay === undefined)
            return undefined;
        return {
            raw: this.#rawReplay.slice(),
            drpl: this.#drplReplay.slice(),
        };
    }
    currentFrame() {
        return this.#wasm.bw_current_frame();
    }
    /** Read static metadata for the loaded replay, or undefined before a replay is available. */
    replayHeader() {
        const pointer = this.#alloc(REPLAY_HEADER_CAPACITY);
        try {
            const length = this.#wasm.bw_replay_header(pointer, BigInt(REPLAY_HEADER_CAPACITY));
            if (length === 0)
                return undefined;
            if (!Number.isInteger(length) || length < REPLAY_HEADER_MIN_SIZE || length > REPLAY_HEADER_CAPACITY) {
                throw new Error(`bw_replay_header returned invalid byte count ${length}`);
            }
            const view = new DataView(this.#wasm.memory.buffer, toSafeOffset(pointer, "replay-header output pointer"), length);
            const players = [];
            for (let slot = 0; slot < HUD_PLAYER_COUNT; slot += 1) {
                const offset = REPLAY_HEADER_PLAYER_OFFSET + slot * REPLAY_HEADER_PLAYER_SIZE;
                players.push({
                    slot,
                    name: readFixedString(view, offset, 25),
                    playerId: view.getInt32(offset + 28, true),
                    controller: view.getInt32(offset + 32, true),
                    race: view.getInt32(offset + 36, true),
                    force: view.getInt32(offset + 40, true),
                });
            }
            return {
                frameCount: view.getUint32(0, true),
                mapName: readFixedString(view, 4, 32),
                players,
            };
        }
        finally {
            this.#free(pointer, REPLAY_HEADER_CAPACITY);
        }
    }
    /** Read the twelve live player economy/action records. Supply values remain doubled and race-indexed. */
    players() {
        const capacityBytes = HUD_PLAYER_COUNT * HUD_PLAYER_RECORD_SIZE;
        const pointer = this.#alloc(capacityBytes);
        try {
            const count = this.#wasm.bw_hud_players(pointer, BigInt(capacityBytes));
            if (count !== HUD_PLAYER_COUNT) {
                throw new Error(`bw_hud_players returned ${count} records, expected ${HUD_PLAYER_COUNT}`);
            }
            const view = new DataView(this.#wasm.memory.buffer, toSafeOffset(pointer, "HUD-player output pointer"), capacityBytes);
            const players = [];
            for (let owner = 0; owner < count; owner += 1) {
                const offset = owner * HUD_PLAYER_RECORD_SIZE;
                players.push({
                    owner,
                    minerals: view.getInt32(offset, true),
                    gas: view.getInt32(offset + 4, true),
                    usedSupplyRaw: [
                        view.getInt32(offset + 8, true),
                        view.getInt32(offset + 12, true),
                        view.getInt32(offset + 16, true),
                    ],
                    maxSupplyRaw: [
                        view.getInt32(offset + 20, true),
                        view.getInt32(offset + 24, true),
                        view.getInt32(offset + 28, true),
                    ],
                    completedWorkers: view.getInt32(offset + 32, true),
                    actions: view.getInt32(offset + 36, true),
                });
            }
            return players;
        }
        finally {
            this.#free(pointer, capacityBytes);
        }
    }
    /** Return the engine's generation-bearing UnitId for a current live HUD slot. */
    unitInstanceId(index) {
        validateUnitIndex(index);
        const id = this.#wasm.bw_unit_instance_id(index) >>> 0;
        return id === 0 ? null : id;
    }
    /** Return the current five-slot production queue for a live HUD unit. */
    unitBuildQueue(index) {
        validateUnitIndex(index);
        const pointer = this.#alloc(UNIT_BUILD_QUEUE_BYTES);
        try {
            const count = this.#wasm.bw_unit_build_queue(index, pointer, BigInt(UNIT_BUILD_QUEUE_BYTES));
            if (!Number.isInteger(count) || count < 0 || count > UNIT_BUILD_QUEUE_CAPACITY) {
                throw new Error(`bw_unit_build_queue returned invalid item count ${count}`);
            }
            const view = new DataView(this.#wasm.memory.buffer, toSafeOffset(pointer, "unit-build-queue output pointer"), count * Uint16Array.BYTES_PER_ELEMENT);
            return Array.from({ length: count }, (_, slot) => view.getUint16(slot * Uint16Array.BYTES_PER_ELEMENT, true));
        }
        finally {
            this.#free(pointer, UNIT_BUILD_QUEUE_BYTES);
        }
    }
    /** Advance by a requested number of frames. The returned current frame is authoritative. */
    step(frames) {
        validateFrameCount(frames, "frames");
        this.#wasm.bw_step(frames);
        return this.currentFrame();
    }
    /** Seek using the proven reload-and-step behavior. */
    stepTo(frame) {
        validateFrameCount(frame, "frame");
        let current = this.currentFrame();
        if (frame < current) {
            if (this.#drplReplay === undefined) {
                throw new Error("cannot seek backward before a replay has been loaded");
            }
            this.#loadDrpl(this.#drplReplay);
            current = this.currentFrame();
        }
        if (frame > current)
            this.step(frame - current);
        return this.currentFrame();
    }
    units() {
        const capacityBytes = HUD_UNIT_CAPACITY * HUD_UNIT_RECORD_SIZE;
        const pointer = this.#alloc(capacityBytes);
        try {
            const count = this.#wasm.bw_hud_units(pointer, BigInt(capacityBytes));
            if (!Number.isInteger(count) || count < 0 || count > HUD_UNIT_CAPACITY) {
                throw new Error(`bw_hud_units returned invalid record count ${count}`);
            }
            // The Wasm call may grow memory, so acquire this view only after it returns.
            const view = new DataView(this.#wasm.memory.buffer, toSafeOffset(pointer, "HUD-unit output pointer"), count * HUD_UNIT_RECORD_SIZE);
            const units = [];
            for (let record = 0; record < count; record += 1) {
                const offset = record * HUD_UNIT_RECORD_SIZE;
                const flags = view.getUint8(offset + 7);
                const hpRaw = view.getInt32(offset + 16, true);
                const maxHpRaw = view.getInt32(offset + 20, true);
                units.push({
                    index: view.getUint32(offset, true),
                    type: view.getUint16(offset + 4, true),
                    owner: view.getUint8(offset + 6),
                    completed: (flags & 1) !== 0,
                    hidden: (flags & 2) !== 0,
                    x: view.getInt32(offset + 8, true),
                    y: view.getInt32(offset + 12, true),
                    hpRaw,
                    maxHpRaw,
                    hp: hpRaw / HP_SCALE,
                    maxHp: maxHpRaw / HP_SCALE,
                    shieldsRaw: view.getInt32(offset + 24, true),
                    maxShieldsRaw: view.getInt32(offset + 28, true),
                    energyRaw: view.getInt32(offset + 32, true),
                    kills: view.getInt32(offset + 36, true),
                    remainingBuildTime: view.getInt32(offset + 40, true),
                    totalBuildTime: view.getInt32(offset + 44, true),
                    resources: view.getInt32(offset + 48, true),
                    firstQueuedUnitType: view.getUint16(offset + 52, true),
                    facingX: view.getInt16(offset + 54, true),
                    facingY: view.getInt16(offset + 56, true),
                    targetX: view.getInt16(offset + 58, true),
                    targetY: view.getInt16(offset + 60, true),
                    researchKind: view.getUint8(offset + 62),
                    researchLevel: view.getUint8(offset + 63),
                    researchId: view.getUint16(offset + 64, true),
                    researchRemaining: view.getInt32(offset + 68, true),
                });
            }
            return units;
        }
        finally {
            this.#free(pointer, capacityBytes);
        }
    }
    #alloc(size) {
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new RangeError(`allocation size is invalid: ${size}`);
        }
        return this.#wasm.bw_alloc(BigInt(size));
    }
    #free(pointer, size) {
        this.#wasm.bw_free(pointer, BigInt(size));
    }
    #copyIn(bytes) {
        const pointer = this.#alloc(bytes.byteLength);
        // bw_alloc may grow memory, so construct the destination view afterwards.
        new Uint8Array(this.#wasm.memory.buffer, toSafeOffset(pointer), bytes.byteLength).set(bytes);
        return pointer;
    }
    #addAsset(name, bytes) {
        const nameBytes = new TextEncoder().encode(name);
        const namePointer = this.#copyIn(nameBytes);
        let dataPointer;
        try {
            dataPointer = this.#copyIn(bytes);
            this.#wasm.bw_add_file(namePointer, BigInt(nameBytes.byteLength), dataPointer, BigInt(bytes.byteLength));
        }
        finally {
            if (dataPointer !== undefined)
                this.#free(dataPointer, bytes.byteLength);
            this.#free(namePointer, nameBytes.byteLength);
        }
    }
    #convertReplay(raw) {
        const inputPointer = this.#copyIn(raw);
        let capacity = INITIAL_DRPL_CAPACITY;
        let outputPointer = this.#alloc(capacity);
        try {
            for (;;) {
                const length = this.#wasm.bw_rep_to_drpl(inputPointer, BigInt(raw.byteLength), outputPointer, BigInt(capacity));
                if (length > 0) {
                    if (!Number.isSafeInteger(length) || length > capacity) {
                        throw new Error(`bw_rep_to_drpl returned invalid byte count ${length}`);
                    }
                    // Reacquire memory.buffer after the Wasm operation.
                    return new Uint8Array(this.#wasm.memory.buffer, toSafeOffset(outputPointer, "DRPL output pointer"), length).slice();
                }
                if (length < 0) {
                    throw new Error(`bw_rep_to_drpl returned invalid byte count ${length}`);
                }
                if (capacity >= MAX_DRPL_CAPACITY) {
                    throw new Error("replay conversion failed after reaching the 64 MiB output limit");
                }
                this.#free(outputPointer, capacity);
                outputPointer = undefined;
                capacity *= 2;
                outputPointer = this.#alloc(capacity);
            }
        }
        finally {
            if (outputPointer !== undefined)
                this.#free(outputPointer, capacity);
            this.#free(inputPointer, raw.byteLength);
        }
    }
    #loadDrpl(drpl) {
        const pointer = this.#copyIn(drpl);
        try {
            const status = this.#wasm.bw_load(pointer, BigInt(drpl.byteLength));
            if (status !== 1) {
                throw new Error(`bw_load failed (returned ${status}, expected 1)`);
            }
        }
        finally {
            this.#free(pointer, drpl.byteLength);
        }
    }
}
function readFixedString(view, offset, capacity) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, capacity);
    const terminator = bytes.indexOf(0);
    const content = terminator === -1 ? bytes : bytes.subarray(0, terminator);
    return new TextDecoder().decode(content).replace(/[\x00-\x1f\x7f]/g, "");
}
function validateUnitIndex(index) {
    if (!Number.isInteger(index) || index < -0x8000_0000 || index > 0x7fff_ffff) {
        throw new RangeError("unit index must be a signed 32-bit integer");
    }
}
//# sourceMappingURL=bwsim.js.map