import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, type CommandRunner } from "./process-runner.js";
import { decodeVideoAsset } from "./video-decoder.js";

const signal = new AbortController().signal;
const canvas = { width: 64, height: 48, fps: 10, frameCount: 12 };
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("decodeVideoAsset", () => {
  it("decodes a real H264 fixture twice to identical numbered RGB frames", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-video-decode-"));
    try {
      const source = join(workspace, "fixture.mp4");
      await runCommand(
        process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${canvas.width}x${canvas.height}:rate=${canvas.fps}`,
          "-frames:v",
          String(canvas.frameCount),
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-colorspace",
          "bt709",
          "-color_trc",
          "bt709",
          "-color_primaries",
          "bt709",
          "-x264-params",
          "colorprim=bt709:transfer=bt709:colormatrix=bt709",
          source,
        ],
        { cwd: workspace, signal },
      );
      const bytes = await readFile(source);
      const input = {
        assetId: "clip",
        bytes,
        expectedSha256: sha256(bytes),
        contentType: "video/mp4",
        canvas,
        workspace: join(workspace, "run-a"),
        signal,
      } as const;
      const [first, second] = await Promise.all([
        decodeVideoAsset(input),
        decodeVideoAsset({ ...input, workspace: join(workspace, "run-b") }),
      ]);
      expect(second.report.frameSha256).toEqual(first.report.frameSha256);
      expect(second.framePaths).toHaveLength(canvas.frameCount);
      expect(second.framePaths[0]).toMatch(/frame-000001\.png$/u);
      expect(second.report.decoderFingerprint).toMatch(/^ffmpeg version/u);
      expect(second.report.probeFingerprint).toMatch(/^ffprobe version/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    ["wrong hash", { expectedSha256: "0".repeat(64) }],
    ["wrong content type", { contentType: "video/webm" }],
    ["unsafe id", { assetId: "../clip" }],
    ["dot alias", { assetId: "." }],
    ["dot-dot alias", { assetId: ".." }],
  ])("rejects %s without a fallback", async (_name, override) => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-video-reject-"));
    try {
      const bytes = Uint8Array.from([1, 2, 3]);
      await expect(
        decodeVideoAsset({
          assetId: "clip",
          bytes,
          expectedSha256: sha256(bytes),
          contentType: "video/mp4",
          canvas,
          workspace,
          signal,
          ...override,
        }),
      ).rejects.toThrow("VIDEO_DECODE_UNSUPPORTED");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("never removes a workspace sentinel for an invalid cleanup alias", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-video-sentinel-"));
    const sentinel = join(workspace, "sentinel.txt");
    await writeFile(sentinel, "keep");
    const bytes = Uint8Array.from([1, 2, 3]);
    await expect(
      decodeVideoAsset({
        assetId: "..",
        bytes,
        expectedSha256: sha256(bytes),
        contentType: "video/mp4",
        canvas,
        workspace,
        signal,
      }),
    ).rejects.toThrow("VIDEO_DECODE_UNSUPPORTED");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await rm(workspace, { recursive: true, force: true });
  });

  it("maps corrupt probe output and cancellation to stable tokens", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-video-errors-"));
    const bytes = Uint8Array.from([1, 2, 3]);
    const base = {
      assetId: "clip",
      bytes,
      expectedSha256: sha256(bytes),
      contentType: "video/mp4",
      canvas,
      workspace,
      signal,
    } as const;
    const corrupt: CommandRunner = async (command, args) => {
      if (args[0] === "-version")
        return { stdout: `${command} version 1`, stderr: "" };
      return { stdout: "not-json", stderr: "" };
    };
    await expect(decodeVideoAsset(base, corrupt)).rejects.toThrow(
      "VIDEO_DECODE_UNSUPPORTED",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodeVideoAsset({ ...base, signal: controller.signal }, corrupt),
    ).rejects.toThrow("WORKER_JOB_CANCELLED");
    await rm(workspace, { recursive: true, force: true });
  });

  it.each([
    ["codec", { codec_name: "vp9" }],
    ["pixel format", { pix_fmt: "yuv444p" }],
    ["width", { width: 63 }],
    ["height", { height: 47 }],
    ["fps", { avg_frame_rate: "9/1" }],
    ["frame count", { nb_read_frames: "11" }],
    ["color space", { color_space: "bt2020nc" }],
    ["transfer", { color_transfer: "smpte2084" }],
    ["primaries", { color_primaries: "bt2020" }],
  ])(
    "rejects a metadata %s mismatch before decoding",
    async (_name, mismatch) => {
      const workspace = await mkdtemp(join(tmpdir(), "rvs-video-metadata-"));
      try {
        const bytes = Uint8Array.from([1, 2, 3]);
        const run: CommandRunner = async (command, args) => {
          if (args[0] === "-version")
            return { stdout: `${command} version 1`, stderr: "" };
          if (args.includes("-show_frames"))
            return {
              stdout: JSON.stringify({
                frames: [
                  {
                    media_type: "video",
                    pix_fmt: "yuv420p",
                    color_space: "bt709",
                    color_transfer: "bt709",
                    color_primaries: "bt709",
                  },
                ],
              }),
              stderr: "",
            };
          return {
            stdout: JSON.stringify({
              streams: [
                {
                  codec_type: "video",
                  codec_name: "h264",
                  pix_fmt: "yuv420p",
                  width: canvas.width,
                  height: canvas.height,
                  avg_frame_rate: `${canvas.fps}/1`,
                  nb_read_frames: String(canvas.frameCount),
                  color_space: "bt709",
                  color_transfer: "bt709",
                  color_primaries: "bt709",
                  ...mismatch,
                },
              ],
            }),
            stderr: "",
          };
        };
        await expect(
          decodeVideoAsset(
            {
              assetId: "clip",
              bytes,
              expectedSha256: sha256(bytes),
              contentType: "video/mp4",
              canvas,
              workspace,
              signal,
            },
            run,
          ),
        ).rejects.toThrow("VIDEO_DECODE_UNSUPPORTED");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
