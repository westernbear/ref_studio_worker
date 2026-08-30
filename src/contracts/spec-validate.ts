// Vendored from packages/contracts/src/spec-validate.ts — do not hand-edit.
// apps/worker is a standalone deployable (own Dockerfile/lockfile/workspace)
// and cannot depend on packages/contracts via "workspace:*" in a clean
// container build. This is a byte-for-byte copy of the pure module; the
// drift test in apps/api/src/worker-contracts-vendoring.test.ts is what
// keeps it honest -- if it fails, re-copy from packages/contracts/src.
// ---- vendored copy below, unmodified ----

import {
  SceneSpecSchema,
  type BeatV2,
  type SceneSpec,
  type SpecElementV2,
} from "./scene-spec.js";

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
  // The token alone says a rule was broken, not which value broke it. A
  // live ASSET_REF_UNRESOLVED took a database dump and a replay against
  // the provider to trace back to the one asset at fault; the detail
  // carries that in the message, while `token` stays exactly the token so
  // callers matching on it are unaffected.
  constructor(token: string, detail?: string) {
    super(detail ? `${token}: ${detail}` : token);
    this.name = "SpecError";
    this.token = token;
  }
}

const fail = (token: string, detail?: string): never => {
  throw new SpecError(token, detail);
};

const EXTERNAL_URL = /^https?:\/\//iu;

export function topologicallyOrderedElements(
  beat: BeatV2,
): readonly SpecElementV2[] {
  const byId = new Map<string, SpecElementV2>();
  for (const element of beat.elements) {
    if (byId.has(element.elementId)) fail("ELEMENT_ID_DUPLICATE");
    byId.set(element.elementId, element);
  }
  for (const element of beat.elements)
    if (
      element.parentElementId !== undefined &&
      !byId.has(element.parentElementId)
    )
      fail("PARENT_NOT_FOUND");

  const remaining = new Map(byId);
  const emitted = new Set<string>();
  const ordered: SpecElementV2[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(
        (element) =>
          element.parentElementId === undefined ||
          emitted.has(element.parentElementId),
      )
      .sort((left, right) => left.elementId.localeCompare(right.elementId));
    if (ready.length === 0) fail("PARENT_CYCLE");
    for (const element of ready) {
      ordered.push(element);
      emitted.add(element.elementId);
      remaining.delete(element.elementId);
    }
  }
  return ordered;
}

export type ValidateSceneSpecOptions = Readonly<{
  // Whether a generated asset must already carry the half of its
  // provenance that only exists once its bytes do (`tool` and `sha256`).
  // False while the scene is being authored -- the model cannot know
  // either, and demanding them made it invent both. True at render time,
  // which is where the evidence-first guarantee has to hold: nothing gets
  // drawn from generated material whose origin is not recorded as fact.
  requireGeneratedOutput?: boolean;
}>;

export function validateSceneSpec(
  spec: unknown,
  resolvable: ReadonlySet<string>,
  options: ValidateSceneSpecOptions = {},
): SceneSpec {
  const parsed = SceneSpecSchema.safeParse(spec);
  if (!parsed.success) return fail("SPEC_SCHEMA_INVALID");
  const value = parsed.data;

  if (value.schema === "scene-spec-v2")
    for (const beat of value.beats) topologicallyOrderedElements(beat);

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
  const orderedBeats = value.beats
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame);
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
        if (!asset)
          fail(
            "ASSET_REF_UNRESOLVED",
            `element ${element.elementId} names asset ${element.assetRef}, which the spec does not declare`,
          );
        else if (!resolvable.has(element.assetRef))
          fail(
            "ASSET_REF_UNRESOLVED",
            `asset ${element.assetRef} (origin ${asset.origin}) is not backed by anything this job supplied`,
          );
      }

  for (const asset of value.assets)
    if (asset.origin === "generated") {
      if (asset.provenance === undefined)
        fail(
          "GENERATED_ASSET_WITHOUT_PROVENANCE",
          `asset ${asset.assetId} records no prompt for what it is`,
        );
      else if (options.requireGeneratedOutput && asset.kind !== "color") {
        if (!asset.provenance.tool)
          fail(
            "GENERATED_ASSET_WITHOUT_PROVENANCE",
            `asset ${asset.assetId} names no tool, so nothing records what made it`,
          );
        if (!asset.provenance.sha256)
          fail(
            "GENERATED_ASSET_WITHOUT_PROVENANCE",
            `asset ${asset.assetId} records no output hash, so its bytes are unaccounted for`,
          );
      }
    }

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
