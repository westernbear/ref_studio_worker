import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CANVAS, DELIVERY_FPS, type SceneSpec } from "@rvs/contracts";
import { z } from "zod";
import {
  captureBrowserFrames,
  type BrowserCaptureInput,
  type BrowserCaptureReport,
} from "./capture/browser.js";
import { runCommand, type CommandRunner } from "./process-runner.js";
import type { RenderDeliveryDependencies } from "./render-delivery.js";
import { createGeneratedRenderApp } from "./render-app/generated.js";
import { compileSceneSpec } from "./scene/spec-compile.js";

export type GeneratedRenderReport = Readonly<{
  schema: "rvs.gen-render-report.v1";
  specDigest: string;
  outputSha256: string;
  frameSha256: readonly string[];
  qc: Readonly<Record<string, unknown>>;
}>;

const fraction = (value: string): number => {
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  )
    return Number.NaN;
  return numerator / denominator;
};

// CANVAS_MISMATCH is a render-time token (ruling 5), not one of
// validateSceneSpec's spec tokens: it asks whether this canvas is one a real
// job could have declared (one of the generation aspects, at delivery fps),
// not whether the spec is internally well-formed.
const isDeclaredCanvas = (canvas: SceneSpec["canvas"]): boolean =>
  canvas.fps === DELIVERY_FPS &&
  Object.values(CANVAS).some(
    (dimensions) =>
      dimensions.width === canvas.width && dimensions.height === canvas.height,
  );

const Probe = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(
    z
      .object({
        codec_type: z.string(),
        codec_name: z.string(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        pix_fmt: z.string().optional(),
        avg_frame_rate: z.string().optional(),
        nb_read_frames: z.string().optional(),
      })
      .passthrough(),
  ),
});

function validateGeneratedDelivery(
  raw: string,
  canvas: SceneSpec["canvas"],
): Record<string, unknown> {
  const probe = Probe.parse(JSON.parse(raw));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const duration = Number(probe.format.duration);
  if (
    !video ||
    video.codec_name !== "h264" ||
    video.pix_fmt !== "yuv420p" ||
    video.width !== canvas.width ||
    video.height !== canvas.height ||
    fraction(video.avg_frame_rate ?? "") !== canvas.fps ||
    Number(video.nb_read_frames) !== canvas.frameCount
  )
    throw new Error("GENERATED_DELIVERY_QC_FAILED");
  return {
    status: "PASS",
    width: video.width,
    height: video.height,
    fps: canvas.fps,
    frameCount: canvas.frameCount,
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1_000) : null,
    videoCodec: video.codec_name,
    videoProfile: "high",
    videoLevel: "4.1",
    pixelFormat: video.pix_fmt,
    colorSpace: "bt709",
    audioCodec: "aac",
    audioProfile: "aac_low",
    audioTargetBitRate: 192_000,
  };
}

export async function renderGeneratedDelivery(
  input: Readonly<{
    readonly spec: SceneSpec;
    readonly assetPaths: ReadonlyMap<string, string>;
    readonly outPath: string;
  }>,
  dependencies: RenderDeliveryDependencies = {},
): Promise<GeneratedRenderReport> {
  if (!isDeclaredCanvas(input.spec.canvas)) throw new Error("CANVAS_MISMATCH");

  const command = dependencies.runCommand ?? runCommand;
  const capture = dependencies.captureFrames ?? captureBrowserFrames;
  const compilation = compileSceneSpec(input.spec);
  const canvas = input.spec.canvas;

  const fontPath =
    dependencies.fontPath ??
    process.env.RVS_FONT_PATH ??
    "/opt/rvs/fonts/WantedSansVariable.ttf";
  const fontAssets = input.spec.assets
    .filter((asset) => asset.kind === "font")
    .flatMap((asset) => {
      const path = input.assetPaths.get(asset.assetId);
      return path ? [{ family: asset.assetId, path }] : [];
    });
  const app = createGeneratedRenderApp(compilation, [
    { family: "Wanted Sans", path: fontPath },
    ...fontAssets,
  ]);
  const renderedFrames = compilation.frames.map((plan) =>
    app.renderFrame(plan.frame),
  );

  const workspace = dirname(input.outPath);
  const framesDirectory = join(workspace, "gen-frames");
  await mkdir(framesDirectory, { recursive: true });
  const signal = new AbortController().signal;

  const captureInput: BrowserCaptureInput = {
    workspace,
    framesDirectory,
    chromePath:
      dependencies.chromePath ?? process.env.CHROME_PATH ?? "/opt/chrome/chrome",
    fontPath,
    frames: renderedFrames,
    signal,
    onFrame: async () => undefined,
    renderContract: { kind: "generated" },
  };
  const captureReport: BrowserCaptureReport = await capture(captureInput);

  const durationSec = canvas.frameCount / canvas.fps;
  await command(
    process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-framerate",
      String(canvas.fps),
      "-start_number",
      "0",
      "-i",
      join(framesDirectory, "frame-%06d.png"),
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-frames:v",
      String(canvas.frameCount),
      "-t",
      String(durationSec),
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level:v",
      "4.1",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-x264-params",
      "colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-pix_fmt",
      "yuv420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      input.outPath,
    ],
    { cwd: workspace, signal },
  );

  const probe = await command(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames",
      "-of",
      "json",
      input.outPath,
    ],
    { cwd: workspace, signal },
  );
  const qc = validateGeneratedDelivery(probe.stdout, canvas);

  const outputHash = createHash("sha256");
  for await (const chunk of createReadStream(input.outPath))
    outputHash.update(chunk);

  return {
    schema: "rvs.gen-render-report.v1",
    specDigest: compilation.digest,
    outputSha256: outputHash.digest("hex"),
    frameSha256: captureReport.frameSha256,
    qc,
  };
}

export type { CommandRunner };
