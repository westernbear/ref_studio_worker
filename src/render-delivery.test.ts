import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BrowserCaptureInput,
  BrowserCaptureReport,
} from "./capture/browser.js";
import type { CommandRunner } from "./process-runner.js";
import {
  compileEvidenceScene,
  DELIVERY_FPS,
  DELIVERY_FRAME_COUNT,
  renderWorkflowDelivery,
} from "./render-delivery.js";

const evidence = (frameCount: number): Record<string, unknown> => ({
  observed: {
    palette: ["#000000", "#ffffff"],
    effects: Array.from({ length: frameCount }, (_, frame) => ({
      lowerLightRgb16x9: Array<number>(16 * 9 * 3).fill(frame / frameCount),
    })),
  },
  sceneInput: {
    tenantId: "ten_test",
    editor: "usr_test",
    reason: "render contract",
    timestamp: "2026-08-23T00:00:00.000Z",
    gate: "APPROVED",
    owners: [
      {
        ownerId: "residual",
        kind: "global-residual",
        editable: true,
        assetRef: "background",
        confidence: 1,
      },
    ],
    editableAssets: [
      {
        assetId: "background",
        kind: "background-material",
        editable: true,
        owner: "residual",
      },
    ],
    geometry: {
      residual: {
        boundsPerFrame: [{ frame: 0, x: 0, y: 0, width: 1080, height: 1920 }],
        fixedWidth: true,
        fixedX: true,
      },
    },
    tracks: [
      {
        trackId: "residual-track",
        owner: "residual",
        lifecycle: {
          enter: { start: 0 },
          stable: { start: 1 },
          exit: { start: frameCount },
        },
        geometryRef: "residual",
        effects: [],
      },
    ],
    effects: { residual: {} },
    residualCanvas: {
      owner: "residual",
      measurements: ["lower-light field"],
      mustRemainSeparate: true,
      compositeRule: "before owner effects",
    },
    audio: { sampleRateHz: 48_000, channels: 2, frameRate: 25, anchors: [] },
    passes: [
      {
        passId: "residual-dom",
        owner: "residual",
        kind: "DOM/SVG",
        shader: null,
        reads: [],
        writes: "background-layer",
      },
    ],
    layerOrder: ["background-layer"],
    allowedShaders: [],
  },
});

const probe = {
  format: { duration: "4.000000" },
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      profile: "High",
      level: 41,
      width: 1080,
      height: 1920,
      pix_fmt: "yuv420p",
      avg_frame_rate: "30/1",
      nb_read_frames: "120",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      profile: "LC",
      channels: 2,
      sample_rate: "48000",
    },
  ],
  frames: Array.from({ length: DELIVERY_FRAME_COUNT }, (_, frame) => ({
    media_type: "video",
    key_frame: frame % 60 === 0 ? 1 : 0,
  })),
};

describe("delivery contract", () => {
  it("renders 25 fps evidence as fixed 30 fps delivery media", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-render-contract-"));
    const encodedCommands: string[][] = [];
    const probeCommands: string[][] = [];
    let captured: BrowserCaptureInput | undefined;
    const runCommand: CommandRunner = async (command, args) => {
      if (command.endsWith("ffprobe")) {
        probeCommands.push([...args]);
        return { stdout: JSON.stringify(probe), stderr: "" };
      }
      const output = args.at(-1);
      if (!output) throw new Error("TEST_OUTPUT_PATH_MISSING");
      if (args.includes("-frames:v")) encodedCommands.push([...args]);
      await writeFile(output, "media");
      return { stdout: "", stderr: "" };
    };
    const captureFrames = async (
      input: BrowserCaptureInput,
    ): Promise<BrowserCaptureReport> => {
      captured = input;
      await input.onFrame(input.frames.length, input.frames.length);
      return {
        chromiumVersion: "151.0.7922.138",
        renderer: "ANGLE SwiftShader",
        fontReady: true,
        webgl2: true,
        networkPolicy: "external-blocked",
        repeatedFrameByteIdentity: true,
        frameSha256: Array<string>(input.frames.length).fill("a".repeat(64)),
        passIds: ["residual-dom"],
        shaderDiagnostics: [],
        limits: { MAX_TEXTURE_SIZE: 8192 },
      };
    };

    try {
      const renderEvidence = evidence(100);
      const report = await renderWorkflowDelivery(
        {
          mode: "delivery",
          tenantId: "ten_test",
          jobId: "job_test",
          attemptId: "attempt_test",
          workspace,
          normalizedPath: join(workspace, "normalized.mkv"),
          outputPath: join(workspace, "delivery.mp4"),
          evidence: renderEvidence,
          expectedCompilation: compileEvidenceScene(renderEvidence, "ten_test"),
          frameCount: 100,
          sourceFps: 25,
          signal: new AbortController().signal,
          onProgress: async () => undefined,
        },
        { runCommand, captureFrames, fontPath: "/tmp/font.ttf" },
      );

      expect(captured?.frames).toHaveLength(DELIVERY_FRAME_COUNT);
      expect(captured?.frames.slice(0, 8).map((frame) => frame.frame)).toEqual([
        0, 0, 1, 2, 3, 4, 5, 5,
      ]);
      expect(captured?.frames.at(-1)?.frame).toBe(99);
      expect(captured?.residualRgb16x9[2]?.[0]).toBeCloseTo(0.01);
      expect(captured?.residualRgb16x9.at(-1)?.[0]).toBeCloseTo(0.99);
      expect(encodedCommands).toHaveLength(1);
      expect(probeCommands[0]).toEqual(
        expect.arrayContaining(["-show_entries", "-show_frames"]),
      );
      expect(encodedCommands[0]).toEqual(
        expect.arrayContaining([
          "-framerate",
          String(DELIVERY_FPS),
          "-frames:v",
          String(DELIVERY_FRAME_COUNT),
          "-profile:v",
          "high",
          "-level:v",
          "4.1",
          "-g",
          "60",
          "-flags",
          "+cgop",
          "-x264-params",
          "colorprim=bt709:transfer=bt709:colormatrix=bt709",
          "-colorspace",
          "bt709",
          "-profile:a",
          "aac_low",
          "-b:a",
          "192k",
          "+faststart",
        ]),
      );
      expect(report).toMatchObject({
        status: "PASS",
        outputSha256:
          "721c9525ade2ea8903d343ef25cf68b9bf4ab0aad56bb7b01fbe48d09bc7fcf4",
        outputBytes: 5,
        qc: {
          fps: 30,
          frameCount: 120,
          videoProfile: "High",
          videoLevel: "4.1",
          colorSpace: "bt709",
          gopSize: 60,
          closedGop: true,
          audioProfile: "LC",
          audioTargetBitRate: 192_000,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
