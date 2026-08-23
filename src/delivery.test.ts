import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assembleDelivery, authorizeDownload, rejectT5, stagePrivateCas, type DeliveryInput } from "./delivery.js"

const input = async (): Promise<DeliveryInput> => {
  const root = await mkdtemp(join(tmpdir(), "rvs-delivery-"))
  const frames = Array.from({ length: 120 }, (_, index) => ({ index, path: `frame-${String(index).padStart(3, "0")}.png` }))
  return { tenantId: "tenant-a", jobId: "job-a", attemptId: "attempt-a", frames, audio: { samplesPerChannel: 192_000, channels: 2, path: "audio.wav" }, outputRoot: root }
}

describe("delivery boundary", () => {
  it("uses fixed media arguments and rejects missing media", async () => {
    const fixture = await input(); const commands: string[] = []
    const result = await assembleDelivery(fixture, async (command, args) => { commands.push(`${command}:${args.join(" ")}`); return { code: 0, stdout: "{}" } })
    expect(result.ffmpegArgs).toContain("-frames:v"); expect(result.ffmpegArgs).toContain("120"); expect(commands[0]).toContain("ffmpeg:")
    expect(commands.map((command) => command.split(":", 1)[0])).toEqual(["ffmpeg", "ffprobe"])
    await expect(assembleDelivery({ ...fixture, frames: fixture.frames.slice(1) }, async () => ({ code: 0, stdout: "{}" }))).rejects.toMatchObject({ code: "MEDIA_CONTRACT_INVALID" })
  })
  it("maps FFmpeg and ffprobe failures independently", async () => {
    const fixture = await input()
    await expect(assembleDelivery(fixture, async (command) => command === "ffmpeg" ? { code: 1, stdout: "" } : { code: 0, stdout: "{}" })).rejects.toMatchObject({ code: "FFMPEG_FAILED" })
    await expect(assembleDelivery(fixture, async (command) => command === "ffprobe" ? { code: 1, stdout: "" } : { code: 0, stdout: "{}" })).rejects.toMatchObject({ code: "FFPROBE_INVALID" })
  })
  it("stages after fsync and never authorizes an awaiting T5 ref", async () => {
    const fixture = await input(); const source = join(fixture.outputRoot, "source.mp4"); await writeFile(source, "fixture")
    const records: string[] = []; const record = await stagePrivateCas({ ...fixture, sourcePath: source, casRoot: join(fixture.outputRoot, "cas"), epoch: 4, currentEpoch: () => 4, db: { publishStaged: (value) => records.push(value.state), rejectT5: () => undefined } })
    expect(record.state).toBe("AWAITING_T5"); expect(records).toEqual(["AWAITING_T5"])
    expect(() => authorizeDownload(record, fixture.tenantId, false)).toThrow("ARTIFACT_UNAVAILABLE")
  })
  it("records T5 rejection without exposing a download", () => { const rejected: string[] = []; expect(() => rejectT5({ publishStaged: () => undefined, rejectT5: (id) => rejected.push(id) }, "attempt-a")).toThrow("T5_REJECTED"); expect(rejected).toEqual(["attempt-a"]) })
})
