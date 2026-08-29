import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { deriveMaterialSeed } from "./material-seed.js";
import {
  MaterialGenerationError,
  type MaterialProvider,
  type MaterialRequest,
} from "./material-provider.js";
import { runCommand, type CommandRunner } from "./process-runner.js";

// The worker's other half of the video material seam. Unlike the image
// provider (remote-image-material-provider.ts), which has no outbound
// network and forwards through the API relay, a self-hosted inference
// service lives on worker-internal itself (docker-compose.yml) -- the
// worker calls it directly, no relay, no internet, isolation intact.
//
// Wan-Alpha's whole reason for being chosen over an ordinary video model is
// that it renders a real alpha channel: an opaque clip cannot be
// composited into a scene, so a video element without alpha is as useless
// here as an opaque "backdrop" PNG would be for the image provider. But
// this worker's contract restricts every video-kind asset to a single
// content type -- `video/mp4` (see MATERIAL_CONTENT_TYPES in
// material-provider.ts and KIND_CONTENT_TYPES in resolve-scene-assets.ts)
// -- and ordinary mp4 (H.264, yuv420p) has no alpha plane at all. Rather
// than silently discarding the one thing that makes Wan-Alpha worth using,
// this provider keeps the alpha channel by packing it into the picture
// itself: the delivered frame is double height, RGB color on top and the
// alpha channel re-encoded as a grayscale luma matte on the bottom. This is
// an ordinary, well-precedented technique for carrying alpha through a
// codec that has no alpha plane (the same idea browser <video>-with-alpha
// tricks use) -- not a private invention -- and it costs nothing extra at
// the contract level: the file is still exactly one ordinary yuv420p mp4.
// A future consumer (the renderer does not draw video today -- see
// gen-render-delivery.ts's header and render-app/generated.ts's video
// branch) recovers the two halves by splitting the frame down the middle;
// `provenance.tool` names the convention (`wan-alpha@1`) so that consumer
// knows what it is looking at.
//
// The native Wan-Alpha output (480x832, 81 frames at 16fps, ~5.06s -- the
// task's own briefing, not something confirmed against a live service:
// this environment has no GPU and no reachable Wan-Alpha instance) is
// almost never the scene's own canvas size, frame rate or duration. This
// provider retimes before returning, so the caller (resolve-scene-assets.ts
// -> gen-render-delivery.ts) gets an asset already shaped to the scene's
// own timing rather than a foreign 480x832/16fps/81-frame clip it would
// have to reconcile itself.

export const WAN_ALPHA_NATIVE = Object.freeze({
  width: 480,
  height: 832,
  fps: 16,
  frameCount: 81,
});

export const WAN_ALPHA_TOOL = "wan-alpha@1";

// The self-hosted service's own HTTP contract, as documented to me --
// nothing here has been exercised against a running Wan-Alpha instance.
// Isolated behind this one injectable function so a test can supply
// whatever bytes it wants without a network call, exactly the shape
// remote-image-material-provider.ts's WorkerApi dependency takes.
export type WanAlphaClient = (
  baseUrl: string,
  request: Readonly<{ prompt: string; seed: number }>,
  signal: AbortSignal,
) => Promise<Uint8Array>;

const defaultWanAlphaClient: WanAlphaClient = async (
  baseUrl,
  request,
  signal,
) => {
  const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/v1/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: request.prompt, seed: request.seed }),
    signal,
  });
  if (!response.ok)
    throw new Error(`WAN_ALPHA_REQUEST_FAILED:${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

export type SelfHostedVideoMaterialProviderConfig = Readonly<{
  // Undefined means "not configured" -- generate() then refuses by name,
  // the same fail-closed stance unavailableMaterialProvider takes.
  baseUrl: string | undefined;
  runCommand?: CommandRunner;
  client?: WanAlphaClient;
}>;

const ProbeSchema = z.object({
  streams: z.array(
    z
      .object({
        codec_type: z.string(),
        codec_name: z.string().optional(),
        pix_fmt: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        avg_frame_rate: z.string().optional(),
        nb_read_frames: z.string().optional(),
      })
      .passthrough(),
  ),
});

const frameRate = (value: string | undefined): number => {
  const [numerator, denominator] = (value ?? "").split("/").map(Number);
  return numerator && denominator ? numerator / denominator : Number.NaN;
};

// Resizes and re-times the native stacked clip to the scene's own canvas,
// fps and frame count, then checks the result before trusting it.
//
// The stacked frame (RGB on top, alpha-as-luma on bottom) is just an
// ordinary opaque frame as far as ffmpeg's scale/fps filters are concerned
// -- scaling and re-timing the whole frame uniformly keeps the 50/50 split
// exactly where it was, so this step never has to know it is stacked.
// `-stream_loop -1` plus a hard `-frames:v` cap makes one ffmpeg
// invocation cover both directions of the retime -- looping a short native
// clip out to a longer scene duration, and trimming it down to a shorter
// one -- without a branch for which case this is.
async function retimeAlphaVideo(
  nativeBytes: Uint8Array,
  canvas: MaterialRequest["canvas"],
  run: CommandRunner,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const workspace = await mkdtemp(join(tmpdir(), "rvs-wan-alpha-"));
  try {
    const inputPath = join(workspace, "native.mp4");
    const outputPath = join(workspace, "retimed.mp4");
    await writeFile(inputPath, nativeBytes);
    const stackedHeight = canvas.height * 2;
    await run(
      process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
      [
        "-nostdin",
        "-y",
        "-stream_loop",
        "-1",
        "-i",
        inputPath,
        "-vf",
        `scale=${canvas.width}:${stackedHeight}:flags=bicubic,fps=${canvas.fps}`,
        "-frames:v",
        String(canvas.frameCount),
        "-an",
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
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { cwd: workspace, signal },
    );
    const probe = await run(
      process.env.RVS_FFPROBE_PATH ?? "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_entries",
        "stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames",
        "-of",
        "json",
        outputPath,
      ],
      { cwd: workspace, signal },
    );
    const parsed = ProbeSchema.parse(JSON.parse(probe.stdout));
    const video = parsed.streams.find(
      (stream) => stream.codec_type === "video",
    );
    if (
      !video ||
      video.codec_name !== "h264" ||
      video.pix_fmt !== "yuv420p" ||
      video.width !== canvas.width ||
      video.height !== stackedHeight ||
      frameRate(video.avg_frame_rate) !== canvas.fps ||
      Number(video.nb_read_frames) !== canvas.frameCount
    )
      throw new Error("WAN_ALPHA_RETIME_QC_FAILED");
    return await readFile(outputPath);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export function createSelfHostedVideoMaterialProvider(
  config: SelfHostedVideoMaterialProviderConfig,
): MaterialProvider {
  const baseUrl = config.baseUrl;
  const client = config.client ?? defaultWanAlphaClient;
  const run = config.runCommand ?? runCommand;
  return {
    tool: WAN_ALPHA_TOOL,
    generate: async (request, signal) => {
      if (!baseUrl)
        throw new MaterialGenerationError(
          "MATERIAL_PROVIDER_NOT_CONFIGURED",
          request.assetId,
          "RVS_WAN_ALPHA_BASE_URL is not configured for this deployment",
        );
      const seed =
        request.seed ?? deriveMaterialSeed(request.assetId, request.prompt);
      const native = await client(
        baseUrl,
        { prompt: request.prompt, seed },
        signal,
      );
      const bytes = await retimeAlphaVideo(native, request.canvas, run, signal);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return {
        bytes,
        contentType: "video/mp4" as const,
        provenance: {
          tool: WAN_ALPHA_TOOL,
          prompt: request.prompt,
          seed,
          sha256,
        },
      };
    },
  };
}
