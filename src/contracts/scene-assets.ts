// Vendored from packages/contracts/src/scene-assets.ts — do not hand-edit.
// apps/worker is a standalone deployable (own Dockerfile/lockfile/workspace)
// and cannot depend on packages/contracts via "workspace:*" in a clean
// container build. This is a byte-for-byte copy of the pure module; the
// drift test in apps/api/src/worker-contracts-vendoring.test.ts is what
// keeps it honest -- if it fails, re-copy from packages/contracts/src.
// ---- vendored copy below, unmodified ----

import type { SceneSpec, SpecAsset, SpecAssetForm } from "./scene-spec.js";

// Which of a SceneSpec's assets still have to be turned into real bytes
// before the scene can be rendered, and where each one's bytes come from.
//
// Pure function, no I/O, no clock -- same style as validateSceneSpec in
// ./spec-validate.ts. It is the whole decision the `assets` worker phase
// makes; the phase itself is only the I/O around this answer. It lives in
// packages/contracts because both sides need the identical answer: the
// worker to know what to fetch or generate, and the API to check that what
// the worker reported back covers exactly that set and nothing else.
//
// Fail-closed throughout: an asset this cannot honestly place is a
// SceneAssetError, never a guess. Guessing which upload "attachment://
// hero.png" meant is precisely the silent substitution the generate track
// must not do.
export class SceneAssetError extends Error {
  readonly token: string;
  readonly assetId: string;
  constructor(token: string, assetId: string) {
    super(`${token}:${assetId}`);
    this.name = "SceneAssetError";
    this.token = token;
    this.assetId = assetId;
  }
}

// The only asset kinds that resolve to a file. A "color" asset's ref *is*
// its value, so it never needs bytes.
export type MaterialKind = "image" | "video" | "audio" | "font";

export type SceneAssetSource =
  | Readonly<{ origin: "attachment"; attachmentId: string }>
  | Readonly<{
      origin: "generated";
      prompt: string;
      seed: number | null;
      // Normalised here rather than left optional, so every consumer of a
      // plan answers "flat or object?" the same way instead of each one
      // re-deciding what an absent field meant.
      form: SpecAssetForm;
    }>;

export type RequiredSceneAsset = Readonly<{
  assetId: string;
  kind: MaterialKind;
  source: SceneAssetSource;
}>;

export type SceneAssetPlan = Readonly<{
  // In spec.assets order, so two independent runs of this function produce
  // the same list and the API can compare it positionally if it wants to.
  required: readonly RequiredSceneAsset[];
  // Asset ids that need no bytes at all: colours, and assets nothing in the
  // scene actually draws.
  inline: readonly string[];
}>;

// The ref format an attachment-origin asset must use. The authoring prompt
// hands the model the job's attachment ids and tells it to name one here;
// anything else (a filename, a bare id, an invented path) is unresolvable,
// because the API's attachment store is keyed by id and by nothing else.
const ATTACHMENT_REF = /^attachment:\/\/(?<attachmentId>[^/?#]+)$/u;

const referencedAssetIds = (spec: SceneSpec): ReadonlySet<string> => {
  const referenced = new Set<string>();
  for (const beat of spec.beats)
    for (const element of beat.elements)
      if (element.assetRef !== undefined) referenced.add(element.assetRef);
  return referenced;
};

// Fonts are required even when no element names them: the render app loads
// every font asset as a font family up front (see gen-render-delivery.ts's
// fontAssets), not through an element's assetRef.
const needsBytes = (
  asset: SpecAsset,
  referenced: ReadonlySet<string>,
): asset is SpecAsset & { kind: MaterialKind } =>
  asset.kind !== "color" &&
  (asset.kind === "font" ||
    asset.kind === "audio" ||
    referenced.has(asset.assetId));

const sourceFor = (asset: SpecAsset): SceneAssetSource => {
  if (asset.origin === "attachment") {
    const attachmentId = ATTACHMENT_REF.exec(asset.ref)?.groups?.[
      "attachmentId"
    ];
    if (!attachmentId)
      throw new SceneAssetError("ASSET_ATTACHMENT_UNRESOLVED", asset.assetId);
    return { origin: "attachment", attachmentId };
  }
  if (asset.origin === "evidence")
    // The measured evidence is geometry, timing, colour and text -- it
    // carries no pixels and no font files. An evidence-origin asset can
    // therefore only ever be a colour (handled by needsBytes above); one
    // that wants bytes is asking for something the evidence does not hold.
    throw new SceneAssetError("ASSET_EVIDENCE_NOT_MATERIAL", asset.assetId);
  const prompt = asset.provenance?.prompt;
  if (!prompt)
    throw new SceneAssetError("ASSET_GENERATED_WITHOUT_PROMPT", asset.assetId);
  return {
    origin: "generated",
    prompt,
    seed: asset.provenance?.seed ?? null,
    form: asset.form ?? "flat",
  };
};

export function planSceneAssets(
  spec: SceneSpec,
  available: Readonly<{ attachmentIds: readonly string[] }>,
): SceneAssetPlan {
  const attachmentIds = new Set(available.attachmentIds);
  const referenced = referencedAssetIds(spec);
  const seen = new Set<string>();
  const required: RequiredSceneAsset[] = [];
  const inline: string[] = [];
  for (const asset of spec.assets) {
    if (seen.has(asset.assetId))
      throw new SceneAssetError("ASSET_ID_DUPLICATE", asset.assetId);
    seen.add(asset.assetId);
    if (!needsBytes(asset, referenced)) {
      inline.push(asset.assetId);
      continue;
    }
    const source = sourceFor(asset);
    if (
      source.origin === "attachment" &&
      !attachmentIds.has(source.attachmentId)
    )
      throw new SceneAssetError("ASSET_ATTACHMENT_UNRESOLVED", asset.assetId);
    required.push({ assetId: asset.assetId, kind: asset.kind, source });
  }
  return { required, inline };
}
