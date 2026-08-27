import { SceneSpecSchema, type SceneSpec } from "@rvs/contracts";

// Fail-closed on a SceneSpec the renderer cannot honestly draw. Pure
// function, no I/O, no clock -- same style as compileScene in ./compile.js.
export class SpecError extends Error {
  readonly token: string;
  constructor(token: string) {
    super(token);
    this.name = "SpecError";
    this.token = token;
  }
}

const fail = (token: string): never => {
  throw new SpecError(token);
};

const EXTERNAL_URL = /^https?:\/\//iu;

export function validateSceneSpec(
  spec: unknown,
  resolvable: ReadonlySet<string>,
): SceneSpec {
  const parsed = SceneSpecSchema.safeParse(spec);
  if (!parsed.success) return fail("SPEC_SCHEMA_INVALID");
  const value = parsed.data;

  for (const beat of value.beats)
    if (
      beat.startFrame < 0 ||
      beat.endFrame <= beat.startFrame ||
      beat.endFrame > value.canvas.frameCount
    )
      fail("BEAT_OUT_OF_RANGE");

  for (let left = 0; left < value.beats.length; left++)
    for (let right = left + 1; right < value.beats.length; right++) {
      const a = value.beats[left]!;
      const b = value.beats[right]!;
      if (a.startFrame < b.endFrame && b.startFrame < a.endFrame)
        fail("BEAT_OVERLAP");
    }

  for (const beat of value.beats)
    for (const element of beat.elements)
      for (const keyframe of element.keyframes)
        if (keyframe.frame < beat.startFrame || keyframe.frame > beat.endFrame)
          fail("KEYFRAME_OUT_OF_BEAT");

  for (const beat of value.beats)
    for (const element of beat.elements)
      if (element.content !== undefined && EXTERNAL_URL.test(element.content))
        fail("EXTERNAL_URL");

  const assetsById = new Map(
    value.assets.map((asset) => [asset.assetId, asset] as const),
  );
  for (const beat of value.beats)
    for (const element of beat.elements)
      if (element.assetRef !== undefined) {
        const asset = assetsById.get(element.assetRef);
        if (!asset || !resolvable.has(element.assetRef))
          fail("ASSET_REF_UNRESOLVED");
      }

  for (const asset of value.assets)
    if (asset.origin === "generated" && asset.provenance === undefined)
      fail("GENERATED_ASSET_WITHOUT_PROVENANCE");

  return value;
}
