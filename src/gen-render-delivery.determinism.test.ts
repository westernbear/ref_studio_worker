import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANVAS, DELIVERY_FPS, type SceneSpec } from "@rvs/contracts";
import { describe, expect, it } from "vitest";
import { renderGeneratedDelivery } from "./gen-render-delivery.js";

// Task 2.6: the load-bearing claim of this whole design. Two independent
// runs of the same fixture, through a real (non-mocked) Chromium and
// ffmpeg, must produce byte-identical frame hashes. This is never weakened
// to a mocked capture/ffmpeg to force a green run -- if Chromium cannot
// launch in a given environment, the test is reported SKIPPED (not PASSED),
// and that must be surfaced honestly rather than hidden.
const defaultChromePath = fileURLToPath(
  new URL(
    "../../../runtime/hydrated/chrome-for-testing/chrome-linux64/chrome",
    import.meta.url,
  ),
);
const defaultFontPath = fileURLToPath(
  new URL(
    "../../../runtime/hydrated/wanted-sans/variable/WantedSansVariable.ttf",
    import.meta.url,
  ),
);
const chromePath = process.env["RVS_CHROME_PATH"] ?? defaultChromePath;
const fontPath = process.env["RVS_FONT_PATH"] ?? defaultFontPath;
const canRunRealBrowser = existsSync(chromePath) && existsSync(fontPath);

const shortFixtureSpec: SceneSpec = {
  schema: "scene-spec-v1",
  mode: "SWAP",
  canvas: {
    width: CANVAS["9:16"].width,
    height: CANVAS["9:16"].height,
    fps: DELIVERY_FPS,
    frameCount: 6,
  },
  palette: {
    hero: "#ff5500",
    cool: "#3355ff",
    warm: "#ffaa33",
    background: "#101018",
  },
  assets: [],
  beats: [
    {
      beatId: "beat-only",
      startFrame: 0,
      endFrame: 6,
      shot: "hard-cut",
      elements: [
        {
          elementId: "headline",
          kind: "text",
          content: "DETERMINISM",
          box: { x: 100, y: 800, width: 880, height: 200 },
          keyframes: [
            { frame: 0, opacity: 0, ease: "linear" },
            { frame: 5, opacity: 1, ease: "easeInOut" },
          ],
          effects: ["glow"],
        },
      ],
    },
  ],
};

describe("renderGeneratedDelivery determinism", () => {
  it.skipIf(!canRunRealBrowser)(
    "produces identical frame hashes across two runs",
    async () => {
      // Each run gets its own workspace -- two genuinely independent
      // processes, not two calls sharing one Chromium profile directory
      // (which would just replay a stale DevToolsActivePort file from the
      // first run's already-exited browser).
      const workspaceA = await mkdtemp(join(tmpdir(), "rvs-gen-determinism-a-"));
      const workspaceB = await mkdtemp(join(tmpdir(), "rvs-gen-determinism-b-"));
      try {
        const deps = { chromePath, fontPath };
        const a = await renderGeneratedDelivery(
          {
            spec: shortFixtureSpec,
            assetPaths: new Map<string, string>(),
            outPath: join(workspaceA, "out.mp4"),
          },
          deps,
        );
        const b = await renderGeneratedDelivery(
          {
            spec: shortFixtureSpec,
            assetPaths: new Map<string, string>(),
            outPath: join(workspaceB, "out.mp4"),
          },
          deps,
        );
        expect(b.frameSha256).toEqual(a.frameSha256);
      } finally {
        await rm(workspaceA, { recursive: true, force: true });
        await rm(workspaceB, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
