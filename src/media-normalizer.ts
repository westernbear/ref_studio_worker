import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  FfprobeDocument,
  fraction,
  videoStream,
  audioStream,
} from "./ffprobe-qc.js";
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
  const parsed = FfprobeDocument.safeParse(JSON.parse(probeResult.stdout));
  const format = parsed.success ? parsed.data.format : undefined;
  if (
    !parsed.success ||
    format?.duration === undefined ||
    format.size === undefined ||
    format.format_name === undefined ||
    parsed.data.streams.some((stream) => stream.index === undefined)
  )
    throw new Error("MEDIA_PROBE_INVALID");
  const video = videoStream(parsed.data);
  const audio = audioStream(parsed.data);
  const duration = Number(format.duration);
  const size = Number(format.size);
  const fps = fraction(video?.avg_frame_rate);
  const realRate = fraction(video?.r_frame_rate);
  const transfer = video?.color_transfer;
  const rotation = rotationFilter(video?.tags.rotate);
  const rotated = rotation?.startsWith("transpose") ?? false;
  const width = rotated ? video?.height : video?.width;
  const height = rotated ? video?.width : video?.height;
  const longSide = Math.max(width ?? 0, height ?? 0);
  const shortSide = Math.min(width ?? 0, height ?? 0);
  if (
    !video ||
    !format.format_name.includes("mp4") ||
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
    shortSide > 2160 ||
    Number(video.start_time ?? 0) < 0 ||
    !Number.isInteger(request.startFrame) ||
    request.startFrame < 0 ||
    request.frameCount !== request.sourceFps * 4 ||
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
  const videoFilters = [
    ...(rotation ? rotation.split(",") : []),
    `trim=start_frame=${request.startFrame}:end_frame=${request.startFrame + request.frameCount}`,
    "setpts=PTS-STARTPTS",
    color,
    `fps=${request.sourceFps}`,
  ].join(",");
  const args = ["-nostdin", "-noautorotate", "-i", request.inputPath];
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
  const frameProbeResult = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "json",
      request.outputPath,
    ],
    { cwd: request.workspace, signal: request.signal },
  );
  const frameProbe = FfprobeDocument.safeParse(
    JSON.parse(frameProbeResult.stdout),
  );
  if (
    !frameProbe.success ||
    Number(frameProbe.data.streams[0]?.nb_read_frames) !== request.frameCount
  )
    throw new Error("NORMALIZED_ARTIFACT_CORRUPT");
  if ((await stat(request.outputPath)).size === 0)
    throw new Error("NORMALIZED_ARTIFACT_CORRUPT");
  const outputHash = createHash("sha256");
  for await (const chunk of createReadStream(request.outputPath))
    outputHash.update(chunk);
  return {
    sha256: outputHash.digest("hex"),
    durationMs: 4_000,
    fps: request.sourceFps,
    frameCount: request.frameCount,
  };
}
