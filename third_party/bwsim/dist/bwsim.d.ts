import type { BwsimOptions, BwsimPlayer, BwsimReplayHeader, BwsimUnit, LoadedReplayData, ReplayUnitIdNamespace } from "./types.js";
/** Headless wrapper around the established bwsim WebAssembly host contract. */
export declare class Bwsim {
    #private;
    readonly assetCount: number;
    private constructor();
    static create(options: BwsimOptions): Promise<Bwsim>;
    loadReplay(path: string | URL): Promise<void>;
    loadReplayBytes(bytes: Uint8Array): Promise<void>;
    replayData(): LoadedReplayData | undefined;
    /** Return the UnitId namespace used by the loaded source replay. */
    replayUnitIdNamespace(): ReplayUnitIdNamespace | undefined;
    /** Map a native generation-safe bwsim UnitId into the loaded replay's namespace. */
    toReplayUnitId(nativeId: number): number | null;
    currentFrame(): number;
    /** Read static metadata for the loaded replay, or undefined before a replay is available. */
    replayHeader(): BwsimReplayHeader | undefined;
    /** Read the twelve live player economy/action records. Supply values remain doubled and race-indexed. */
    players(): readonly BwsimPlayer[];
    /** Return the engine's generation-bearing UnitId for a current live HUD slot. */
    unitInstanceId(index: number): number | null;
    /** Return the current five-slot production queue for a live HUD unit. */
    unitBuildQueue(index: number): readonly number[];
    /** Advance by a requested number of frames. The returned current frame is authoritative. */
    step(frames: number): number;
    /** Seek using the proven reload-and-step behavior. */
    stepTo(frame: number): number;
    units(): readonly BwsimUnit[];
}
//# sourceMappingURL=bwsim.d.ts.map