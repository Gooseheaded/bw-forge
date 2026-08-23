export interface BwsimOptions {
    readonly wasmPath: string | URL;
    readonly assetPackPath: string | URL;
}
/** UnitId namespace used by the source replay. */
export type ReplayUnitIdNamespace = "native" | "replay-local";
/** Static player-slot metadata decoded from bw_replay_header. */
export interface BwsimReplayPlayer {
    readonly slot: number;
    readonly name: string;
    readonly playerId: number;
    readonly controller: number;
    readonly race: number;
    readonly force: number;
}
/** Static metadata for the currently loaded replay. */
export interface BwsimReplayHeader {
    /** Inclusive final replay frame recorded in the header. */
    readonly frameCount: number;
    readonly mapName: string;
    readonly players: readonly BwsimReplayPlayer[];
}
/** A live player economy/action record from bw_hud_players. */
export interface BwsimPlayer {
    readonly owner: number;
    readonly minerals: number;
    readonly gas: number;
    /** Doubled Brood War supply, ordered Zerg, Terran, Protoss. */
    readonly usedSupplyRaw: readonly [number, number, number];
    /** Doubled Brood War supply, ordered Zerg, Terran, Protoss. */
    readonly maxSupplyRaw: readonly [number, number, number];
    readonly completedWorkers: number;
    readonly actions: number;
}
/** A decoded record from the proven 72-byte bw_hud_units layout. */
export interface BwsimUnit {
    readonly index: number;
    readonly type: number;
    readonly owner: number;
    readonly completed: boolean;
    readonly hidden: boolean;
    readonly x: number;
    readonly y: number;
    /** Raw Brood War fixed-point value (1/256 HP). */
    readonly hpRaw: number;
    readonly maxHpRaw: number;
    /** Convenience values normalized to ordinary HP. */
    readonly hp: number;
    readonly maxHp: number;
    readonly shieldsRaw: number;
    readonly maxShieldsRaw: number;
    readonly energyRaw: number;
    readonly kills: number;
    readonly remainingBuildTime: number;
    readonly totalBuildTime: number;
    readonly resources: number;
    readonly firstQueuedUnitType: number;
    readonly facingX: number;
    readonly facingY: number;
    readonly targetX: number;
    readonly targetY: number;
    readonly researchKind: number;
    readonly researchLevel: number;
    readonly researchId: number;
    readonly researchRemaining: number;
}
export interface LoadedReplayData {
    /** A defensive copy of the original .rep bytes. */
    readonly raw: Uint8Array;
    /** A defensive copy of the converted engine DRPL bytes. */
    readonly drpl: Uint8Array;
}
//# sourceMappingURL=types.d.ts.map