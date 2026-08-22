/** Translation between the two SCR UnitId namespaces observed in replay commands. */
export declare const SCR_REPLAY_UNIT_ID_OFFSET = 7844;
export type ScrUnitIdMode = "not-applicable" | "native" | "translated";
export interface ScrUnitIdNormalization {
    readonly drpl: Uint8Array;
    readonly mode: ScrUnitIdMode;
    readonly rewrittenFields: number;
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
export declare function normalizeScrReplayUnitIds(drpl: Uint8Array, initialLiveUnitIds: ReadonlySet<number>): ScrUnitIdNormalization;
//# sourceMappingURL=replay-unit-id.d.ts.map