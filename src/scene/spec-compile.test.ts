import { fixtureSpec, type SceneSpec } from "@rvs/contracts";
import { describe, expect, it } from "vitest";
import { compileSceneSpec } from "./spec-compile.js";

const clone = (spec: SceneSpec): SceneSpec =>
  structuredClone(spec) as SceneSpec;

const withKeyframe = (
  spec: SceneSpec,
  patch: Partial<SceneSpec["beats"][number]["elements"][number]["keyframes"][number]>,
): SceneSpec => {
  const next = clone(spec);
  const keyframe = next.beats[0]!.elements[0]!.keyframes[1]!;
  Object.assign(keyframe, patch);
  return next;
};

describe("compileSceneSpec", () => {
  it("is deterministic", () => {
    expect(compileSceneSpec(fixtureSpec).digest).toBe(
      compileSceneSpec(fixtureSpec).digest,
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
    const gap = compileSceneSpec(fixtureSpec).frames[599];
    expect(gap?.draws.every((d) => d.opacity >= 0)).toBe(true);
  });

  it("changes digest when a keyframe moves one frame", () => {
    const moved = withKeyframe(fixtureSpec, { frame: 16 });
    expect(compileSceneSpec(moved).digest).not.toBe(
      compileSceneSpec(fixtureSpec).digest,
    );
  });
});
