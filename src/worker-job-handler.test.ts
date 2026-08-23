import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowJobHandler,
  type WorkflowPipelineDependencies,
} from "./worker-job-handler.js";

const probe = {
  format: {
    duration: "8.000000",
    size: "1000",
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
  },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      pix_fmt: "yuv420p",
      width: 1080,
      height: 1920,
      avg_frame_rate: "30/1",
      r_frame_rate: "30/1",
      start_time: "0.000000",
      color_transfer: "bt709",
      tags: {},
    },
    {
      index: 1,
      codec_type: "audio",
      channels: 2,
      sample_rate: "48000",
    },
  ],
};

const dependencies = () => {
  const events: string[] = [];
  const api = {
    downloadSource: vi.fn(async () => {
      events.push("download");
      return Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]);
    }),
    reportProgress: vi.fn(async (_jobId, progress) => {
      events.push(`progress:${progress.stage}`);
    }),
    uploadArtifact: vi.fn(async (_jobId, bytes) => {
      events.push("upload");
      return {
        artifactId: "artifact-a",
        sha256: "c".repeat(64),
        sizeBytes: bytes.byteLength,
      };
    }),
    uploadPreview: vi.fn(async (_jobId, bytes) => {
      events.push("upload-preview");
      return {
        artifactId: "preview-a",
        sha256: "d".repeat(64),
        sizeBytes: bytes.byteLength,
      };
    }),
  } satisfies WorkflowPipelineDependencies["api"];
  const runCommand: WorkflowPipelineDependencies["runCommand"] = vi.fn(
    async (command, args) => {
      events.push(command);
      if (command === "ffprobe")
        return { stdout: JSON.stringify(probe), stderr: "" };
      const output = args.at(-1);
      if (!output) throw new Error("missing output path");
      await writeFile(output, "normalized-media");
      return { stdout: "", stderr: "" };
    },
  );
  const compileEvidence: WorkflowPipelineDependencies["compileEvidence"] =
    vi.fn(async ({ normalizedPath, onProgress }) => {
      expect(await readFile(normalizedPath, "utf8")).toBe("normalized-media");
      events.push("compile");
      await onProgress("analysis", 0.5);
      return {
        evidence: { state: "MAPPED", measurements: [{ name: "ocr.bounds" }] },
        evidenceDigest: "a".repeat(64),
      };
    });
  const renderDelivery: WorkflowPipelineDependencies["renderDelivery"] = vi.fn(
    async ({ evidence, outputPath }) => {
      expect(evidence).toMatchObject({ state: "MAPPED" });
      events.push("render");
      await writeFile(outputPath, "rendered-mp4");
      return { status: "PASS", frameCount: 120 };
    },
  );
  return {
    dependencies: { api, runCommand, compileEvidence, renderDelivery },
    events,
    api,
  };
};

const job = (phase: "prepare" | "render") => ({
  jobId: "job-a",
  attemptId: "attempt-a",
  payload: {
    tenantId: "ten_a",
    uploadId: "upl_a",
    startFrame: 0,
    sourceFps: 30,
    frameCount: 120,
    phase,
    ...(phase === "render"
      ? {
          evidence: { state: "MAPPED", measurements: [] },
          evidenceDigest: createHash("sha256")
            .update(JSON.stringify({ state: "MAPPED", measurements: [] }))
            .digest("hex"),
        }
      : {}),
  },
});

describe("workflow job handler", () => {
  beforeEach(() => {
    vi.stubEnv("RVS_FFPROBE_PATH", "ffprobe");
    vi.stubEnv("RVS_FFMPEG_PATH", "ffmpeg");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("prepares real source bytes before returning compiler evidence", async () => {
    const fixture = dependencies();
    const handler = createWorkflowJobHandler(fixture.dependencies);

    await expect(
      handler(job("prepare"), new AbortController().signal),
    ).resolves.toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "prepare",
      evidence: { state: "MAPPED" },
      evidenceDigest: "a".repeat(64),
      previewArtifactId: "preview-a",
      normalized: { durationMs: 4_000, fps: 30, frameCount: 120 },
    });
    expect(fixture.events).toEqual([
      "progress:download",
      "download",
      "progress:ffprobe",
      "ffprobe",
      "progress:normalize",
      "ffmpeg",
      "progress:compiler",
      "compile",
      "progress:compiler:analysis",
      "progress:preview-render",
      "render",
      "progress:preview-upload",
      "upload-preview",
      "progress:evidence",
    ]);
    expect(fixture.api.uploadArtifact).not.toHaveBeenCalled();
    expect(fixture.api.uploadPreview).toHaveBeenCalledOnce();
  });

  it("renders approved evidence and uploads the produced MP4", async () => {
    const fixture = dependencies();
    const handler = createWorkflowJobHandler(fixture.dependencies);

    await expect(
      handler(job("render"), new AbortController().signal),
    ).resolves.toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "render",
      artifactId: "artifact-a",
      report: { status: "PASS", frameCount: 120 },
    });
    expect(fixture.events).toContain("render");
    expect(fixture.events.at(-2)).toBe("progress:upload");
    expect(fixture.events.at(-1)).toBe("upload");
    expect(fixture.api.uploadArtifact).toHaveBeenCalledOnce();
  });
});
