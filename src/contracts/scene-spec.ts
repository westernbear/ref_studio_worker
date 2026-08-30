// Vendored from packages/contracts/src/scene-spec.ts — do not hand-edit.
// apps/worker is a standalone deployable (own Dockerfile/lockfile/workspace)
// and cannot depend on packages/contracts via "workspace:*" in a clean
// container build. This is a byte-for-byte copy of the pure module; the
// drift test in apps/api/src/worker-contracts-vendoring.test.ts is what
// keeps it honest -- if it fails, re-copy from packages/contracts/src.
// ---- vendored copy below, unmodified ----

import { z } from "zod";

// The scene an AI (or, in this batch, a human) authors. A validated
// SceneSpec is the only input the deterministic compiler (spec-compile.ts,
// apps/worker) accepts -- there is no other path from "idea" to "frames".
//
// Phase 2 covers DOM/SVG rendering only. SPEC_EFFECTS therefore lists only
// effects expressible as SVG filter primitives, not the owner-bound WebGL
// shaders in apps/worker/src/render-app/webgl.ts (those consume measured
// effect samples from evidence, which a generated scene does not have).
//
// The bar for entry is stricter than "expressible as SVG": two independent
// real-Chromium renders of a fixture using the effect must produce
// identical frame hashes (apps/worker's gen-render-delivery.determinism
// test is the gate). `blur` and `glow` were tried as SVG filters and
// dropped -- both compiled to feGaussianBlur, which is not bit-reproducible
// across independent Chromium process launches under
// --use-angle=swiftshader.
//
// `drop-shadow` (native feDropShadow) was clean across every trial for as
// long as the only thing on screen was the filtered element itself. Once
// the renderer started painting a real background under it (generated.ts,
// I5 batch -- a scene that asks for pure black must not render white) and
// giving it a real, non-default fill from the palette instead of the
// capture page's stylesheet white, feDropShadow's shadow layer stopped
// being bit-reproducible: a colour-filled, drop-shadowed element composited
// over an opaque backdrop produced two distinct outputs across repeated
// renders of byte-identical markup within a single Chromium session, let
// alone across independent launches (apps/worker's
// gen-render-delivery.determinism test caught it; isolating the filtered
// element in its own stacking context via `isolation: isolate` or a nested
// `<svg>` did not help). Filters were tried twice (blur/glow, then
// drop-shadow) and failed both times -- the raster <filter> pipeline itself
// is where the non-determinism lives, not any one primitive.
//
// `glow` and `drop-shadow` were both tried a third time, as pure geometry
// instead of filters: apps/worker/src/render-app/generated.ts drew a glow
// as a scaled-up, lower-opacity copy of the element, and a drop-shadow as
// one offset, darkened copy -- both composited with nothing but
// fill/opacity/translate, the same primitives that already render text,
// rects and images reproducibly, and both re-proven against the exact
// condition that killed feDropShadow (a filled element over a painted
// background). Only `drop-shadow` survived. Its unscaled, translate-only
// copy held clean across dozens of real-Chromium determinism runs,
// including under the concurrent CPU load of the full test suite -- the
// condition that turned out to matter, since a single isolated re-run of
// the gate can pass by chance even when an effect is not actually
// reliable. `glow`'s scaled copy did not: even pixel-snapped and cut down
// to one layer, it still failed intermittently once the gate ran under
// that same concurrent load. Scaling a copy, not stacking several, is
// what keeps landing geometry back in the same failure mode as the raster
// <filter> attempts above -- see gen-render-delivery.determinism.test.ts's
// own comment for the full run log. `glow` is dropped a second time;
// `blur` was never geometry-shaped to begin with and stays dropped too.
export const SPEC_EFFECTS = ["drop-shadow"] as const;

// The weights a text element may ask for. Named and constrained for the
// same reason SPEC_EFFECTS is (see the comment above it): this schema is
// also the AI's structured-output schema, so a Zod enum becomes a JSON
// Schema enum and the model cannot emit 437 or 250 -- which a free number
// invites. The bundled Wanted Sans Variable has a `wght` axis measured at
// 400-1000, and each named value is a real point on it that earns its
// place: `regular` for body lines, `bold` for emphasis (also the capture
// page's own default, so a scene that names nothing renders exactly as it
// did before this field existed), `black` for the axis maximum -- a number
// or a headline that has to land. Hierarchy is built by contrasting them
// within a beat, not by making everything heavy.
export const SPEC_TEXT_WEIGHTS = ["regular", "bold", "black"] as const;
export type SpecTextWeight = (typeof SPEC_TEXT_WEIGHTS)[number];
// The name-to-axis mapping. Lives here rather than in the renderer because
// it is the other half of the decision above -- the named set is only
// meaningful alongside the numbers it stands for.
export const SPEC_TEXT_WEIGHT_AXIS: Readonly<Record<SpecTextWeight, number>> = {
  regular: 400,
  bold: 700,
  black: 1000,
};

// How a generated asset's material is *made*, as opposed to `kind`, which
// is what the renderer draws with it. `object` routes the asset to the
// self-hosted Hi3DGen+Blender provider, which generates a mesh and renders
// one still of it; `flat` (the default, and the common case) routes it to
// the 2D image provider. Deliberately not a `kind` value: both paths hand
// back a PNG the renderer draws as an image, so a kind that said "3d
// model" would be a lie in the type -- the renderer has no mesh to draw.
// Only meaningful on a generated asset; validateSceneSpec says so.
export const SPEC_ASSET_FORMS = ["flat", "object"] as const;
export type SpecAssetForm = (typeof SPEC_ASSET_FORMS)[number];

export const SPEC_EASINGS = [
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
] as const;
export type Ease = (typeof SPEC_EASINGS)[number];
export type KeyframeV1 = {
  readonly frame: number;
  readonly opacity?: number | undefined;
  readonly scale?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly ease: Ease;
};
export type KeyframeV2 = {
  readonly frame: number;
  readonly opacity?: number | undefined;
  readonly scaleX?: number | undefined;
  readonly scaleY?: number | undefined;
  readonly rotation?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly ease: Ease;
};
export type Keyframe = KeyframeV1 | KeyframeV2;

type SpecElementBase = {
  readonly elementId: string;
  readonly kind: "text" | "image" | "shape" | "video";
  readonly assetRef?: string | undefined;
  readonly content?: string | undefined;
  // Text only, and optional: absent means the capture page's own default
  // weight, so every scene authored before this field existed renders
  // byte-identically.
  readonly weight?: SpecTextWeight | undefined;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly effects: readonly string[];
};
export type SpecElementV1 = SpecElementBase & {
  readonly keyframes: readonly KeyframeV1[];
};
export type SpecElementV2 = SpecElementBase & {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly parentElementId?: string | undefined;
  readonly keyframes: readonly KeyframeV2[];
};
export type SpecElement = SpecElementV1 | SpecElementV2;

type BeatBase = {
  readonly beatId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly shot:
    | "push-in"
    | "hard-cut"
    | "ring-expand"
    | "tile-grid"
    | "type-flash";
};
export type BeatV1 = BeatBase & { readonly elements: readonly SpecElementV1[] };
export type BeatV2 = BeatBase & { readonly elements: readonly SpecElementV2[] };
export type Beat = BeatV1 | BeatV2;
export type SpecAsset = {
  readonly assetId: string;
  readonly kind: "image" | "video" | "audio" | "font" | "color";
  readonly origin: "attachment" | "evidence" | "generated";
  readonly ref: string;
  // Absent means "flat" -- so every scene authored before this field
  // existed asks for exactly the material it always did.
  readonly form?: SpecAssetForm | undefined;
  readonly audio?:
    | {
        readonly gainDb: number;
        readonly durationPolicy: "trim" | "pad" | "reject";
      }
    | undefined;
  // Two halves with two different authors. `prompt` and `seed` are the
  // scene author's intent -- what to make and with what seed -- and are
  // the only parts the model can honestly supply. `tool` and `sha256` are
  // facts about bytes that do not exist yet when the scene is written, so
  // they are absent at authoring time and filled in by the assets stage
  // from what the material provider actually produced (see workers.ts's
  // generated-asset completion, which verifies the hash against the stored
  // bytes before recording it). Requiring all four from the model made it
  // invent a tool name and a hash -- observed in production: `tool:
  // "midjourney"` and a "sha256" that was not hexadecimal.
  readonly provenance?:
    | {
        readonly tool?: string | undefined;
        readonly prompt: string;
        readonly seed?: number | undefined;
        readonly sha256?: string | undefined;
      }
    | undefined;
};
type SceneSpecBase = {
  readonly mode: "SWAP" | "REINTERPRET";
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly frameCount: number;
  };
  readonly palette: {
    readonly hero: string;
    readonly cool: string;
    readonly warm: string;
    readonly background: string;
  };
  readonly assets: readonly SpecAsset[];
};
export type SceneSpecV1 = SceneSpecBase & {
  readonly schema: "scene-spec-v1";
  readonly beats: readonly BeatV1[];
};
export type SceneSpecV2 = SceneSpecBase & {
  readonly schema: "scene-spec-v2";
  readonly beats: readonly BeatV2[];
};
export type SceneSpec = SceneSpecV1 | SceneSpecV2;

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

const FiniteNumberSchema = z.number().finite();

const KeyframeV1Schema = z
  .object({
    frame: z.number().int().nonnegative(),
    opacity: z.number().min(0).max(1).optional(),
    scale: z.number().positive().optional(),
    x: FiniteNumberSchema.optional(),
    y: FiniteNumberSchema.optional(),
    ease: z.enum(SPEC_EASINGS),
  })
  .strict();

const KeyframeV2Schema = z
  .object({
    frame: z.number().int().nonnegative(),
    opacity: FiniteNumberSchema.min(0).max(1).optional(),
    scaleX: FiniteNumberSchema.optional(),
    scaleY: FiniteNumberSchema.optional(),
    rotation: FiniteNumberSchema.optional(),
    x: FiniteNumberSchema.optional(),
    y: FiniteNumberSchema.optional(),
    ease: z.enum(SPEC_EASINGS),
  })
  .strict();

const BoxSchema = z
  .object({
    x: FiniteNumberSchema,
    y: FiniteNumberSchema,
    width: FiniteNumberSchema.positive(),
    height: FiniteNumberSchema.positive(),
  })
  .strict();

const SpecElementBaseShape = {
  elementId: z.string().min(1),
  kind: z.enum(["text", "image", "shape", "video"]),
  assetRef: z.string().min(1).optional(),
  content: z.string().optional(),
  weight: z.enum(SPEC_TEXT_WEIGHTS).optional(),
  box: BoxSchema,
  effects: z.array(z.enum(SPEC_EFFECTS)),
} as const;

const SpecElementV1Schema = z
  .object({
    ...SpecElementBaseShape,
    keyframes: z.array(KeyframeV1Schema),
  })
  .strict();

const SpecElementV2Schema = z
  .object({
    ...SpecElementBaseShape,
    anchor: z.object({ x: FiniteNumberSchema, y: FiniteNumberSchema }).strict(),
    parentElementId: z.string().min(1).optional(),
    keyframes: z.array(KeyframeV2Schema),
  })
  .strict();

const beatShape = {
  beatId: z.string().min(1),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
  shot: z.enum([
    "push-in",
    "hard-cut",
    "ring-expand",
    "tile-grid",
    "type-flash",
  ]),
} as const;

const BeatV1Schema = z
  .object({
    ...beatShape,
    elements: z.array(SpecElementV1Schema),
  })
  .strict();

const BeatV2Schema = z
  .object({ ...beatShape, elements: z.array(SpecElementV2Schema) })
  .strict();

const SpecAssetSchema = z
  .object({
    assetId: z.string().min(1),
    kind: z.enum(["image", "video", "audio", "font", "color"]),
    origin: z.enum(["attachment", "evidence", "generated"]),
    ref: z.string().min(1),
    form: z.enum(SPEC_ASSET_FORMS).optional(),
    audio: z
      .object({
        gainDb: FiniteNumberSchema.min(-24).max(12),
        durationPolicy: z.enum(["trim", "pad", "reject"]),
      })
      .strict()
      .optional(),
    provenance: z
      .object({
        tool: z.string().min(1).optional(),
        prompt: z.string().min(1),
        seed: z.number().optional(),
        sha256: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (asset.kind === "audio") {
      if (asset.origin !== "attachment")
        context.addIssue({
          code: "custom",
          message: "audio must be local attachment",
        });
      if (asset.audio === undefined)
        context.addIssue({
          code: "custom",
          message: "audio policy is required",
        });
    } else if (asset.audio !== undefined)
      context.addIssue({
        code: "custom",
        message: "audio policy is only valid for audio",
      });
  });

const SceneSpecBaseShape = {
  mode: z.enum(["SWAP", "REINTERPRET"]),
  canvas: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().int().positive(),
      frameCount: z.number().int().positive(),
    })
    .strict(),
  palette: z
    .object({
      hero: z.string().regex(HEX_COLOR),
      cool: z.string().regex(HEX_COLOR),
      warm: z.string().regex(HEX_COLOR),
      background: z.string().regex(HEX_COLOR),
    })
    .strict(),
  assets: z.array(SpecAssetSchema),
} as const;

const SceneSpecV1Schema = z
  .object({
    ...SceneSpecBaseShape,
    schema: z.literal("scene-spec-v1"),
    beats: z.array(BeatV1Schema),
  })
  .strict();

const SceneSpecV2Schema = z
  .object({
    ...SceneSpecBaseShape,
    schema: z.literal("scene-spec-v2"),
    beats: z.array(BeatV2Schema),
  })
  .strict();

export const SceneSpecSchema: z.ZodType<SceneSpec> = z.discriminatedUnion(
  "schema",
  [SceneSpecV1Schema, SceneSpecV2Schema],
);
