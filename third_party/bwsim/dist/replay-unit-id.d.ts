export type ScrUnitIdMode = "not-applicable" | "native" | "translated";
export interface ScrUnitIdNormalization {
    readonly drpl: Uint8Array;
    readonly mode: ScrUnitIdMode;
    readonly rewrittenFields: number;
}
/** Internal diagnostic record used by converter regression tests. */
export interface ScrUnitIdReference {
    readonly frame: number;
    readonly opcode: number;
    readonly id: number;
}
/** Translate one non-native SCR replay UnitId into bwsim's UnitId namespace. */
export declare function translateScrReplayUnitId(id: number): number;
/** Translate a bwsim UnitId back into the representable SCR replay-local namespace. */
export declare function toScrReplayLocalUnitId(id: number): number | null;
/** Enumerate normalized UnitId fields without exposing the parser as public package API. */
export declare function scrUnitIdReferences(drpl: Uint8Array): readonly ScrUnitIdReference[];
/**
 * Normalize SCR replay UnitIds against the generation-bearing IDs of the
 * simulator's freshly loaded initial unit set.
 *
 * Some SCR replay variants encode command UnitIds in a replay-local namespace.
 * The first resolvable extended selection identifies the namespace without a
 * numeric-range heuristic: native IDs resolve directly, while replay-local IDs
 * resolve only after the format translation.
 */
export declare function normalizeScrReplayUnitIds(drpl: Uint8Array, initialLiveUnitIds: ReadonlySet<number>): ScrUnitIdNormalization;
//# sourceMappingURL=replay-unit-id.d.ts.map