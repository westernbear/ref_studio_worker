import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SpecAsset } from "./contracts/index.js";
import { validateAudioAsset } from "./audio-decoder.js";
import { assembleGeneratedVideo } from "./generated-video-delivery.js";
import { runCommand, type CommandRunner } from "./process-runner.js";

const asset: SpecAsset = {
  assetId: "soundtrack",
  kind: "audio",
  origin: "attachment",
  ref: "attachment://soundtrack",
  audio: { gainDb: -3, durationPolicy: "reject" },
};
const canvas = { width: 64, height: 64, fps: 30, frameCount: 30 };
const validProbe = {
  format: { duration: "1.000000" },
  streams: [
    {
      codec_type: "audio",
      codec_name: "aac",
      profile: "LC",
      channels: 2,
      sample_rate: "48000",
    },
  ],
};

describe("validated generated audio", () => {
  it("accepts only hash-bound local AAC LC and forwards its explicit mux policy", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-audio-"));
    try {
      const path = join(workspace, "soundtrack.m4a");
      const bytes = Buffer.from("approved-audio");
      await writeFile(path, bytes);
      const calls: string[][] = [];
      const run: CommandRunner = async (_command, args) => {
        calls.push(args);
        return { stdout: JSON.stringify(validProbe), stderr: "" };
      };
      const validated = await validateAudioAsset(
        {
          asset,
          path,
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: "video/mp4",
          canvas,
          workspace,
          signal: new AbortController().signal,
        },
        run,
      );
      expect(validated).toMatchObject({
        path,
        gainDb: -3,
        durationPolicy: "reject",
        durationSeconds: 1,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(
        "format=duration:stream=codec_type,codec_name,profile,channels,sample_rate",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["codec", { streams: [{ ...validProbe.streams[0], codec_name: "mp3" }] }],
    ["profile", { streams: [{ ...validProbe.streams[0], profile: "HE-AAC" }] }],
    ["rate", { streams: [{ ...validProbe.streams[0], sample_rate: "44100" }] }],
    ["channels", { streams: [{ ...validProbe.streams[0], channels: 1 }] }],
    ["short reject", { format: { duration: "0.8" } }],
  ])("rejects invalid %s before mux", async (_name, override) => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-audio-invalid-"));
    try {
      const path = join(workspace, "soundtrack.m4a");
      const bytes = Buffer.from("invalid-audio");
      await writeFile(path, bytes);
      const probe = {
        ...validProbe,
        ...override,
        streams: "streams" in override ? override.streams : validProbe.streams,
      };
      await expect(
        validateAudioAsset(
          {
            asset,
            path,
            expectedSha256: createHash("sha256").update(bytes).digest("hex"),
            contentType: "video/mp4",
            canvas,
            workspace,
            signal: new AbortController().signal,
          },
          async () => ({ stdout: JSON.stringify(probe), stderr: "" }),
        ),
      ).rejects.toThrow("MEDIA_QC_FAILED");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects traversal, hash mismatch, and cancellation before mux", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-audio-boundary-"));
    const outside = join(workspace, "..", `outside-${Date.now()}.m4a`);
    const path = join(workspace, "soundtrack.m4a");
    const bytes = Buffer.from("boundary-audio");
    try {
      await writeFile(path, bytes);
      await writeFile(outside, bytes);
      const base = {
        asset,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: "video/mp4",
        canvas,
        workspace,
        signal: new AbortController().signal,
      };
      await expect(
        validateAudioAsset({ ...base, path: outside }, async () => ({
          stdout: JSON.stringify(validProbe),
          stderr: "",
        })),
      ).rejects.toThrow("MEDIA_QC_FAILED");
      await expect(
        validateAudioAsset(
          { ...base, path, expectedSha256: "0".repeat(64) },
          async () => ({ stdout: JSON.stringify(validProbe), stderr: "" }),
        ),
      ).rejects.toThrow("WORKER_ASSET_DIGEST_MISMATCH");

      const controller = new AbortController();
      await expect(
        validateAudioAsset(
          { ...base, path, signal: controller.signal },
          async (_command, _args, options) => {
            expect(options.signal).toBe(controller.signal);
            controller.abort(new Error("WORKER_JOB_CANCELLED"));
            throw controller.signal.reason;
          },
        ),
      ).rejects.toThrow("WORKER_JOB_CANCELLED");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it("renders the same real AAC fixture to byte-identical MP4 twice", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-audio-real-"));
    try {
      const frames = join(workspace, "frames");
      await mkdir(frames);
      const audioPath = join(workspace, "soundtrack.m4a");
      const signal = new AbortController().signal;
      await runCommand(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=64x64:r=30:d=1",
          join(frames, "frame-%06d.png"),
        ],
        { cwd: workspace, signal },
      );
      await runCommand(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=1",
          "-ac",
          "2",
          "-c:a",
          "aac",
          "-profile:a",
          "aac_low",
          "-b:a",
          "192k",
          audioPath,
        ],
        { cwd: workspace, signal },
      );
      const bytes = await readFile(audioPath);
      const validated = await validateAudioAsset(
        {
          asset,
          path: audioPath,
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: "video/mp4",
          canvas,
          workspace,
          signal,
        },
        runCommand,
      );
      const outputs = [join(workspace, "one.mp4"), join(workspace, "two.mp4")];
      for (const outputPath of outputs)
        await assembleGeneratedVideo(
          {
            canvas,
            framesDirectory: frames,
            outputPath,
            workspace,
            signal,
            audio: validated,
          },
          runCommand,
        );
      const hashes = await Promise.all(
        outputs.map(async (path) =>
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ),
      );
      expect(hashes[0]).toBe(hashes[1]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
