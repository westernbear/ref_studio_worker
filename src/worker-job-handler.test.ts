import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileEvidenceScene } from "./render-delivery.js";
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
    { index: 1, codec_type: "audio", channels: 2, sample_rate: "48000" },
  ],
};

const evidence = (frameCount = 120): Record<string, unknown> => ({
  state: "MAPPED",
  observed: {
    palette: ["#000000", "#ffffff"],
    effects: Array.from({ length: frameCount }, () => ({
      lowerLightRgb16x9: Array<number>(16 * 9 * 3).fill(0),
    })),
  },
  sceneInput: {
    tenantId: "ten_a",
    editor: "reference-compiler",
    reason: "measured reference evidence",
    timestamp: "1970-01-01T00:00:00.000Z",
    gate: "PENDING",
    needsChoice: [],
    owners: [
      {
        ownerId: "global-residual",
        kind: "global-residual",
        editable: true,
        assetRef: "asset-global-residual",
        confidence: 1,
      },
    ],
    editableAssets: [
      {
        assetId: "asset-global-residual",
        kind: "measured-background",
        editable: true,
        owner: "global-residual",
      },
    ],
    geometry: {
      "global-residual": {
        boundsPerFrame: [{ frame: 0, x: 0, y: 0, width: 1080, height: 1920 }],
        fixedWidth: true,
        fixedX: true,
      },
    },
    tracks: [
      {
        trackId: "track-global-residual",
        owner: "global-residual",
        lifecycle: {
          enter: { start: 0 },
          stable: { start: 0 },
          exit: { start: frameCount },
        },
        geometryRef: "global-residual",
        effects: ["residual-canvas"],
      },
    ],
    effects: {
      "global-residual": {
        "residual-canvas": { source: "all-frame measurements" },
      },
    },
    residualCanvas: {
      owner: "global-residual",
      measurements: ["lower-light field"],
      mustRemainSeparate: true,
      compositeRule: "background then semantic owners",
    },
    audio: {
      sampleRateHz: 48_000,
      channels: 2,
      frameRate: 30,
      anchors: [],
    },
    passes: [
      {
        passId: "background-dom",
        owner: "global-residual",
        kind: "DOM/SVG",
        shader: null,
        reads: ["asset-global-residual"],
        writes: "background-layer",
      },
    ],
    layerOrder: ["background-layer"],
    allowedShaders: [],
  },
});

const dependencies = () => {
  const events: string[] = [];
  const compiledEvidence = evidence();
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
        return {
          stdout: JSON.stringify(
            args.includes("-count_frames")
              ? { streams: [{ nb_read_frames: "120" }] }
              : probe,
          ),
          stderr: "",
        };
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
        evidence: compiledEvidence,
        evidenceDigest: createHash("sha256")
          .update(JSON.stringify(compiledEvidence))
          .digest("hex"),
      };
    });
  const renderDelivery: WorkflowPipelineDependencies["renderDelivery"] = vi.fn(
    async ({
      evidence: renderEvidence,
      expectedCompilation,
      outputPath,
      mode,
    }) => {
      expect(renderEvidence).toEqual(compiledEvidence);
      expect(expectedCompilation).toEqual(
        compileEvidenceScene(compiledEvidence, "ten_a"),
      );
      events.push("render");
      await writeFile(outputPath, "rendered-mp4");
      return { status: "PASS", mode, frameCount: 120 };
    },
  );
  return {
    dependencies: { api, runCommand, compileEvidence, renderDelivery },
    events,
    api,
    compiledEvidence,
  };
};

type Phase = "analyze" | "compile" | "preview" | "render";
const job = (phase: Phase) => {
  const compiledEvidence = evidence();
  const compilation = compileEvidenceScene(compiledEvidence, "ten_a");
  const evidenceDigest = createHash("sha256")
    .update(JSON.stringify(compiledEvidence))
    .digest("hex");
  return {
    jobId: "job-a",
    attemptId: "attempt-a",
    leaseToken: "lease-token",
    leaseExpiresAt: "2099-08-23T01:00:00.000Z",
    payload: {
      tenantId: "ten_a",
      uploadId: "upl_a",
      startFrame: 0,
      sourceFps: 30,
      frameCount: 120,
      deletionEpoch: 0,
      restoreEpoch: 0,
      phase,
      ...(phase === "analyze" ? {} : { evidence: compiledEvidence }),
      ...(phase === "preview" || phase === "render"
        ? {
            evidenceDigest,
            compilation,
            browserPassSpecDigest: compilation.browserPassSpec.digest,
          }
        : {}),
    },
  };
};

describe("workflow job handler", () => {
  beforeEach(() => {
    vi.stubEnv("RVS_FFPROBE_PATH", "ffprobe");
    vi.stubEnv("RVS_FFMPEG_PATH", "ffmpeg");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("analyzes every normalized source frame without creating a preview", async () => {
    const fixture = dependencies();
    const handler = createWorkflowJobHandler(fixture.dependencies);

    await expect(
      handler(job("analyze"), new AbortController().signal),
    ).resolves.toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "analyze",
      evidence: { state: "MAPPED" },
      normalized: { durationMs: 4_000, fps: 30, frameCount: 120 },
    });
    expect(fixture.events).toEqual([
      "progress:download",
      "download",
      "progress:ffprobe",
      "ffprobe",
      "progress:normalize",
      "ffmpeg",
      "ffprobe",
      "progress:compiler",
      "compile",
      "progress:compiler:analysis",
      "progress:evidence",
    ]);
    expect(fixture.api.uploadPreview).not.toHaveBeenCalled();
    expect(fixture.api.uploadArtifact).not.toHaveBeenCalled();
  });

  it("recompiles resolved evidence without downloading source media", async () => {
    const fixture = dependencies();
    const handler = createWorkflowJobHandler(fixture.dependencies);

    await expect(
      handler(job("compile"), new AbortController().signal),
    ).resolves.toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "compile",
      evidenceDigest: createHash("sha256")
        .update(JSON.stringify(fixture.compiledEvidence))
        .digest("hex"),
    });
    expect(fixture.events).toEqual([
      "progress:scene-compile",
      "progress:scene-compile",
    ]);
    expect(fixture.api.downloadSource).not.toHaveBeenCalled();
  });

  it("renders the promoted IR into the preview slot", async () => {
    const fixture = dependencies();
    const handler = createWorkflowJobHandler(fixture.dependencies);

    await expect(
      handler(job("preview"), new AbortController().signal),
    ).resolves.toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "preview",
      previewArtifactId: "preview-a",
      report: { status: "PASS", mode: "preview" },
    });
    expect(fixture.api.uploadPreview).toHaveBeenCalledOnce();
    expect(fixture.api.uploadArtifact).not.toHaveBeenCalled();
  });

  it("renders the approved IR into the private delivery slot", async () => {
    const fixture = dependencies();
    const handler = createWorkflowJobHandler(fixture.dependencies);

    await expect(
      handler(job("render"), new AbortController().signal),
    ).resolves.toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "render",
      artifactId: "artifact-a",
      report: { status: "PASS", mode: "delivery" },
    });
    expect(fixture.events).toContain("render");
    expect(fixture.events.at(-2)).toBe("progress:upload");
    expect(fixture.events.at(-1)).toBe("upload");
    expect(fixture.api.uploadArtifact).toHaveBeenCalledOnce();
  });

  it("aborts render and assembly at the configured deadline", async () => {
    const fixture = dependencies();
    const renderDelivery: WorkflowPipelineDependencies["renderDelivery"] =
      vi.fn(
        async ({ signal }) =>
          new Promise<Record<string, unknown>>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("WORKER_JOB_CANCELLED")),
              { once: true },
            );
          }),
      );
    const handler = createWorkflowJobHandler({
      ...fixture.dependencies,
      renderDelivery,
      renderDeadlineMs: 5,
    });

    await expect(
      handler(job("render"), new AbortController().signal),
    ).rejects.toThrow("RENDER_DEADLINE");
    expect(fixture.api.uploadArtifact).not.toHaveBeenCalled();
  });
});
