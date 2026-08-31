import { sha256Hex, type SceneSpec } from "./contracts/index.js";

export type BeatDependency = Readonly<{
  beatId: string;
  startFrame: number;
  endFrame: number;
  beatDigest: string;
  transitionDigest: string;
  dependencyDigest: string;
}>;

export const buildBeatDependencies = (
  spec: SceneSpec,
  assetDigests: ReadonlyMap<string, string>,
): Readonly<{
  globalAssetDigest: string;
  beats: readonly BeatDependency[];
}> => {
  const assets = new Map(spec.assets.map((asset) => [asset.assetId, asset]));
  const globalAssetDigest = sha256Hex(
    spec.assets
      .filter((asset) => asset.kind === "audio" || asset.kind === "font")
      .map((asset) => [asset.assetId, assetDigests.get(asset.assetId) ?? null])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
  return {
    globalAssetDigest,
    beats: spec.beats.map((beat) => {
      const referencedAssets = beat.elements
        .flatMap((element) => (element.assetRef ? [element.assetRef] : []))
        .map((assetId) => ({
          assetId,
          digest: assetDigests.get(assetId) ?? null,
          asset: assets.get(assetId) ?? null,
        }))
        .sort((left, right) => left.assetId.localeCompare(right.assetId));
      const beatDigest = sha256Hex(beat);
      return {
        beatId: beat.beatId,
        startFrame: beat.startFrame,
        endFrame: beat.endFrame,
        beatDigest,
        transitionDigest: sha256Hex({ shot: beat.shot }),
        dependencyDigest: sha256Hex({ beatDigest, referencedAssets }),
      };
    }),
  };
};
