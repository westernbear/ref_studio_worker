import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { SceneSpec, SpecAsset } from "./contracts/index.js";
import type { CommandRunner } from "./process-runner.js";

const AudioProbe = z
  .object({
    format: z.object({ duration: z.string() }).passthrough(),
    streams: z.array(
      z
        .object({
          codec_type: z.string(),
          codec_name: z.string(),
          profile: z.string().optional(),
          channels: z.number().int().positive().optional(),
          sample_rate: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type ValidatedAudio = Readonly<{
  path: string;
  gainDb: number;
  durationPolicy: "trim" | "pad" | "reject";
  durationSeconds: number;
  sha256: string;
}>;

const fail = (): never => {
  throw new Error("MEDIA_QC_FAILED");
};

export async function validateAudioAsset(
  input: Readonly<{
    asset: SpecAsset;
    path: string;
    expectedSha256: string;
    contentType: string;
    canvas: SceneSpec["canvas"];
    workspace: string;
    signal: AbortSignal;
  }>,
  run: CommandRunner,
): Promise<ValidatedAudio> {
  const localPath = resolve(input.path);
  const fromWorkspace = relative(resolve(input.workspace), localPath);
  if (
    input.asset.kind !== "audio" ||
    input.asset.origin !== "attachment" ||
    input.asset.audio === undefined ||
    input.contentType !== "video/mp4" ||
    fromWorkspace === "" ||
    fromWorkspace === ".." ||
    fromWorkspace.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(fromWorkspace)
  )
    fail();
  const policy = input.asset.audio;
  if (policy === undefined) throw new Error("MEDIA_QC_FAILED");
  if (
    !Number.isFinite(policy.gainDb) ||
    policy.gainDb < -24 ||
    policy.gainDb > 12
  )
    fail();

  const bytes = await readFile(localPath, { signal: input.signal });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.expectedSha256)
    throw new Error("WORKER_ASSET_DIGEST_MISMATCH");

  const result = await run(
    process.env.RVS_FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,profile,channels,sample_rate",
      "-of",
      "json=compact=1",
      localPath,
    ],
    { cwd: input.workspace, signal: input.signal },
  );
  let parsed: z.infer<typeof AudioProbe>;
  try {
    parsed = AudioProbe.parse(JSON.parse(result.stdout));
  } catch {
    return fail();
  }
  const audio = parsed.streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  const durationSeconds = Number(parsed.format.duration);
  const targetSeconds = input.canvas.frameCount / input.canvas.fps;
  if (
    parsed.streams.some((stream) => stream.codec_type === "video") ||
    audio.length !== 1 ||
    audio[0]?.codec_name !== "aac" ||
    audio[0]?.profile !== "LC" ||
    audio[0]?.sample_rate !== "48000" ||
    audio[0]?.channels !== 2 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    (policy.durationPolicy === "reject" &&
      Math.abs(durationSeconds - targetSeconds) > 0.05) ||
    (policy.durationPolicy === "trim" &&
      durationSeconds + 0.05 < targetSeconds) ||
    (policy.durationPolicy === "pad" && durationSeconds - 0.05 > targetSeconds)
  )
    fail();
  return {
    path: localPath,
    gainDb: policy.gainDb,
    durationPolicy: policy.durationPolicy,
    durationSeconds,
    sha256,
  };
}
