import { describe, expect, it } from "vitest";
import {
  parseBlenderCapability,
  REGISTERED_BLENDER,
} from "./blender-capability.js";

const valid = {
  imageDigest: REGISTERED_BLENDER.imageDigest,
  version: REGISTERED_BLENDER.version,
  device: REGISTERED_BLENDER.device,
  fixtureSha256: REGISTERED_BLENDER.fixtureSha256,
  fixturePassed: true,
  budget: REGISTERED_BLENDER.budget,
} as const;

describe("parseBlenderCapability", () => {
  it("admits only the pinned CPU fixture snapshot", () => {
    expect(parseBlenderCapability(valid)).toEqual(valid);
  });

  it.each([
    ["image pin", { ...valid, imageDigest: `sha256:${"0".repeat(64)}` }],
    ["version", { ...valid, version: "4.4.0" }],
    ["device", { ...valid, device: "CUDA" }],
    ["fixture", { ...valid, fixturePassed: false }],
    [
      "budget",
      {
        ...valid,
        budget: {
          ...valid.budget,
          maxTriangles: valid.budget.maxTriangles + 1,
        },
      },
    ],
    ["unknown", { ...valid, script: "bpy.ops.wm.open_mainfile()" }],
  ])("rejects a mismatched %s", (_name, snapshot) => {
    expect(() => parseBlenderCapability(snapshot)).toThrow(
      /BLENDER_CAPABILITY_UNAVAILABLE/u,
    );
  });
});
