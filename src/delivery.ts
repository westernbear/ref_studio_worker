import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

export type FrameInput = Readonly<{ readonly index: number; readonly path: string }>
export type AudioInput = Readonly<{ readonly samplesPerChannel: number; readonly channels: number; readonly path: string }>
export type DeliveryInput = Readonly<{ readonly tenantId: string; readonly jobId: string; readonly attemptId: string; readonly frames: readonly FrameInput[]; readonly audio: AudioInput; readonly outputRoot: string }>
export type MediaRunner = (command: "ffmpeg" | "ffprobe", args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>
export type DeliveryDatabase = Readonly<{ readonly publishStaged: (record: StagedArtifact) => void; readonly rejectT5: (attemptId: string) => void }>
export type StagedArtifact = Readonly<{ readonly tenantId: string; readonly jobId: string; readonly attemptId: string; readonly casPath: string; readonly sha256: string; readonly state: "AWAITING_T5" }>

const frameCount = 120
const audioSamples = 192_000

export class DeliveryFailure extends Error {
  readonly code: "MEDIA_CONTRACT_INVALID" | "FFMPEG_FAILED" | "FFPROBE_INVALID" | "STALE_EPOCH" | "T5_REJECTED" | "ARTIFACT_UNAVAILABLE"
  constructor(code: DeliveryFailure["code"]) { super(code); this.name = "DeliveryFailure"; this.code = code }
}

export const fixedFfmpegArgs = (audio: AudioInput, outputPath: string): readonly string[] => [
  "-nostdin", "-y", "-framerate", "30", "-i", "frame-%03d.png", "-i", audio.path,
  "-map", "0:v:0", "-map", "1:a:0", "-frames:v", String(frameCount), "-af", "aresample=48000:async=0", "-ar", "48000", "-ac", "2", "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", outputPath,
]

function validateInputs(input: DeliveryInput): void {
  if (input.frames.length !== frameCount || input.frames.some((frame, index) => frame.index !== index)) throw new DeliveryFailure("MEDIA_CONTRACT_INVALID")
  if (input.audio.samplesPerChannel !== audioSamples || input.audio.channels !== 2) throw new DeliveryFailure("MEDIA_CONTRACT_INVALID")
}

export async function assembleDelivery(input: DeliveryInput, runner: MediaRunner): Promise<Readonly<{ readonly outputPath: string; readonly ffmpegArgs: readonly string[]; readonly qc: unknown }>> {
  validateInputs(input)
  const outputPath = join(input.outputRoot, `${input.attemptId}.mp4`)
  const ffmpegArgs = fixedFfmpegArgs(input.audio, outputPath)
  const ffmpeg = await runner("ffmpeg", ffmpegArgs)
  if (ffmpeg.code !== 0) throw new DeliveryFailure("FFMPEG_FAILED")
  const ffprobe = await runner("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", outputPath])
  if (ffprobe.code !== 0) throw new DeliveryFailure("FFPROBE_INVALID")
  return { outputPath, ffmpegArgs, qc: JSON.parse(ffprobe.stdout) }
}

export async function stagePrivateCas(input: Readonly<{ readonly tenantId: string; readonly jobId: string; readonly attemptId: string; readonly sourcePath: string; readonly casRoot: string; readonly epoch: number; readonly currentEpoch: () => number; readonly db: DeliveryDatabase }>): Promise<StagedArtifact> {
  if (input.currentEpoch() !== input.epoch) throw new DeliveryFailure("STALE_EPOCH")
  const bytes = await readFile(input.sourcePath)
  const digest = createHash("sha256").update(bytes).digest("hex")
  const directory = join(input.casRoot, input.tenantId)
  await mkdir(directory, { recursive: true })
  const finalPath = join(directory, digest)
  const partialPath = `${finalPath}.partial-${input.attemptId}`
  const handle = await open(partialPath, "w", 0o600)
  await handle.writeFile(bytes); await handle.sync(); await handle.close()
  await rename(partialPath, finalPath)
  const parent = await open(dirname(finalPath), "r"); await parent.sync(); await parent.close()
  if (input.currentEpoch() !== input.epoch) throw new DeliveryFailure("STALE_EPOCH")
  const record: StagedArtifact = { tenantId: input.tenantId, jobId: input.jobId, attemptId: input.attemptId, casPath: finalPath, sha256: digest, state: "AWAITING_T5" }
  input.db.publishStaged(record)
  return record
}

export function authorizeDownload(record: StagedArtifact | undefined, tenantId: string, nowExpired: boolean): string {
  if (!record || record.tenantId !== tenantId || record.state !== "AWAITING_T5" || nowExpired) throw new DeliveryFailure("ARTIFACT_UNAVAILABLE")
  throw new DeliveryFailure("ARTIFACT_UNAVAILABLE")
}

export function rejectT5(db: DeliveryDatabase, attemptId: string): never { db.rejectT5(attemptId); throw new DeliveryFailure("T5_REJECTED") }
