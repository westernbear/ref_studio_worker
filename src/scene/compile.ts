import { createHash } from "node:crypto";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { readonly [key: string]: Json };
export type Geometry = {
  readonly boundsPerFrame: readonly FrameBounds[];
  readonly fixedWidth: boolean;
  readonly fixedX: boolean;
};
export type FrameBounds = {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
export type Owner = {
  readonly ownerId: string;
  readonly kind: string;
  readonly editable: boolean;
  readonly assetRef: string;
  readonly confidence: number;
  readonly content?: string | undefined;
};
export type Asset = {
  readonly assetId: string;
  readonly kind: string;
  readonly editable: boolean;
  readonly owner: string;
  readonly [key: string]: Json;
};
export type Lifecycle = {
  readonly enter?: Json | undefined;
  readonly stable?: Json | undefined;
  readonly exit?: Json | undefined;
};
export type Track = {
  readonly trackId: string;
  readonly owner: string;
  readonly lifecycle: Lifecycle;
  readonly geometryRef: string;
  readonly effects: readonly string[];
};
export type AudioAnchor = {
  readonly anchorId: string;
  readonly frame: number;
  readonly sample: number;
  readonly owner: string;
  readonly role: string;
  readonly confidence: number;
};
export type Pass = {
  readonly passId: string;
  readonly owner: string;
  readonly kind: "DOM/SVG" | "WebGL2";
  readonly shader: string | null;
  readonly reads: readonly string[];
  readonly writes: string;
};

export type EvidenceInput = {
  readonly tenantId: string;
  readonly editor: string;
  readonly reason: string;
  readonly timestamp: string;
  readonly gate: "APPROVED" | "PENDING" | "REJECTED";
  readonly needsChoice?: readonly Json[] | undefined;
  readonly owners: readonly Owner[];
  readonly editableAssets: readonly Asset[];
  readonly geometry: Readonly<Record<string, Geometry>>;
  readonly tracks: readonly Track[];
  readonly effects: Readonly<Record<string, Readonly<Record<string, Json>>>>;
  readonly residualCanvas: {
    readonly owner: string;
    readonly measurements: readonly string[];
    readonly mustRemainSeparate: boolean;
    readonly compositeRule: string;
  };
  readonly audio: {
    readonly sampleRateHz: number;
    readonly channels: number;
    readonly frameRate?: number | undefined;
    readonly anchors: readonly AudioAnchor[];
  };
  readonly passes: readonly Pass[];
  readonly layerOrder: readonly string[];
  readonly allowedShaders: readonly string[];
};

export type VersionRecord = {
  readonly versionId: string;
  readonly digest: string;
  readonly parentDigest: string | null;
  readonly editor: string;
  readonly reason: string;
  readonly timestamp: string;
};
export type AuthoringIR = VersionRecord & {
  readonly schema: "authoring-ir-v1";
  readonly tenantId: string;
  readonly owners: readonly Owner[];
  readonly editableAssets: readonly Asset[];
  readonly uncertainty: Readonly<Record<string, Json>>;
};
export type SceneIR = VersionRecord & {
  readonly schema: "scene-ir-v1";
  readonly tenantId: string;
  readonly authoringVersionId: string;
  readonly tracks: readonly Track[];
  readonly geometry: Readonly<Record<string, Geometry>>;
  readonly effects: Readonly<Record<string, Readonly<Record<string, Json>>>>;
  readonly residualCanvas: EvidenceInput["residualCanvas"];
  readonly audio: EvidenceInput["audio"];
};
export type BrowserPassSpec = VersionRecord & {
  readonly schema: "browser-pass-spec-v1";
  readonly tenantId: string;
  readonly sceneVersionId: string;
  readonly passList: readonly Pass[];
  readonly layerOrder: readonly string[];
  readonly approvalDigest: string;
  readonly previewDigest: string;
  readonly renderDigest: string;
};
export type Compilation = {
  readonly authoring: AuthoringIR;
  readonly scene: SceneIR;
  readonly browserPassSpec: BrowserPassSpec;
};

const isJsonObject = (
  value: unknown,
): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function fail(token: string): never {
  throw new Error(token);
}
function record<T extends object>(
  value: T,
  parentDigest: string | null,
  metadata: Pick<EvidenceInput, "editor" | "reason" | "timestamp">,
  prefix: string,
): T & VersionRecord {
  const contentDigest = digest(value);
  return {
    ...value,
    versionId: `${prefix}_${contentDigest.slice(0, 16)}`,
    digest: contentDigest,
    parentDigest,
    ...metadata,
  };
}

export function compileScene(
  evidence: EvidenceInput,
  preview = false,
): Compilation {
  if (evidence.gate !== "APPROVED" && !(preview && evidence.gate === "PENDING"))
    fail("UNAPPROVED_GATE");
  if ((evidence.needsChoice?.length ?? 0) > 0) fail("UNRESOLVED_CHOICE");
  if (evidence.audio.sampleRateHz !== 48000 || evidence.audio.channels !== 2)
    fail("INVALID_AUDIO_RATE");
  const owners = new Map(
    evidence.owners.map((owner) => [owner.ownerId, owner]),
  );
  if (owners.size !== evidence.owners.length) fail("OWNER_MISMATCH");
  const assetIds = new Set(
    evidence.editableAssets.map((asset) => asset.assetId),
  );
  for (const owner of evidence.owners) {
    if (!assetIds.has(owner.assetRef)) fail("OWNER_MISMATCH");
    if (!(owner.ownerId in evidence.geometry))
      fail("MISSING_MEASURED_GEOMETRY");
  }
  for (const asset of evidence.editableAssets)
    if (!owners.has(asset.owner)) fail("OWNER_MISMATCH");
  const effectNames = new Set(
    Object.values(evidence.effects).flatMap((effects) => Object.keys(effects)),
  );
  const consumedEffects = new Set(
    evidence.tracks.flatMap((track) => track.effects),
  );
  for (const effect of effectNames)
    if (!consumedEffects.has(effect) && effect !== "residual-canvas")
      fail("UNCONSUMED_EFFECT");
  for (const track of evidence.tracks) {
    if (!owners.has(track.owner)) fail("OWNER_MISMATCH");
    if (!(track.geometryRef in evidence.geometry)) fail("INVENTED_GEOMETRY");
    if (
      !track.lifecycle.enter ||
      !track.lifecycle.stable ||
      !track.lifecycle.exit
    )
      fail("INVALID_LIFECYCLE");
    for (const effect of track.effects)
      if (
        !evidence.effects[track.owner]?.[effect] &&
        effect !== "residual-canvas"
      )
        fail("UNBOUND_EFFECT");
  }
  if (
    !evidence.residualCanvas.mustRemainSeparate ||
    !owners.get(evidence.residualCanvas.owner) ||
    owners.get(evidence.residualCanvas.owner)?.kind !== "residual-canvas"
  )
    fail("RESIDUAL_SEPARATION");
  for (const anchor of evidence.audio.anchors) {
    if (!owners.has(anchor.owner)) fail("OWNER_MISMATCH");
    if (
      anchor.sample !==
      Math.round((anchor.frame / (evidence.audio.frameRate ?? 30)) * 48000)
    )
      fail("INVALID_AUDIO_MAPPING");
  }
  const allowed = new Set(evidence.allowedShaders);
  for (const pass of evidence.passes) {
    if (!pass.owner.split(",").every((owner) => owners.has(owner)))
      fail("OWNER_MISMATCH");
    if (pass.shader !== null && !allowed.has(pass.shader))
      fail("SHADER_NOT_ALLOWLISTED");
    if (!evidence.layerOrder.includes(pass.writes)) fail("PASS_ORDER_MISMATCH");
  }
  const authoring = record(
    {
      schema: "authoring-ir-v1" as const,
      tenantId: evidence.tenantId,
      owners: evidence.owners,
      editableAssets: evidence.editableAssets,
      uncertainty: Object.fromEntries(
        evidence.owners.map((owner) => [
          owner.ownerId,
          { confidence: owner.confidence },
        ]),
      ),
    },
    null,
    evidence,
    "air",
  );
  const scene = record(
    {
      schema: "scene-ir-v1" as const,
      tenantId: evidence.tenantId,
      authoringVersionId: authoring.versionId,
      tracks: evidence.tracks,
      geometry: evidence.geometry,
      effects: evidence.effects,
      residualCanvas: evidence.residualCanvas,
      audio: evidence.audio,
    },
    authoring.digest,
    evidence,
    "sir",
  );
  const spec = record(
    {
      schema: "browser-pass-spec-v1" as const,
      tenantId: evidence.tenantId,
      sceneVersionId: scene.versionId,
      passList: evidence.passes,
      layerOrder: evidence.layerOrder,
      approvalDigest: scene.digest,
      previewDigest: scene.digest,
      renderDigest: scene.digest,
    },
    scene.digest,
    evidence,
    "bps",
  );
  return { authoring, scene, browserPassSpec: spec };
}
