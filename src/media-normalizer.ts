import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CommandRunner } from "./process-runner.js";

const ADMITTED_FPS = [24, 25, 30, 50, 60] as const;
const VIDEO_CODECS = new Set(["h264", "hevc", "vp9", "av1"]);
const PIXEL_FORMATS = new Set([
  "yuv420p",
  "yuv422p",
  "yuv444p",
  "yuv420p10le",
  "yuv422p10le",
  "yuv444p10le",
]);
const TRANSFERS = new Set(["bt709", "iec61966-2-1"]);

const Probe = z.object({
  format: z.object({
    duration: z.string(),
    size: z.string(),
    format_name: z.string(),
  }),
  streams: z.array(
    z
      .object({
        index: z.number().int(),
        codec_type: z.string(),
        codec_name: z.string().optional(),
        pix_fmt: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        avg_frame_rate: z.string().optional(),
        r_frame_rate: z.string().optional(),
        start_time: z.string().optional(),
        color_transfer: z.string().optional(),
        channels: z.number().int().optional(),
        sample_rate: z.string().optional(),
        tags: z.object({ rotate: z.string().optional() }).default({}),
      })
      .passthrough(),
  ),
});

export type NormalizationRequest = Readonly<{
  inputPath: string;
  outputPath: string;
  startFrame: number;
  sourceFps: (typeof ADMITTED_FPS)[number];
  frameCount: number;
  workspace: string;
  signal: AbortSignal;
  onProbeComplete?: () => Promise<void>;
}>;
export type NormalizedMedia = Readonly<{
  sha256: string;
  durationMs: 4_000;
  fps: (typeof ADMITTED_FPS)[number];
  frameCount: number;
}>;

const rate = (value: string | undefined): number => {
  const [numerator, denominator] = (value ?? "").split("/").map(Number);
  return numerator && denominator ? numerator / denominator : Number.NaN;
};

const rotationFilter = (value: string | undefined): string | null => {
  const normalized = ((Number(value ?? 0) % 360) + 360) % 360;
  if (normalized === 0) return null;
  if (normalized === 90) return "transpose=clock";
  if (normalized === 180) return "hflip,vflip";
  if (normalized === 270) return "transpose=cclock";
  throw new Error("MEDIA_ROTATION_INVALID");
};

const audioFilter = (channels: number): string => {
  if (channels === 1) return "pan=stereo|c0=1.0*c0|c1=1.0*c0";
  if (channels === 2) return "pan=stereo|c0=1.0*c0|c1=1.0*c1";
  return "pan=stereo|c0=1.0*FL+0.707*FC+0.707*BL+0.5*LFE|c1=1.0*FR+0.707*FC+0.707*BR+0.5*LFE";
};

const portraitCrop = (
  width: number,
  height: number,
): readonly [number, number, number, number] => {
  const sourceIsWider = width * 16 > height * 9;
  const cropWidth = sourceIsWider
    ? Math.floor((height * 9) / 16 / 2) * 2
    : width;
  const cropHeight = sourceIsWider
    ? height
    : Math.floor((width * 16) / 9 / 2) * 2;
  return [
    cropWidth,
    cropHeight,
    Math.floor((width - cropWidth) / 2),
    Math.floor((height - cropHeight) / 2),
  ];
};

export async function normalizeMedia(
  request: NormalizationRequest,
  run: CommandRunner,
): Promise<NormalizedMedia> {
  const probeResult = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,format_name:stream=index,codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,time_base,start_time,duration,field_order,color_space,color_transfer,color_primaries,channels,channel_layout,sample_rate:stream_tags=rotate",
      "-of",
      "json",
      request.inputPath,
    ],
    { cwd: request.workspace, signal: request.signal },
  );
  const parsed = Probe.safeParse(JSON.parse(probeResult.stdout));
  if (!parsed.success) throw new Error("MEDIA_PROBE_INVALID");
  const video = parsed.data.streams.find(
    (stream) => stream.codec_type === "video",
  );
  const audio = parsed.data.streams.find(
    (stream) => stream.codec_type === "audio",
  );
  const duration = Number(parsed.data.format.duration);
  const size = Number(parsed.data.format.size);
  const fps = rate(video?.avg_frame_rate);
  const realRate = rate(video?.r_frame_rate);
  const transfer = video?.color_transfer;
  const rotation = rotationFilter(video?.tags.rotate);
  const rotated = rotation?.startsWith("transpose") ?? false;
  const width = rotated ? video?.height : video?.width;
  const height = rotated ? video?.width : video?.height;
  const longSide = Math.max(width ?? 0, height ?? 0);
  const shortSide = Math.min(width ?? 0, height ?? 0);
  if (
    !video ||
    !parsed.data.format.format_name.includes("mp4") ||
    !VIDEO_CODECS.has(video.codec_name ?? "") ||
    !PIXEL_FORMATS.has(video.pix_fmt ?? "") ||
    (transfer !== undefined && !TRANSFERS.has(transfer)) ||
    fps !== request.sourceFps ||
    realRate !== fps ||
    !ADMITTED_FPS.includes(request.sourceFps) ||
    !Number.isFinite(duration) ||
    duration < 1 ||
    duration > 300 ||
    !Number.isFinite(size) ||
    size < 1 ||
    size > 2 * 1024 * 1024 * 1024 ||
    longSide > 3840 ||
    !width ||
    !height ||
    shortSide < 360 ||
    shortSide > 2160 ||
    Number(video.start_time ?? 0) < 0 ||
    request.frameCount !== request.sourceFps * 4 ||
    request.startFrame + request.frameCount > Math.floor(duration * fps) ||
    (audio?.channels ?? 0) > 8
  )
    throw new Error("MEDIA_CONTRACT_INVALID");
  await request.onProbeComplete?.();

  const startSeconds = request.startFrame / request.sourceFps;
  const endSeconds =
    (request.startFrame + request.frameCount) / request.sourceFps;
  const color =
    transfer === undefined || transfer === "bt709"
      ? "colorspace=all=bt709:iall=bt709"
      : "colorspace=all=bt709:itrc=iec61966-2-1";
  const [cropWidth, cropHeight, cropX, cropY] = portraitCrop(width, height);
  const videoFilters = [
    ...(rotation ? rotation.split(",") : []),
    `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`,
    `trim=start_frame=${request.startFrame}:end_frame=${request.startFrame + request.frameCount}`,
    "setpts=PTS-STARTPTS",
    color,
    `fps=${request.sourceFps}`,
  ].join(",");
  const args = ["-nostdin", "-y", "-noautorotate", "-i", request.inputPath];
  if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-map",
    "0:v:0",
    "-map",
    audio ? `0:${audio.index}` : "1:a:0",
    "-vf",
    videoFilters,
    "-af",
    audio
      ? `atrim=start=${startSeconds}:end=${endSeconds},asetpts=PTS-STARTPTS,aresample=48000,${audioFilter(audio.channels ?? 2)}`
      : "atrim=start=0:end=4,asetpts=PTS-STARTPTS",
    "-c:v",
    "ffv1",
    "-pix_fmt",
    "yuv444p10le",
    "-c:a",
    "pcm_s16le",
    "-fflags",
    "+bitexact",
    request.outputPath,
  );
  await run(process.env.RVS_FFMPEG_PATH ?? "ffmpeg", args, {
    cwd: request.workspace,
    signal: request.signal,
  });
  const bytes = await readFile(request.outputPath);
  if (bytes.byteLength === 0) throw new Error("NORMALIZED_ARTIFACT_CORRUPT");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    durationMs: 4_000,
    fps: request.sourceFps,
    frameCount: request.frameCount,
  };
}
