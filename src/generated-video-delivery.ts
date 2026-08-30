import { z } from "zod";
import type { SceneSpec } from "./contracts/index.js";
import type { CommandRunner } from "./process-runner.js";

const Probe = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      pix_fmt: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      nb_read_frames: z.string().optional(),
      profile: z.string().optional(),
      level: z.number().int().optional(),
      channels: z.number().int().positive().optional(),
      sample_rate: z.string().optional(),
    }),
  ),
  frames: z.array(
    z.object({
      media_type: z.string(),
      key_frame: z.number().int().min(0).max(1),
    }),
  ),
});
const ProbeMetadata = Probe.omit({ frames: true });
const ProbeFrames = Probe.pick({ frames: true });

const fraction = (value: string): number => {
  const [numerator, denominator] = value.split("/").map(Number);
  return numerator !== undefined && denominator
    ? numerator / denominator
    : Number.NaN;
};

const validate = (
  metadataRaw: string,
  framesRaw: string,
  canvas: SceneSpec["canvas"],
): Record<string, unknown> => {
  const probe = {
    ...ProbeMetadata.parse(JSON.parse(metadataRaw)),
    ...ProbeFrames.parse(JSON.parse(framesRaw)),
  };
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format.duration);
  const keyFrames = probe.frames
    .filter((frame) => frame.media_type === "video")
    .flatMap((frame, index) => (frame.key_frame === 1 ? [index] : []));
  if (
    !video ||
    video.codec_name !== "h264" ||
    video.profile !== "High" ||
    video.level !== 41 ||
    video.pix_fmt !== "yuv420p" ||
    video.width !== canvas.width ||
    video.height !== canvas.height ||
    fraction(video.avg_frame_rate ?? "") !== canvas.fps ||
    Number(video.nb_read_frames) !== canvas.frameCount ||
    !audio ||
    audio.codec_name !== "aac" ||
    audio.profile !== "LC" ||
    audio.channels !== 2 ||
    audio.sample_rate !== "48000" ||
    keyFrames.some((frame, index) => frame !== index * 60) ||
    keyFrames.length !== Math.ceil(canvas.frameCount / 60) ||
    !Number.isFinite(duration) ||
    Math.abs(duration - canvas.frameCount / canvas.fps) > 0.05
  )
    throw new Error("GENERATED_DELIVERY_QC_FAILED");
  return {
    status: "PASS",
    width: video.width,
    height: video.height,
    fps: canvas.fps,
    frameCount: canvas.frameCount,
    durationMs: Math.round(duration * 1_000),
    videoCodec: "h264",
    videoProfile: "high",
    videoLevel: "4.1",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    audioCodec: "aac",
    audioProfile: "aac_low",
    audioTargetBitRate: 192_000,
  };
};

export async function assembleGeneratedVideo(
  input: Readonly<{
    canvas: SceneSpec["canvas"];
    framesDirectory: string;
    outputPath: string;
    workspace: string;
    signal: AbortSignal;
  }>,
  run: CommandRunner,
): Promise<Record<string, unknown>> {
  await run(
    process.env.RVS_FFMPEG_PATH ?? "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-framerate",
      String(input.canvas.fps),
      "-start_number",
      "0",
      "-i",
      `${input.framesDirectory}/frame-%06d.png`,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-frames:v",
      String(input.canvas.frameCount),
      "-t",
      String(input.canvas.frameCount / input.canvas.fps),
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
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-flags",
      "+cgop",
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
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  const metadata = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,profile,level,width,height,pix_fmt,avg_frame_rate,nb_read_frames,channels,sample_rate",
      "-of",
      "json=compact=1",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  const frames = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=media_type,key_frame",
      "-of",
      "json=compact=1",
      input.outputPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  return validate(metadata.stdout, frames.stdout, input.canvas);
}
