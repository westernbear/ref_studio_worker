import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CANVAS,
  DELIVERY_FPS,
  validateSceneSpec,
  type SceneSpec,
} from "./contracts/index.js";
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
  outputBytes: number;
  frameSha256: readonly string[];
  // What the browser that drew these frames actually reported about itself.
  // The API binds `renderer` against the worker's registered preflight and
  // requires networkPolicy "external-blocked" -- material generation happens
  // in the `assets` phase, and by the time frames are drawn the browser is
  // sealed off exactly as it is for a restore render.
  runtime: Readonly<{
    chromiumVersion: string;
    renderer: string;
    fontReady: boolean;
    webgl2: boolean;
    networkPolicy: string;
    repeatedFrameByteIdentity: boolean;
  }>;
  qc: Readonly<Record<string, unknown>>;
  // A local worker-filesystem path, for the content-safety sample upload --
  // never sent to the API, which keeps its report schema strict.
  safetySampleFramePath: string;
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

  // Fail-closed gate (C2.3): a SceneSpec can reach this function by any
  // path, not only the one authorScene() already validates after its own
  // canvas override -- so this is checked again here, right before the
  // spec is trusted to compile into frames. Resolvable asset ids are the
  // ones this caller actually knows how to turn into bytes: whatever
  // assetPaths already resolved to a real file, plus any asset the model
  // declared as "generated" (gated separately by validateSceneSpec's own
  // provenance check, not by path resolution), plus every colour asset --
  // a colour's ref is its own value, so it has no file and the `assets`
  // phase deliberately never stores one for it (see planSceneAssets).
  const resolvableAssetIds = new Set<string>(input.assetPaths.keys());
  for (const asset of input.spec.assets)
    if (asset.origin === "generated" || asset.kind === "color")
      resolvableAssetIds.add(asset.assetId);
  validateSceneSpec(input.spec, resolvableAssetIds);

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
      dependencies.chromePath ??
      process.env.CHROME_PATH ??
      "/opt/chrome/chrome",
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
  let outputBytes = 0;
  for await (const chunk of createReadStream(input.outPath)) {
    outputHash.update(chunk);
    outputBytes += (chunk as Buffer).byteLength;
  }

  return {
    schema: "rvs.gen-render-report.v1",
    specDigest: compilation.digest,
    outputSha256: outputHash.digest("hex"),
    outputBytes,
    frameSha256: captureReport.frameSha256,
    runtime: {
      chromiumVersion: captureReport.chromiumVersion,
      renderer: captureReport.renderer,
      fontReady: captureReport.fontReady,
      webgl2: captureReport.webgl2,
      networkPolicy: captureReport.networkPolicy,
      repeatedFrameByteIdentity: captureReport.repeatedFrameByteIdentity,
    },
    qc,
    // The middle frame, same choice the restore delivery makes -- the most
    // representative single frame of the film.
    safetySampleFramePath: join(
      framesDirectory,
      `frame-${String(Math.floor(canvas.frameCount / 2)).padStart(6, "0")}.png`,
    ),
  };
}

export type { CommandRunner };
