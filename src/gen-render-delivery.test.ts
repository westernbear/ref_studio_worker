import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS, DELIVERY_FPS, type SceneSpec } from "./contracts/index.js";
import { describe, expect, it } from "vitest";
import type {
  BrowserCaptureInput,
  BrowserCaptureReport,
} from "./capture/browser.js";
import { renderGeneratedDelivery } from "./gen-render-delivery.js";
import type { CommandRunner } from "./process-runner.js";
import { compileSceneSpec } from "./scene/spec-compile.js";

const shortFixtureSpec: SceneSpec = {
  schema: "scene-spec-v1",
  mode: "SWAP",
  canvas: {
    width: CANVAS["9:16"].width,
    height: CANVAS["9:16"].height,
    fps: DELIVERY_FPS,
    frameCount: 30,
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
      endFrame: 30,
      shot: "hard-cut",
      elements: [
        {
          elementId: "headline",
          kind: "text",
          content: "SHORT",
          box: { x: 100, y: 800, width: 880, height: 200 },
          keyframes: [
            { frame: 0, opacity: 1, ease: "linear" },
            { frame: 29, opacity: 1, ease: "linear" },
          ],
          effects: [],
        },
      ],
    },
  ],
};

const probe = {
  format: { duration: "1.000000" },
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: CANVAS["9:16"].width,
      height: CANVAS["9:16"].height,
      pix_fmt: "yuv420p",
      avg_frame_rate: `${DELIVERY_FPS}/1`,
      nb_read_frames: "30",
    },
  ],
};

const fakeCapture = async (
  captureInput: BrowserCaptureInput,
): Promise<BrowserCaptureReport> => {
  await captureInput.onFrame(
    captureInput.frames.length,
    captureInput.frames.length,
  );
  return {
    chromiumVersion: "151.0.7922.138",
    renderer: "ANGLE SwiftShader",
    fontReady: true,
    webgl2: true,
    networkPolicy: "external-blocked",
    repeatedFrameByteIdentity: true,
    frameSha256: Array<string>(captureInput.frames.length).fill("a".repeat(64)),
    passIds: [],
    shaderDiagnostics: [],
    limits: {},
  };
};

describe("renderGeneratedDelivery", () => {
  it("renders the fixture spec to an mp4 with one hash per frame", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-gen-delivery-"));
    try {
      const outPath = join(workspace, "out.mp4");
      const fakeFfmpeg: CommandRunner = async (command, args) => {
        if (command.endsWith("ffprobe"))
          return { stdout: JSON.stringify(probe), stderr: "" };
        const output = args.at(-1);
        if (!output) throw new Error("TEST_OUTPUT_PATH_MISSING");
        await writeFile(output, "media");
        return { stdout: "", stderr: "" };
      };
      const report = await renderGeneratedDelivery(
        { spec: shortFixtureSpec, assetPaths: new Map(), outPath },
        { captureFrames: fakeCapture, runCommand: fakeFfmpeg },
      );

      expect(report.frameSha256).toHaveLength(30);
      expect(report.specDigest).toBe(compileSceneSpec(shortFixtureSpec).digest);
      expect(report.schema).toBe("rvs.gen-render-report.v1");
      expect(report.qc["status"]).toBe("PASS");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("draws a scene whose only asset is a colour, which never has a file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-gen-delivery-"));
    try {
      const outPath = join(workspace, "out.mp4");
      const fakeFfmpeg: CommandRunner = async (command, args) => {
        if (command.endsWith("ffprobe"))
          return { stdout: JSON.stringify(probe), stderr: "" };
        const output = args.at(-1);
        if (!output) throw new Error("TEST_OUTPUT_PATH_MISSING");
        await writeFile(output, "media");
        return { stdout: "", stderr: "" };
      };
      const colourSpec: SceneSpec = {
        ...shortFixtureSpec,
        assets: [
          {
            assetId: "brand-hero",
            kind: "color",
            origin: "evidence",
            ref: "#ff5500",
          },
        ],
        beats: [
          {
            ...shortFixtureSpec.beats[0]!,
            elements: [
              ...shortFixtureSpec.beats[0]!.elements,
              {
                elementId: "wash",
                kind: "shape",
                assetRef: "brand-hero",
                box: { x: 0, y: 0, width: 1080, height: 1920 },
                keyframes: [],
                effects: [],
              },
            ],
          },
        ],
      };

      let capturedMarkup: string | undefined;
      const report = await renderGeneratedDelivery(
        { spec: colourSpec, assetPaths: new Map(), outPath },
        {
          captureFrames: async (captureInput) => {
            capturedMarkup = captureInput.frames[0]?.markup;
            return fakeCapture(captureInput);
          },
          runCommand: fakeFfmpeg,
        },
      );

      expect(report.frameSha256).toHaveLength(30);
      // The colour asset's ref reaches the markup as a plain fill --
      // never a file (colours never have one).
      expect(capturedMarkup).toContain('data-element-id="wash"');
      expect(capturedMarkup).toContain('fill="#ff5500"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("resolves an image element's assetRef to a local file:// reference", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-gen-delivery-"));
    try {
      const outPath = join(workspace, "out.mp4");
      const fakeFfmpeg: CommandRunner = async (command, args) => {
        if (command.endsWith("ffprobe"))
          return { stdout: JSON.stringify(probe), stderr: "" };
        const output = args.at(-1);
        if (!output) throw new Error("TEST_OUTPUT_PATH_MISSING");
        await writeFile(output, "media");
        return { stdout: "", stderr: "" };
      };
      const imageSpec: SceneSpec = {
        ...shortFixtureSpec,
        assets: [
          {
            assetId: "hero-shot",
            kind: "image",
            origin: "attachment",
            ref: "attachment://hero.png",
          },
        ],
        beats: [
          {
            ...shortFixtureSpec.beats[0]!,
            elements: [
              {
                elementId: "hero-image",
                kind: "image",
                assetRef: "hero-shot",
                box: { x: 0, y: 0, width: 1080, height: 1920 },
                keyframes: [],
                effects: [],
              },
            ],
          },
        ],
      };
      const imagePath = join(workspace, "hero-shot.png");
      await writeFile(imagePath, "not-decoded-in-this-test");

      let capturedMarkup: string | undefined;
      const report = await renderGeneratedDelivery(
        {
          spec: imageSpec,
          assetPaths: new Map([["hero-shot", imagePath]]),
          outPath,
        },
        {
          captureFrames: async (captureInput) => {
            capturedMarkup = captureInput.frames[0]?.markup;
            return fakeCapture(captureInput);
          },
          runCommand: fakeFfmpeg,
        },
      );

      expect(report.frameSha256).toHaveLength(30);
      expect(capturedMarkup).toContain("<image ");
      expect(capturedMarkup).toContain(`href="file://${imagePath}"`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refuses a canvas the job did not declare", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-gen-delivery-"));
    try {
      const outPath = join(workspace, "out.mp4");
      const deps = {
        captureFrames: async (): Promise<never> => {
          throw new Error("SHOULD_NOT_CAPTURE");
        },
        runCommand: (async (): Promise<never> => {
          throw new Error("SHOULD_NOT_RUN");
        }) as unknown as CommandRunner,
      };
      await expect(
        renderGeneratedDelivery(
          {
            spec: {
              ...shortFixtureSpec,
              canvas: { ...shortFixtureSpec.canvas, width: 999 },
            },
            assetPaths: new Map(),
            outPath,
          },
          deps,
        ),
      ).rejects.toThrow(/CANVAS_MISMATCH/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
