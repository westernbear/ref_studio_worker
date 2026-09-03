import { createHash } from "node:crypto";
import { canonicalJson } from "../contracts/canonical-json.js";
import type {
  BeatV2,
  Ease,
  KeyframeV1,
  KeyframeV2,
  SceneSpec,
  SpecElementV1,
  SpecElementV2,
  SpecTextWeight,
} from "../contracts/index.js";
import { topologicallyOrderedElements } from "../contracts/index.js";

export type TransformMatrix = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

export type FramePlan = {
  readonly frame: number;
  readonly draws: readonly {
    readonly elementId: string;
    readonly kind: "text" | "image" | "shape" | "video";
    readonly box: { x: number; y: number; width: number; height: number };
    readonly transform?: TransformMatrix;
    readonly opacity: number;
    readonly assetRef?: string;
    readonly content?: string;
    // The element's named font weight, when it asked for one. Carried as
    // the name rather than the axis number: this compiler expands timing,
    // it does not decide typography, and the name-to-number mapping is the
    // schema's (SPEC_TEXT_WEIGHT_AXIS) for the renderer to apply.
    readonly weight?: SpecTextWeight;
    // Not part of the literal Task 2.3 interface, but required so the
    // renderer (Task 2.4) can honour ruling 2: blur/glow/drop-shadow are
    // SVG filter primitives selected per element, and that per-element
    // selection has to survive compilation somehow.
    readonly effects: readonly string[];
  }[];
};
export type SpecCompilation = {
  readonly schema: "spec-compilation-v1";
  readonly versionId: string;
  readonly digest: string;
  readonly canvas: SceneSpec["canvas"];
  // Carried forward so the render app (generated.ts) can paint the
  // background and default a text fill from what the author actually
  // picked, instead of whatever the capture page's shared stylesheet
  // defaults to. See generated.ts for where this is read.
  readonly palette: SceneSpec["palette"];
  readonly frames: readonly FramePlan[];
  readonly passes: readonly {
    readonly passId: string;
    readonly kind: "DOM/SVG";
    readonly shader: string | null;
  }[];
};
// ponytail: each beat's .shot and the top-level .mode are authored,
// schema-validated, and folded into the spec digest, but nothing below
// this line reads them -- FramePlan carries only per-element
// box/opacity/effects. Both are camera and interpretation concerns (push-in
// vs hard-cut, SWAP vs REINTERPRET), not material, and need their own
// design -- this compiler does not invent motion for them. This is a
// deliberate, narrow scope boundary, not an oversight; see the matching
// comment at generated.ts's video-kind fallback for the asset-side half of
// this same boundary.

const EASE: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
};

const valueAtV1 = (
  keyframes: readonly KeyframeV1[],
  frame: number,
  key: "opacity" | "scale" | "x" | "y",
  fallback: number,
): number => {
  const withValue = keyframes
    .filter((keyframe) => keyframe[key] !== undefined)
    .slice()
    .sort((left, right) => left.frame - right.frame);
  if (withValue.length === 0) return fallback;
  const before = withValue.filter((keyframe) => keyframe.frame <= frame).at(-1);
  const after = withValue.find((keyframe) => keyframe.frame >= frame);
  if (!before) return after![key]!;
  if (!after || before.frame === after.frame) return before[key]!;
  const t = (frame - before.frame) / (after.frame - before.frame);
  const eased = EASE[after.ease](Math.min(1, Math.max(0, t)));
  return before[key]! + (after[key]! - before[key]!) * eased;
};

const valueAtV2 = (
  keyframes: readonly KeyframeV2[],
  frame: number,
  key: "opacity" | "rotation" | "scaleX" | "scaleY" | "x" | "y",
  fallback: number,
): number => {
  const withValue = keyframes
    .filter((keyframe) => keyframe[key] !== undefined)
    .slice()
    .sort((left, right) => left.frame - right.frame);
  if (withValue.length === 0) return fallback;
  const before = withValue.filter((keyframe) => keyframe.frame <= frame).at(-1);
  const after = withValue.find((keyframe) => keyframe.frame >= frame);
  if (!before) return after?.[key] ?? fallback;
  if (!after || before.frame === after.frame) return before[key] ?? fallback;
  const start = before[key] ?? fallback;
  const end = after[key] ?? fallback;
  const t = (frame - before.frame) / (after.frame - before.frame);
  return start + (end - start) * EASE[after.ease](Math.min(1, Math.max(0, t)));
};

const multiply = (
  left: TransformMatrix,
  right: TransformMatrix,
): TransformMatrix => [
  left[0] * right[0] + left[2] * right[1],
  left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3],
  left[1] * right[2] + left[3] * right[3],
  left[0] * right[4] + left[2] * right[5] + left[4],
  left[1] * right[4] + left[3] * right[5] + left[5],
];

const stableNumber = (value: number): number =>
  Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(12));

const localTransform = (
  element: SpecElementV2,
  frame: number,
): TransformMatrix => {
  const rotation = valueAtV2(element.keyframes, frame, "rotation", 0);
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const scaleX = valueAtV2(element.keyframes, frame, "scaleX", 1);
  const scaleY = valueAtV2(element.keyframes, frame, "scaleY", 1);
  const anchorX = element.anchor.x;
  const anchorY = element.anchor.y;
  const x = element.box.x + valueAtV2(element.keyframes, frame, "x", 0);
  const y = element.box.y + valueAtV2(element.keyframes, frame, "y", 0);
  const matrix: TransformMatrix = [
    cosine * scaleX,
    sine * scaleX,
    -sine * scaleY,
    cosine * scaleY,
    x + anchorX - cosine * scaleX * anchorX + sine * scaleY * anchorY,
    y + anchorY - sine * scaleX * anchorX - cosine * scaleY * anchorY,
  ];
  return [
    stableNumber(matrix[0]),
    stableNumber(matrix[1]),
    stableNumber(matrix[2]),
    stableNumber(matrix[3]),
    stableNumber(matrix[4]),
    stableNumber(matrix[5]),
  ];
};

const v1Draw = (
  element: SpecElementV1,
  frame: number,
): FramePlan["draws"][number] => {
  const opacity = valueAtV1(element.keyframes, frame, "opacity", 1);
  const scale = valueAtV1(element.keyframes, frame, "scale", 1);
  const dx = valueAtV1(element.keyframes, frame, "x", 0);
  const dy = valueAtV1(element.keyframes, frame, "y", 0);
  return {
    elementId: element.elementId,
    kind: element.kind,
    box: {
      x: element.box.x + dx,
      y: element.box.y + dy,
      width: element.box.width * scale,
      height: element.box.height * scale,
    },
    opacity,
    ...(element.assetRef !== undefined ? { assetRef: element.assetRef } : {}),
    ...(element.content !== undefined ? { content: element.content } : {}),
    ...(element.weight !== undefined ? { weight: element.weight } : {}),
    effects: element.effects,
  };
};

const v2Draws = (beat: BeatV2, frame: number): FramePlan["draws"] => {
  const worldById = new Map<string, TransformMatrix>();
  return topologicallyOrderedElements(beat).map((element) => {
    const local = localTransform(element, frame);
    const parent =
      element.parentElementId === undefined
        ? undefined
        : worldById.get(element.parentElementId);
    const transform = parent === undefined ? local : multiply(parent, local);
    worldById.set(element.elementId, transform);
    return {
      elementId: element.elementId,
      kind: element.kind,
      box: { x: 0, y: 0, width: element.box.width, height: element.box.height },
      transform,
      opacity: valueAtV2(element.keyframes, frame, "opacity", 1),
      ...(element.assetRef !== undefined ? { assetRef: element.assetRef } : {}),
      ...(element.content !== undefined ? { content: element.content } : {}),
      ...(element.weight !== undefined ? { weight: element.weight } : {}),
      effects: element.effects,
    };
  });
};

export function compileSceneSpec(spec: SceneSpec): SpecCompilation {
  const frames: FramePlan[] = [];
  for (let frame = 0; frame < spec.canvas.frameCount; frame++) {
    const draws: FramePlan["draws"][number][] = [];
    if (spec.schema === "scene-spec-v1") {
      for (const beat of spec.beats) {
        if (frame < beat.startFrame || frame >= beat.endFrame) continue;
        draws.push(...beat.elements.map((element) => v1Draw(element, frame)));
      }
    } else {
      for (const beat of spec.beats) {
        if (frame < beat.startFrame || frame >= beat.endFrame) continue;
        draws.push(...v2Draws(beat, frame));
      }
    }
    frames.push({ frame, draws });
  }
  const canonical = canonicalJson(spec);
  const contentDigest = createHash("sha256").update(canonical).digest("hex");
  return {
    schema: "spec-compilation-v1",
    versionId: `spec_${contentDigest.slice(0, 16)}`,
    digest: contentDigest,
    canvas: spec.canvas,
    palette: spec.palette,
    frames,
    passes: [{ passId: "dom-svg", kind: "DOM/SVG", shader: null }],
  };
}
