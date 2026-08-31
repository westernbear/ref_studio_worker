import {
  fixtureSpec,
  SceneSpecSchema,
  sha256Hex,
  type SceneSpec,
} from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compileSceneSpec } from "./spec-compile.js";

const clone = (spec: SceneSpec): SceneSpec =>
  structuredClone(spec) as SceneSpec;

const withKeyframe = (
  spec: SceneSpec,
  patch: Partial<
    SceneSpec["beats"][number]["elements"][number]["keyframes"][number]
  >,
): SceneSpec => {
  const next = clone(spec);
  const keyframe = next.beats[0]!.elements[0]!.keyframes[1]!;
  Object.assign(keyframe, patch);
  return next;
};

// compileSceneSpec is a pure expansion, not a gate -- validateSceneSpec (in
// @rvs/contracts) is what forbids beats leaving a gap (C1/C2's tiling
// rule). A spec can still reach the compiler with a gap by any path that
// skips validation, so the compiler itself must be proven to leave those
// frames undrawn rather than, say, holding the previous beat's last frame.
const withGap = (spec: SceneSpec): SceneSpec => {
  const next = clone(spec);
  // Shrink beat-hero to end 50 frames early, leaving frames [350, 400) with
  // no beat covering them -- beat-close still starts at 400, so this is a
  // gap, not an overlap or an out-of-range beat.
  next.beats[1] = { ...next.beats[1]!, endFrame: 350 };
  return next;
};

describe("compileSceneSpec", () => {
  it("carries a text element's named weight through to the draw", () => {
    const spec = clone(fixtureSpec);
    Object.assign(spec.beats[0]!.elements[0]!, { weight: "black" });
    expect(compileSceneSpec(spec).frames[0]?.draws[0]?.weight).toBe("black");
  });

  it("leaves weight absent when the element names none", () => {
    const draw = compileSceneSpec(fixtureSpec).frames[0]?.draws[0];
    expect(draw && "weight" in draw).toBe(false);
  });

  it("is deterministic", () => {
    expect(compileSceneSpec(fixtureSpec).digest).toBe(
      compileSceneSpec(fixtureSpec).digest,
    );
  });

  it("preserves the legacy v1 fixture digest", () => {
    expect(compileSceneSpec(fixtureSpec).digest).toBe(
      "ad1769cdede4de63582859084d355f8751a51d12c2e073d13a0e9c536250dbc9",
    );
  });

  it("expands one plan per frame", () => {
    expect(compileSceneSpec(fixtureSpec).frames).toHaveLength(
      fixtureSpec.canvas.frameCount,
    );
  });

  it("interpolates opacity between keyframes with easeInOut", () => {
    const mid = compileSceneSpec(fixtureSpec).frames[15]?.draws[0];
    expect(mid?.opacity).toBeGreaterThan(0);
    expect(mid?.opacity).toBeLessThan(1);
  });

  it("draws nothing outside a beat", () => {
    const compiled = compileSceneSpec(withGap(fixtureSpec));
    // Frames inside the shrunk beat-hero (still covers up to 349) keep
    // their draw; frames in the gap itself (350-399, before beat-close
    // starts at 400) must have no draws at all.
    expect(compiled.frames[349]?.draws.length).toBeGreaterThan(0);
    expect(compiled.frames[375]?.draws).toHaveLength(0);
    expect(compiled.frames[399]?.draws).toHaveLength(0);
    expect(compiled.frames[400]?.draws.length).toBeGreaterThan(0);
  });

  // I3: apps/api/src/workers.ts stores job.sceneSpecDigest using
  // @rvs/contracts's sha256Hex (canonical-json based); this compiler
  // reports its own digest with a locally-duplicated canonicalJson (see
  // this file's comment on SpecCompilation). Both must agree for the same
  // spec, or a stored digest could never match a rendered one once the
  // generate-render batch compares them.
  it("agrees with @rvs/contracts's shared canonical-json digest for the same spec", () => {
    expect(compileSceneSpec(fixtureSpec).digest).toBe(sha256Hex(fixtureSpec));
  });

  // I5 follow-up: palette used to be dropped entirely (see this file's
  // module comment). The renderer cannot paint a background or default a
  // text fill from something that never survived compilation.
  it("carries the spec's palette forward", () => {
    expect(compileSceneSpec(fixtureSpec).palette).toEqual(fixtureSpec.palette);
  });

  it("changes digest when a keyframe moves one frame", () => {
    const moved = withKeyframe(fixtureSpec, { frame: 16 });
    expect(compileSceneSpec(moved).digest).not.toBe(
      compileSceneSpec(fixtureSpec).digest,
    );
  });

  it("composes v2 parents in deterministic topological order", () => {
    const spec = structuredClone(fixtureSpec) as unknown as Record<
      string,
      unknown
    > & {
      beats: { elements: Record<string, unknown>[] }[];
    };
    spec["schema"] = "scene-spec-v2";
    for (const beat of spec.beats)
      for (const element of beat.elements) {
        element["anchor"] = { x: 0, y: 0 };
        element["keyframes"] = (
          element["keyframes"] as Record<string, unknown>[]
        ).map(({ scale, ...keyframe }) => ({
          ...keyframe,
          ...(typeof scale === "number"
            ? { scaleX: scale, scaleY: scale }
            : {}),
        }));
      }
    const parent = spec.beats[0]!.elements[0]!;
    Object.assign(parent, {
      anchor: { x: 0, y: 0 },
      box: { x: 10, y: 20, width: 100, height: 50 },
      keyframes: [
        { frame: 0, rotation: 90, scaleX: 2, scaleY: 1, ease: "linear" },
        { frame: 10, rotation: 90, scaleX: 3, scaleY: 1, ease: "easeIn" },
      ],
    });
    spec.beats[0]!.elements.unshift({
      ...structuredClone(parent),
      elementId: "child",
      parentElementId: parent.elementId,
      box: { x: 5, y: 0, width: 20, height: 10 },
      keyframes: [{ frame: 0, ease: "linear" }],
    });
    const compiled = compileSceneSpec(SceneSpecSchema.parse(spec));
    const draws = compiled.frames[0]!.draws;
    expect(draws.map((draw) => draw.elementId)).toEqual(["headline", "child"]);
    expect(draws[0]?.transform).toEqual([0, 2, -1, 0, 10, 20]);
    expect(draws[1]?.transform).toEqual([0, 2, -1, 0, 10, 30]);
    expect(compiled.frames[5]!.draws[0]?.transform).toEqual([
      0, 2.25, -1, 0, 10, 20,
    ]);
  });
});
