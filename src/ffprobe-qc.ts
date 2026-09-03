import { z } from "zod";

export const DELIVERY_GOP = 60;

export const FfprobeStream = z
  .object({
    index: z.number().int().optional(),
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    pix_fmt: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    avg_frame_rate: z.string().optional(),
    r_frame_rate: z.string().optional(),
    start_time: z.string().optional(),
    color_transfer: z.string().optional(),
    color_space: z.string().optional(),
    color_primaries: z.string().optional(),
    channels: z.number().int().optional(),
    sample_rate: z.string().optional(),
    profile: z.string().optional(),
    level: z.number().int().optional(),
    nb_read_frames: z.string().optional(),
    tags: z.object({ rotate: z.string().optional() }).default({}),
  })
  .passthrough();

export const FfprobeFormat = z
  .object({
    duration: z.string().optional(),
    size: z.string().optional(),
    format_name: z.string().optional(),
  })
  .passthrough();

export const FfprobeFrame = z
  .object({
    media_type: z.string().optional(),
    key_frame: z.number().int().min(0).max(1).optional(),
    pix_fmt: z.string().optional(),
    color_space: z.string().optional(),
    color_transfer: z.string().optional(),
    color_primaries: z.string().optional(),
    nb_read_frames: z.string().optional(),
  })
  .passthrough();

export const FfprobeDocument = z
  .object({
    format: FfprobeFormat.optional(),
    streams: z.array(FfprobeStream).default([]),
    frames: z.array(FfprobeFrame).default([]),
  })
  .passthrough();

export type FfprobeStream = z.infer<typeof FfprobeStream>;
export type FfprobeDocument = z.infer<typeof FfprobeDocument>;

export type ProbeCanvas = Readonly<{
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}>;

export const parseFfprobeJson = (raw: string): FfprobeDocument =>
  FfprobeDocument.parse(JSON.parse(raw));

export const fraction = (value: string | undefined): number => {
  const [numerator, denominator] = (value ?? "").split("/").map(Number);
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

export const videoStream = (
  probe: FfprobeDocument,
): FfprobeStream | undefined =>
  probe.streams.find((stream) => stream.codec_type === "video");

export const audioStream = (
  probe: FfprobeDocument,
): FfprobeStream | undefined =>
  probe.streams.find((stream) => stream.codec_type === "audio");

export const mergeDeliveryProbes = (
  metadataRaw: string,
  framesRaw: string,
  audioRaw: string,
): FfprobeDocument => {
  const metadata = parseFfprobeJson(metadataRaw);
  const frames = parseFfprobeJson(framesRaw);
  const audio = parseFfprobeJson(audioRaw);
  return {
    ...metadata,
    frames: frames.frames,
    streams: [...metadata.streams, ...audio.streams],
  };
};

export const h264CanvasMismatch = (
  video: FfprobeStream | undefined,
  canvas: ProbeCanvas,
  requireColorMetadata = false,
): boolean =>
  !video ||
  video.codec_name !== "h264" ||
  video.pix_fmt !== "yuv420p" ||
  video.width !== canvas.width ||
  video.height !== canvas.height ||
  fraction(video.avg_frame_rate) !== canvas.fps ||
  Number(video.nb_read_frames) !== canvas.frameCount ||
  (requireColorMetadata &&
    (video.color_space !== "bt709" ||
      video.color_transfer !== "bt709" ||
      video.color_primaries !== "bt709"));

export type DeliveryQc = Readonly<{
  video: FfprobeStream &
    Readonly<{
      width: number;
      height: number;
      codec_name: string;
      profile: string;
      pix_fmt: string;
    }>;
  audio: FfprobeStream &
    Readonly<{
      codec_name: string;
      profile: string;
      channels: number;
      sample_rate: string;
    }>;
  duration: number;
}>;

export const validateDeliveryQc = (
  probe: FfprobeDocument,
  canvas: ProbeCanvas,
  options: Readonly<{
    errorToken: string;
    gop?: number;
    durationSeconds?: number;
    requireColorMetadata?: boolean;
  }>,
): DeliveryQc => {
  const gop = options.gop ?? DELIVERY_GOP;
  const durationSeconds =
    options.durationSeconds ?? canvas.frameCount / canvas.fps;
  const video = videoStream(probe);
  const audio = audioStream(probe);
  const duration = Number(probe.format?.duration);
  const keyFrames = probe.frames
    .filter((frame) => frame.media_type === "video")
    .flatMap((frame, index) => (frame.key_frame === 1 ? [index] : []));
  if (
    video === undefined ||
    audio === undefined ||
    h264CanvasMismatch(
      video,
      canvas,
      options.requireColorMetadata === true,
    ) ||
    video.profile !== "High" ||
    video.level !== 41 ||
    audio.codec_name !== "aac" ||
    audio.profile !== "LC" ||
    audio.channels !== 2 ||
    audio.sample_rate !== "48000" ||
    keyFrames.length !== Math.ceil(canvas.frameCount / gop) ||
    keyFrames.some((frame, index) => frame !== index * gop) ||
    !Number.isFinite(duration) ||
    Math.abs(duration - durationSeconds) > 0.05
  )
    throw new Error(options.errorToken);
  return {
    video: video as DeliveryQc["video"],
    audio: audio as DeliveryQc["audio"],
    duration,
  };
};
