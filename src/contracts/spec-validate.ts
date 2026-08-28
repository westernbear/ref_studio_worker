// Vendored from packages/contracts/src/spec-validate.ts — do not hand-edit.
// apps/worker is a standalone deployable (own Dockerfile/lockfile/workspace)
// and cannot depend on packages/contracts via "workspace:*" in a clean
// container build. This is a byte-for-byte copy of the pure module; the
// drift test in apps/api/src/worker-contracts-vendoring.test.ts is what
// keeps it honest -- if it fails, re-copy from packages/contracts/src.
// ---- vendored copy below, unmodified ----

import { SceneSpecSchema, type SceneSpec } from "./scene-spec.js";

// Fail-closed on a SceneSpec the renderer cannot honestly draw. Pure
// function, no I/O, no clock -- same style as compileScene in
// apps/worker/src/scene/compile.ts.
//
// Moved here from apps/worker/src/scene/spec-validate.ts (whole-branch
// review finding C2): the API's authorScene() and the worker's
// gen-render-delivery.ts both need this gate, and apps/api cannot import
// from the apps/worker submodule. packages/contracts is the one module
// both processes already depend on.
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

  // Beats must tile [0, frameCount) with no gap and no overlap (C1): the
  // canvas is authoritative from the job's config and can be overwritten
  // after the model authors the spec (see authorScene()), so a beat sheet
  // that was internally consistent against the model's own placeholder
  // canvas can still leave a gap or run past the end once the real canvas
  // is substituted in. BEAT_OVERLAP above already catches any pairwise
  // overlap; this walks beats in start-frame order to catch gaps and
  // misaligned first/last edges too.
  const orderedBeats = value.beats.slice().sort((a, b) => a.startFrame - b.startFrame);
  if (orderedBeats.length === 0 || orderedBeats[0]!.startFrame !== 0)
    fail("BEAT_TILING_INVALID");
  for (let index = 0; index < orderedBeats.length - 1; index++)
    if (orderedBeats[index]!.endFrame !== orderedBeats[index + 1]!.startFrame)
      fail("BEAT_TILING_INVALID");
  if (orderedBeats.at(-1)!.endFrame !== value.canvas.frameCount)
    fail("BEAT_TILING_INVALID");

  for (const beat of value.beats)
    for (const element of beat.elements)
      for (const keyframe of element.keyframes)
        if (keyframe.frame < beat.startFrame || keyframe.frame > beat.endFrame)
          fail("KEYFRAME_OUT_OF_BEAT");

  for (const beat of value.beats)
    for (const element of beat.elements)
      if (element.content !== undefined && EXTERNAL_URL.test(element.content))
        fail("EXTERNAL_URL");

  // Extended to SpecAsset.ref (C2.4): previously only element.content was
  // checked, which left this dead when an asset itself named an external
  // URL as its ref -- logged as a deferred minor on the grounds that
  // nothing consumed asset.ref yet. Now that validateSceneSpec has real
  // callers (authorScene, gen-render-delivery), a generated/attachment
  // asset naming an http(s) URL as its ref must fail the same way.
  for (const asset of value.assets)
    if (EXTERNAL_URL.test(asset.ref)) fail("EXTERNAL_URL");

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

  // `form` says how material is made, so it can only say anything about
  // material this studio makes. An attachment is already whatever the
  // creator uploaded, and evidence carries no pixels at all -- asking
  // either for an "object" is asking for a render that will never happen,
  // which is exactly the silent no-op this file exists to refuse.
  for (const asset of value.assets)
    if (asset.form === "object" && asset.origin !== "generated")
      fail("ASSET_FORM_NOT_GENERATED");

  return value;
}
