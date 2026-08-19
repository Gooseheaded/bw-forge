export interface AssetPackEntry {
    readonly name: string;
    readonly bytes: Uint8Array;
}
/** Parse the proven sim.pack format, preserving manifest order. */
export declare function parseAssetPack(input: Uint8Array): readonly AssetPackEntry[];
//# sourceMappingURL=asset-pack.d.ts.map