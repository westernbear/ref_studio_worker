// Vendored from packages/contracts/src/scene-spec.fixture.ts — do not hand-edit.
// apps/worker is a standalone deployable (own Dockerfile/lockfile/workspace)
// and cannot depend on packages/contracts via "workspace:*" in a clean
// container build. This is a byte-for-byte copy of the pure module; the
// drift test in apps/api/src/worker-contracts-vendoring.test.ts is what
// keeps it honest -- if it fails, re-copy from packages/contracts/src.
// ---- vendored copy below, unmodified ----

import { CANVAS, DELIVERY_FPS } from "./generation.js";
import type { SceneSpec } from "./scene-spec.js";

// 3 beats, 600 frames, 9:16, two text elements and one image element -- the
// hand-written target the deterministic compiler (Task 2.3) and renderer
// (Task 2.4) are proven against before any AI authors a scene.
export const fixtureSpec: SceneSpec = {
  schema: "scene-spec-v1",
  mode: "SWAP",
  canvas: {
    width: CANVAS["9:16"].width,
    height: CANVAS["9:16"].height,
    fps: DELIVERY_FPS,
    frameCount: 600,
  },
  palette: {
    hero: "#ff5500",
    cool: "#3355ff",
    warm: "#ffaa33",
    background: "#101018",
  },
  assets: [
    {
      assetId: "hero-shot",
      kind: "image",
      origin: "attachment",
      ref: "attachment://hero.png",
    },
    {
      assetId: "logo",
      kind: "image",
      origin: "attachment",
      ref: "attachment://logo.png",
    },
  ],
  beats: [
    {
      beatId: "beat-open",
      startFrame: 0,
      endFrame: 200,
      shot: "push-in",
      elements: [
        {
          elementId: "headline",
          kind: "text",
          content: "REF STUDIO",
          box: { x: 120, y: 400, width: 840, height: 160 },
          keyframes: [
            { frame: 0, opacity: 0, ease: "linear" },
            { frame: 30, opacity: 1, ease: "easeInOut" },
            { frame: 170, opacity: 1, ease: "linear" },
            { frame: 199, opacity: 0, ease: "easeOut" },
          ],
          effects: [],
        },
      ],
    },
    {
      beatId: "beat-hero",
      startFrame: 200,
      endFrame: 400,
      shot: "hard-cut",
      elements: [
        {
          elementId: "hero-image",
          kind: "image",
          assetRef: "hero-shot",
          box: { x: 0, y: 300, width: 1080, height: 1080 },
          keyframes: [
            { frame: 200, opacity: 1, scale: 1, ease: "linear" },
            { frame: 399, opacity: 1, scale: 1.1, ease: "easeIn" },
          ],
          effects: [],
        },
      ],
    },
    {
      beatId: "beat-close",
      startFrame: 400,
      endFrame: 600,
      shot: "ring-expand",
      elements: [
        {
          elementId: "closer",
          kind: "text",
          content: "GENERATE THE FRAME",
          box: { x: 90, y: 1500, width: 900, height: 140 },
          keyframes: [
            { frame: 400, opacity: 0, ease: "linear" },
            { frame: 430, opacity: 1, ease: "easeInOut" },
            { frame: 599, opacity: 1, ease: "linear" },
          ],
          effects: [],
        },
      ],
    },
  ],
};
