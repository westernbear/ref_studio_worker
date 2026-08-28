import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSelfHostedVideoMaterialProvider,
  WAN_ALPHA_TOOL,
  type WanAlphaClient,
} from "./self-hosted-video-material-provider.js";
import { deriveMaterialSeed } from "./material-seed.js";
import { produceMaterial, type MaterialRequest } from "./material-provider.js";
import { runCommand, type CommandRunner } from "./process-runner.js";

const request: MaterialRequest = {
  assetId: "hero-clip",
  kind: "video",
  prompt: "a floating glass orb, alpha background",
  seed: null,
  canvas: { width: 64, height: 48, fps: 10, frameCount: 20 },
};
const signal = new AbortController().signal;

describe("createSelfHostedVideoMaterialProvider", () => {
  it("refuses by name when RVS_WAN_ALPHA_BASE_URL is not configured", async () => {
    const provider = createSelfHostedVideoMaterialProvider({ baseUrl: undefined });
    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /MATERIAL_PROVIDER_NOT_CONFIGURED/u,
    );
    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /RVS_WAN_ALPHA_BASE_URL/u,
    );
  });

  it("sends the derived seed to the client and records it in provenance", async () => {
    const calls: Array<{ prompt: string; seed: number }> = [];
    const client: WanAlphaClient = async (baseUrl, req) => {
      calls.push(req);
      return Uint8Array.from([9, 9, 9]);
    };
    const run: CommandRunner = async (command, args) => {
      const outputPath = args.at(-1) as string;
      if (command.includes("ffprobe"))
        return {
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                pix_fmt: "yuv420p",
                width: request.canvas.width,
                height: request.canvas.height * 2,
                avg_frame_rate: `${request.canvas.fps}/1`,
                nb_read_frames: String(request.canvas.frameCount),
              },
            ],
          }),
          stderr: "",
        };
      await writeFile(outputPath, Uint8Array.from([1, 2, 3, 4]));
      return { stdout: "", stderr: "" };
    };
    const provider = createSelfHostedVideoMaterialProvider({
      baseUrl: "http://wan-alpha.worker-internal:8000",
      client,
      runCommand: run,
    });

    const material = await produceMaterial(provider, request, signal);

    expect(calls).toHaveLength(1);
    const expectedSeed = deriveMaterialSeed(request.assetId, request.prompt);
    expect(calls[0]?.seed).toBe(expectedSeed);
    expect(material.provenance.seed).toBe(expectedSeed);
    expect(material.provenance.tool).toBe(WAN_ALPHA_TOOL);
    expect(material.contentType).toBe("video/mp4");
    expect(material.provenance.sha256).toBe(
      createHash("sha256").update(Uint8Array.from([1, 2, 3, 4])).digest("hex"),
    );
  });

  it("uses the scene's own seed instead of deriving one when the scene names one", async () => {
    const calls: Array<{ seed: number }> = [];
    const client: WanAlphaClient = async (baseUrl, req) => {
      calls.push(req);
      return Uint8Array.from([1]);
    };
    const run: CommandRunner = async (command, args) => {
      const outputPath = args.at(-1) as string;
      if (command.includes("ffprobe"))
        return {
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                pix_fmt: "yuv420p",
                width: request.canvas.width,
                height: request.canvas.height * 2,
                avg_frame_rate: `${request.canvas.fps}/1`,
                nb_read_frames: String(request.canvas.frameCount),
              },
            ],
          }),
          stderr: "",
        };
      await writeFile(outputPath, Uint8Array.from([7]));
      return { stdout: "", stderr: "" };
    };
    const provider = createSelfHostedVideoMaterialProvider({
      baseUrl: "http://wan-alpha.worker-internal:8000",
      client,
      runCommand: run,
    });

    const material = await produceMaterial(
      provider,
      { ...request, seed: 42 },
      signal,
    );

    expect(calls[0]?.seed).toBe(42);
    expect(material.provenance.seed).toBe(42);
  });

  it("rejects the result when ffprobe reports a shape retiming should have fixed", async () => {
    const client: WanAlphaClient = async () => Uint8Array.from([1]);
    const run: CommandRunner = async (command, args) => {
      const outputPath = args.at(-1) as string;
      if (command.includes("ffprobe"))
        return {
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                pix_fmt: "yuv420p",
                width: 999,
                height: 999,
                avg_frame_rate: "1/1",
                nb_read_frames: "1",
              },
            ],
          }),
          stderr: "",
        };
      await writeFile(outputPath, Uint8Array.from([1]));
      return { stdout: "", stderr: "" };
    };
    const provider = createSelfHostedVideoMaterialProvider({
      baseUrl: "http://wan-alpha.worker-internal:8000",
      client,
      runCommand: run,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /WAN_ALPHA_RETIME_QC_FAILED/u,
    );
  });

  it("propagates a client failure without inventing a placeholder", async () => {
    const client: WanAlphaClient = async () => {
      throw new Error("WAN_ALPHA_REQUEST_FAILED:503");
    };
    const provider = createSelfHostedVideoMaterialProvider({
      baseUrl: "http://wan-alpha.worker-internal:8000",
      client,
    });

    await expect(produceMaterial(provider, request, signal)).rejects.toThrow(
      /WAN_ALPHA_REQUEST_FAILED/u,
    );
  });

  // Real ffmpeg/ffprobe, no network and no fake process runner -- proves the
  // actual filter graph (scale + fps + a hard frame cap over a looped
  // input) really does resize, retime and frame-cap a stacked clip to the
  // scene's own canvas, the way the determinism gate exercises real
  // Chromium rather than trusting a mock.
  it("retimes a real native clip to the scene's own canvas, fps and frame count (real ffmpeg)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-wan-alpha-fixture-"));
    try {
      const nativePath = join(workspace, "native.mp4");
      // A short, cheap stand-in for Wan-Alpha's ~5s native clip: 4 frames
      // at 2fps, well short of the scene's requested duration below, so
      // this also exercises the loop-to-extend path.
      await runCommand(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=480x1664:rate=2",
          "-frames:v",
          "4",
          "-pix_fmt",
          "yuv420p",
          nativePath,
        ],
        { cwd: workspace, signal },
      );
      const nativeBytes = await readFile(nativePath);
      const client: WanAlphaClient = async () => nativeBytes;
      const sceneCanvas = { width: 64, height: 48, fps: 5, frameCount: 20 };
      const provider = createSelfHostedVideoMaterialProvider({
        baseUrl: "http://wan-alpha.worker-internal:8000",
        client,
      });

      const material = await produceMaterial(
        provider,
        { ...request, canvas: sceneCanvas },
        signal,
      );

      expect(material.contentType).toBe("video/mp4");
      expect(material.bytes.byteLength).toBeGreaterThan(0);
      expect(material.provenance.sha256).toBe(
        createHash("sha256").update(material.bytes).digest("hex"),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
