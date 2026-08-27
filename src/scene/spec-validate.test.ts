import { fixtureSpec, type SceneSpec } from "@rvs/contracts";
import { describe, expect, it } from "vitest";
import { validateSceneSpec } from "./spec-validate.js";

const clone = (spec: SceneSpec): SceneSpec =>
  structuredClone(spec) as SceneSpec;

const withElement = (
  spec: SceneSpec,
  patch: Partial<SceneSpec["beats"][number]["elements"][number]>,
): SceneSpec => {
  const next = clone(spec);
  const beat = next.beats[0]!;
  const element = beat.elements[0]!;
  Object.assign(element, patch);
  return next;
};

const withBeat = (
  spec: SceneSpec,
  patch: Partial<SceneSpec["beats"][number]>,
): SceneSpec => {
  const next = clone(spec);
  Object.assign(next.beats[0]!, patch);
  return next;
};

const withBeats = (
  spec: SceneSpec,
  patches: readonly Partial<SceneSpec["beats"][number]>[],
): SceneSpec => {
  const next = clone(spec);
  patches.forEach((patch, index) => {
    const beat = next.beats[index];
    if (beat) Object.assign(beat, patch);
  });
  return next;
};

const withKeyframe = (
  spec: SceneSpec,
  patch: Partial<SceneSpec["beats"][number]["elements"][number]["keyframes"][number]>,
): SceneSpec => {
  const next = clone(spec);
  const keyframe = next.beats[0]!.elements[0]!.keyframes[1]!;
  Object.assign(keyframe, patch);
  return next;
};

const withAsset = (
  spec: SceneSpec,
  asset: SceneSpec["assets"][number],
): SceneSpec => {
  const next = clone(spec);
  (next.assets as SceneSpec["assets"][number][]).push(asset);
  return next;
};

describe("validateSceneSpec", () => {
  const ok = new Set(["logo", "hero-shot"]);

  it("passes the fixture", () => {
    expect(validateSceneSpec(fixtureSpec, ok).schema).toBe("scene-spec-v1");
  });

  it("rejects an unresolved asset", () => {
    const bad = withElement(fixtureSpec, { assetRef: "nope" });
    expect(() => validateSceneSpec(bad, ok)).toThrow(/ASSET_REF_UNRESOLVED/);
  });

  it("rejects a beat past the end", () => {
    const bad = withBeat(fixtureSpec, { startFrame: 590, endFrame: 900 });
    expect(() => validateSceneSpec(bad, ok)).toThrow(/BEAT_OUT_OF_RANGE/);
  });

  it("rejects overlapping beats", () => {
    const bad = withBeats(fixtureSpec, [
      { startFrame: 0, endFrame: 300 },
      { startFrame: 200, endFrame: 400 },
    ]);
    expect(() => validateSceneSpec(bad, ok)).toThrow(/BEAT_OVERLAP/);
  });

  it("rejects a keyframe outside its beat", () => {
    const bad = withKeyframe(fixtureSpec, { frame: 999 });
    expect(() => validateSceneSpec(bad, ok)).toThrow(/KEYFRAME_OUT_OF_BEAT/);
  });

  it("rejects an external url in content", () => {
    const bad = withElement(fixtureSpec, {
      content: "https://cdn.example.com/a.png",
    });
    expect(() => validateSceneSpec(bad, ok)).toThrow(/EXTERNAL_URL/);
  });

  it("rejects a generated asset with no provenance", () => {
    const bad = withAsset(fixtureSpec, {
      assetId: "gen1",
      kind: "image",
      origin: "generated",
      ref: "art_1",
    });
    expect(() =>
      validateSceneSpec(bad, new Set([...ok, "gen1"])),
    ).toThrow(/GENERATED_ASSET_WITHOUT_PROVENANCE/);
  });
});
