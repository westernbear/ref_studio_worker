import { createHash } from "node:crypto";
import type { Ease, Keyframe, SceneSpec } from "../contracts/index.js";

export type FramePlan = {
  readonly frame: number;
  readonly draws: readonly {
    readonly elementId: string;
    readonly box: { x: number; y: number; width: number; height: number };
    readonly opacity: number;
    readonly assetRef?: string;
    readonly content?: string;
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

// Copied from apps/worker/src/scene/compile.ts (canonicalJson) rather than
// imported -- see ruling 3: compile.ts, the restore track's compiler, stays
// byte-unchanged. Duplicating this ~6-line pure function is the accepted
// cost of that.
const isJsonObject = (
  value: unknown,
): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const EASE: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
};

const valueAt = (
  keyframes: readonly Keyframe[],
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

export function compileSceneSpec(spec: SceneSpec): SpecCompilation {
  const frames: FramePlan[] = [];
  for (let frame = 0; frame < spec.canvas.frameCount; frame++) {
    const draws: FramePlan["draws"][number][] = [];
    for (const beat of spec.beats) {
      if (frame < beat.startFrame || frame >= beat.endFrame) continue;
      for (const element of beat.elements) {
        const opacity = valueAt(element.keyframes, frame, "opacity", 1);
        const scale = valueAt(element.keyframes, frame, "scale", 1);
        const dx = valueAt(element.keyframes, frame, "x", 0);
        const dy = valueAt(element.keyframes, frame, "y", 0);
        draws.push({
          elementId: element.elementId,
          box: {
            x: element.box.x + dx,
            y: element.box.y + dy,
            width: element.box.width * scale,
            height: element.box.height * scale,
          },
          opacity,
          ...(element.assetRef !== undefined
            ? { assetRef: element.assetRef }
            : {}),
          ...(element.content !== undefined
            ? { content: element.content }
            : {}),
          effects: element.effects,
        });
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
