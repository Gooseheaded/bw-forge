const DRPL_COMMAND_LENGTH_OFFSET = 637;
const DRPL_COMMANDS_OFFSET = 641;
const SCR_REPLAY_GENERATION_BITS = 11;
const BWSIM_GENERATION_BITS = 13;
const SCR_REPLAY_COMPONENT_MASK = 0x07ff;
const BWSIM_COMPONENT_OFFSET = 0x06a4;
const BWSIM_COMPONENT_MASK = 0x1fff;
const BWSIM_COMPONENT_MAX = BWSIM_COMPONENT_OFFSET + SCR_REPLAY_COMPONENT_MASK;
/** Translate one non-native SCR replay UnitId into bwsim's UnitId namespace. */
export function translateScrReplayUnitId(id) {
    const unsignedId = id >>> 0;
    if (unsignedId === 0)
        return 0;
    const generation = unsignedId >>> SCR_REPLAY_GENERATION_BITS;
    const component = unsignedId & SCR_REPLAY_COMPONENT_MASK;
    return ((generation << BWSIM_GENERATION_BITS) |
        (component + BWSIM_COMPONENT_OFFSET)) >>> 0;
}
/** Translate a bwsim UnitId back into the representable SCR replay-local namespace. */
export function toScrReplayLocalUnitId(id) {
    const unsignedId = id >>> 0;
    if (unsignedId === 0)
        return 0;
    const slotPart = unsignedId & BWSIM_COMPONENT_MASK;
    if (slotPart < BWSIM_COMPONENT_OFFSET || slotPart > BWSIM_COMPONENT_MAX)
        return null;
    const generation = unsignedId >>> BWSIM_GENERATION_BITS;
    const component = slotPart - BWSIM_COMPONENT_OFFSET;
    return ((generation << SCR_REPLAY_GENERATION_BITS) | component) >>> 0;
}
/** Enumerate normalized UnitId fields without exposing the parser as public package API. */
export function scrUnitIdReferences(drpl) {
    const references = [];
    const view = dataView(drpl);
    for (const action of actions(drpl)) {
        for (const offset of unitIdFieldOffsets(drpl, action)) {
            references.push({
                frame: action.frame,
                opcode: action.opcode,
                id: view.getUint32(offset, true),
            });
        }
    }
    return references;
}
/**
 * Normalize SCR replay UnitIds against the generation-bearing IDs of the
 * simulator's freshly loaded initial unit set.
 *
 * Some SCR replay variants encode command UnitIds in a replay-local namespace.
 * The first resolvable extended selection identifies the namespace without a
 * numeric-range heuristic: native IDs resolve directly, while replay-local IDs
 * resolve only after the format translation.
 */
export function normalizeScrReplayUnitIds(drpl, initialLiveUnitIds) {
    let sawExtendedSelection = false;
    let mode = "not-applicable";
    for (const action of actions(drpl)) {
        if (action.opcode !== 0x63)
            continue;
        sawExtendedSelection = true;
        const ids = selectionIds(drpl, action).filter((id) => id !== 0);
        if (ids.length === 0)
            continue;
        const directMatches = ids.filter((id) => initialLiveUnitIds.has(id)).length;
        const translatedMatches = ids.filter((id) => initialLiveUnitIds.has(translateScrReplayUnitId(id))).length;
        if (directMatches !== 0 && translatedMatches !== 0) {
            throw new Error("ambiguous SCR replay UnitId namespace in initial selection");
        }
        if (directMatches !== 0) {
            mode = "native";
            break;
        }
        if (translatedMatches !== 0) {
            mode = "translated";
            break;
        }
    }
    if (mode !== "translated") {
        return {
            drpl,
            mode: mode === "not-applicable" && sawExtendedSelection ? "not-applicable" : mode,
            rewrittenFields: 0,
        };
    }
    const normalized = drpl.slice();
    let rewrittenFields = 0;
    for (const action of actions(normalized)) {
        for (const offset of unitIdFieldOffsets(normalized, action)) {
            rewrittenFields += rewriteUnitId(normalized, offset);
        }
    }
    return { drpl: normalized, mode, rewrittenFields };
}
function rewriteUnitId(bytes, offset) {
    const view = dataView(bytes);
    const id = view.getUint32(offset, true);
    if (id === 0)
        return 0;
    view.setUint32(offset, translateScrReplayUnitId(id), true);
    return 1;
}
function unitIdFieldOffsets(bytes, action) {
    switch (action.opcode) {
        case 0x60:
        case 0x61:
            return [action.payloadOffset + 4];
        case 0x62:
            return [action.payloadOffset];
        case 0x63:
        case 0x64:
        case 0x65: {
            const count = bytes[action.payloadOffset];
            return Array.from({ length: count }, (_, item) => action.payloadOffset + 1 + item * Uint32Array.BYTES_PER_ELEMENT);
        }
        default:
            return [];
    }
}
function selectionIds(bytes, action) {
    const count = bytes[action.payloadOffset];
    const view = dataView(bytes);
    return Array.from({ length: count }, (_, item) => view.getUint32(action.payloadOffset + 1 + item * 4, true));
}
function* actions(bytes) {
    if (bytes.byteLength < DRPL_COMMANDS_OFFSET)
        throw new Error("truncated DRPL header");
    const view = dataView(bytes);
    const commandLength = view.getUint32(DRPL_COMMAND_LENGTH_OFFSET, true);
    const commandEnd = DRPL_COMMANDS_OFFSET + commandLength;
    if (commandEnd > bytes.byteLength)
        throw new Error("truncated DRPL command stream");
    let frameOffset = DRPL_COMMANDS_OFFSET;
    while (frameOffset < commandEnd) {
        requireRange(frameOffset, 5, commandEnd, "DRPL frame header");
        const frame = view.getUint32(frameOffset, true);
        const actionBytes = bytes[frameOffset + 4];
        const frameEnd = frameOffset + 5 + actionBytes;
        requireRange(frameOffset, 5 + actionBytes, commandEnd, "DRPL frame actions");
        let actionOffset = frameOffset + 5;
        while (actionOffset < frameEnd) {
            requireRange(actionOffset, 2, frameEnd, "DRPL action header");
            const opcodeOffset = actionOffset + 1; // storm player precedes the opcode
            const opcode = bytes[opcodeOffset];
            const length = actionLength(bytes, opcodeOffset, frameEnd);
            requireRange(opcodeOffset, length, frameEnd, `DRPL action 0x${opcode.toString(16)}`);
            yield {
                frame,
                opcode,
                payloadOffset: opcodeOffset + 1,
            };
            actionOffset = opcodeOffset + length;
        }
        if (actionOffset !== frameEnd)
            throw new Error("misaligned DRPL action block");
        frameOffset = frameEnd;
    }
    if (frameOffset !== commandEnd)
        throw new Error("misaligned DRPL command stream");
}
const FIXED_ACTION_LENGTHS = new Map([
    [0x05, 1], [0x08, 1], [0x0c, 8], [0x0d, 3], [0x0e, 5], [0x0f, 2],
    [0x10, 1], [0x11, 1], [0x12, 5], [0x13, 3], [0x14, 10], [0x15, 11],
    [0x18, 1], [0x19, 1], [0x1a, 2], [0x1b, 1], [0x1c, 1], [0x1d, 1],
    [0x1e, 2], [0x1f, 3], [0x20, 3], [0x21, 2], [0x22, 2], [0x23, 3],
    [0x25, 2], [0x26, 2], [0x27, 1], [0x28, 2], [0x29, 3], [0x2a, 1],
    [0x2b, 2], [0x2c, 2], [0x2d, 2], [0x2e, 1], [0x2f, 5], [0x30, 2],
    [0x31, 1], [0x32, 2], [0x33, 1], [0x34, 1], [0x35, 3], [0x36, 1],
    [0x37, 7], [0x38, 1], [0x39, 1], [0x3a, 2], [0x3b, 2], [0x3c, 1],
    [0x3d, 2], [0x3e, 6], [0x3f, 8], [0x40, 18], [0x41, 3], [0x42, 2],
    [0x43, 2], [0x44, 3], [0x45, 3], [0x48, 13], [0x54, 1], [0x55, 2],
    [0x56, 10], [0x57, 2], [0x58, 5], [0x5a, 1], [0x5b, 1], [0x5c, 82],
    [0x5f, 2], [0x60, 12], [0x61, 13], [0x62, 5], [0x66, 4],
]);
function actionLength(bytes, opcodeOffset, frameEnd) {
    const opcode = bytes[opcodeOffset];
    const fixed = FIXED_ACTION_LENGTHS.get(opcode);
    if (fixed !== undefined)
        return fixed;
    if (opcode === 0x09 || opcode === 0x0a || opcode === 0x0b) {
        requireRange(opcodeOffset + 1, 1, frameEnd, "selection count");
        return 2 + bytes[opcodeOffset + 1] * 2;
    }
    if (opcode === 0x63 || opcode === 0x64 || opcode === 0x65) {
        requireRange(opcodeOffset + 1, 1, frameEnd, "extended selection count");
        return 2 + bytes[opcodeOffset + 1] * 4;
    }
    if (opcode === 0x06 || opcode === 0x07) {
        requireRange(opcodeOffset + 1, 5, frameEnd, "saved-game action");
        for (let offset = opcodeOffset + 6; offset < frameEnd; offset += 1) {
            if (bytes[offset] === 0)
                return offset - opcodeOffset + 1;
        }
        throw new Error("unterminated saved-game action");
    }
    throw new Error(`unsupported DRPL action opcode 0x${opcode.toString(16)}`);
}
function requireRange(offset, length, end, description) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0 || offset < 0 || offset + length > end) {
        throw new Error(`truncated ${description}`);
    }
}
function dataView(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
//# sourceMappingURL=replay-unit-id.js.map