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
// test is the gate). `blur` and `glow` were tried and dropped -- both
// compile to feGaussianBlur, which is not bit-reproducible across
// independent Chromium process launches under --use-angle=swiftshader.
// `drop-shadow` (native feDropShadow) was clean across every trial.
export const SPEC_EFFECTS = ["drop-shadow"] as const;

export type Ease = "linear" | "easeIn" | "easeOut" | "easeInOut";
export type Keyframe = {
  readonly frame: number;
  readonly opacity?: number | undefined;
  readonly scale?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly ease: Ease;
};
export type SpecElement = {
  readonly elementId: string;
  readonly kind: "text" | "image" | "shape" | "video";
  readonly assetRef?: string | undefined;
  readonly content?: string | undefined;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly keyframes: readonly Keyframe[];
  readonly effects: readonly string[];
};
export type Beat = {
  readonly beatId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly shot: "push-in" | "hard-cut" | "ring-expand" | "tile-grid" | "type-flash";
  readonly elements: readonly SpecElement[];
};
export type SpecAsset = {
  readonly assetId: string;
  readonly kind: "image" | "video" | "font" | "color";
  readonly origin: "attachment" | "evidence" | "generated";
  readonly ref: string;
  readonly provenance?:
    | {
        readonly tool: string;
        readonly prompt: string;
        readonly seed?: number | undefined;
        readonly sha256: string;
      }
    | undefined;
};
export type SceneSpec = {
  readonly schema: "scene-spec-v1";
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
  readonly beats: readonly Beat[];
};

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

const KeyframeSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    opacity: z.number().min(0).max(1).optional(),
    scale: z.number().positive().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    ease: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]),
  })
  .strict();

const BoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

const SpecElementSchema = z
  .object({
    elementId: z.string().min(1),
    kind: z.enum(["text", "image", "shape", "video"]),
    assetRef: z.string().min(1).optional(),
    content: z.string().optional(),
    box: BoxSchema,
    keyframes: z.array(KeyframeSchema),
    // Enforced right here via z.enum(SPEC_EFFECTS), not downstream as a
    // policy check: in Phase 3 this schema doubles as the AI's
    // structured-output schema, and a Zod enum becomes a JSON Schema enum
    // -- the model literally cannot emit an effect outside the allowlist.
    // Constraining generation beats validating it after the fact.
    effects: z.array(z.enum(SPEC_EFFECTS)),
  })
  .strict();

const BeatSchema = z
  .object({
    beatId: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().nonnegative(),
    shot: z.enum(["push-in", "hard-cut", "ring-expand", "tile-grid", "type-flash"]),
    elements: z.array(SpecElementSchema),
  })
  .strict();

const SpecAssetSchema = z
  .object({
    assetId: z.string().min(1),
    kind: z.enum(["image", "video", "font", "color"]),
    origin: z.enum(["attachment", "evidence", "generated"]),
    ref: z.string().min(1),
    provenance: z
      .object({
        tool: z.string().min(1),
        prompt: z.string().min(1),
        seed: z.number().optional(),
        sha256: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SceneSpecSchema: z.ZodType<SceneSpec> = z
  .object({
    schema: z.literal("scene-spec-v1"),
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
    beats: z.array(BeatSchema),
  })
  .strict();
