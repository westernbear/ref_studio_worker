import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CANVAS,
  DELIVERY_FPS,
  sha256Hex,
  type SceneSpec,
} from "./contracts/index.js";
import type { MaterialProvider } from "./material-provider.js";
import {
  createWorkflowJobHandler,
  type WorkflowPipelineDependencies,
} from "./worker-job-handler.js";

const sourceBytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]);
const logoBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const spec = (
  assets: SceneSpec["assets"] = [],
  assetRefs: readonly string[] = [],
): SceneSpec => ({
  schema: "scene-spec-v1",
  mode: "SWAP",
  canvas: {
    width: CANVAS["9:16"].width,
    height: CANVAS["9:16"].height,
    fps: DELIVERY_FPS,
    frameCount: 30,
  },
  palette: {
    hero: "#ff5500",
    cool: "#3355ff",
    warm: "#ffaa33",
    background: "#101018",
  },
  assets,
  beats: [
    {
      beatId: "beat-only",
      startFrame: 0,
      endFrame: 30,
      shot: "hard-cut",
      elements: [
        {
          elementId: "headline",
          kind: "text",
          content: "SHORT",
          box: { x: 100, y: 800, width: 880, height: 200 },
          keyframes: [{ frame: 0, opacity: 1, ease: "linear" }],
          effects: [],
        },
        ...assetRefs.map((assetRef, index) => ({
          elementId: `asset-${index}`,
          kind: "image" as const,
          assetRef,
          box: { x: 0, y: 0, width: 100, height: 100 },
          keyframes: [],
          effects: [],
        })),
      ],
    },
  ],
});

const attachmentSpec = spec(
  [
    {
      assetId: "logo",
      kind: "image",
      origin: "attachment",
      ref: "attachment://att_1",
    },
  ],
  ["logo"],
);

const api = () => ({
  downloadSource: vi.fn(async () => undefined),
  reportProgress: vi.fn(async () => undefined),
  uploadArtifact: vi.fn(async () => ({
    artifactId: "artifact-a",
    sha256: "c".repeat(64),
    sizeBytes: 1,
  })),
  uploadPreview: vi.fn(async () => ({
    artifactId: "preview-a",
    sha256: "c".repeat(64),
    sizeBytes: 1,
  })),
  uploadPreviewLabeled: vi.fn(async () => ({
    artifactId: "preview-labeled-a",
    sha256: "c".repeat(64),
    sizeBytes: 1,
  })),
  uploadEvidenceVideo: vi.fn(async () => ({
    artifactId: "evidence-video-a",
    sha256: "c".repeat(64),
    sizeBytes: 1,
  })),
  uploadSafetySample: vi.fn(async (_jobId: string, sourcePath: string) => {
    await readFile(sourcePath).catch(() => undefined);
    return {
      artifactId: "safetysample-a",
      sha256: "c".repeat(64),
      sizeBytes: 1,
    };
  }),
  uploadGeneratedArtifact: vi.fn(
    async (_jobId: string, sourcePath: string) => ({
      artifactId: "genartifact-a",
      sha256: sha256(await readFile(sourcePath)),
      sizeBytes: (await readFile(sourcePath)).byteLength,
    }),
  ),
  downloadAttachment: vi.fn(
    async (_jobId: string, _attachmentId: string, destinationPath: string) => {
      await writeFile(destinationPath, logoBytes);
      return { contentType: "image/png" };
    },
  ),
  downloadSceneAsset: vi.fn(
    async (_jobId: string, _assetId: string, destinationPath: string) => {
      await writeFile(destinationPath, logoBytes);
      return { contentType: "image/png" };
    },
  ),
  uploadSceneAsset: vi.fn(async (_jobId: string, assetId: string) => ({
    artifactId: `genasset-${assetId}`,
    sha256: sha256(logoBytes),
    sizeBytes: logoBytes.byteLength,
  })),
});

const job = (
  phase: "assets" | "gen-render",
  scene: SceneSpec,
  extra: Record<string, unknown> = {},
) => ({
  jobId: "job-a",
  attemptId: "attempt-a",
  leaseToken: "lease-token",
  leaseExpiresAt: "2099-08-23T01:00:00.000Z",
  payload: {
    tenantId: "ten_a",
    uploadId: "upl_a",
    sourceSha256: sha256(sourceBytes),
    startFrame: 0,
    sourceFps: 30,
    frameCount: 120,
    deletionEpoch: 0,
    restoreEpoch: 0,
    phase,
    spec: scene,
    specDigest: sha256Hex(scene),
    attachmentIds: ["att_1"],
    ...extra,
  },
});

const generatedReport = (outPath: string) => ({
  schema: "rvs.gen-render-report.v1" as const,
  specDigest: "e".repeat(64),
  outputSha256: "f".repeat(64),
  outputBytes: 12,
  frameSha256: Array<string>(30).fill("d".repeat(64)),
  runtime: {
    chromiumVersion: "151.0.7922.138",
    renderer: "ANGLE SwiftShader",
    fontReady: true,
    webgl2: true,
    networkPolicy: "external-blocked",
    repeatedFrameByteIdentity: true,
  },
  qc: { status: "PASS" },
  safetySampleFramePath: `${outPath}.sample.png`,
});

const signal = new AbortController().signal;

describe("the assets worker phase", () => {
  it("reports an empty asset list for a scene that needs no material", async () => {
    const fake = api();
    const handler = createWorkflowJobHandler({
      api: fake,
    } as unknown as WorkflowPipelineDependencies);

    const result = await handler(job("assets", spec()), signal);

    expect(result).toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "assets",
      assets: [],
    });
    expect(fake.uploadSceneAsset).not.toHaveBeenCalled();
    expect(fake.downloadSource).not.toHaveBeenCalled();
  });

  it("fetches an attachment's bytes and stores them as an artifact", async () => {
    const fake = api();
    const handler = createWorkflowJobHandler({
      api: fake,
    } as unknown as WorkflowPipelineDependencies);

    const result = await handler(job("assets", attachmentSpec), signal);

    expect(fake.downloadAttachment).toHaveBeenCalledWith(
      "job-a",
      "att_1",
      expect.stringContaining("logo"),
      signal,
    );
    expect(fake.uploadSceneAsset).toHaveBeenCalledWith(
      "job-a",
      "logo",
      expect.stringMatching(/logo\.png$/u),
      "image/png",
      signal,
    );
    expect(result).toMatchObject({
      phase: "assets",
      assets: [
        {
          assetId: "logo",
          artifactId: "genasset-logo",
          sha256: sha256(logoBytes),
          provenance: null,
        },
      ],
    });
  });

  it("fails the job when a scene asks for material and no provider can make it", async () => {
    const fake = api();
    const handler = createWorkflowJobHandler({
      api: fake,
    } as unknown as WorkflowPipelineDependencies);
    const generated = spec(
      [
        {
          assetId: "backdrop",
          kind: "image",
          origin: "generated",
          ref: "generated://backdrop",
          provenance: {
            tool: "author-declared",
            prompt: "a dark studio backdrop",
            seed: 7,
            sha256: "0".repeat(64),
          },
        },
      ],
      ["backdrop"],
    );

    await expect(handler(job("assets", generated), signal)).rejects.toThrow(
      /MATERIAL_PROVIDER_UNAVAILABLE:backdrop/u,
    );
    expect(fake.uploadSceneAsset).not.toHaveBeenCalled();
  });

  it("records the provider's provenance when one is wired", async () => {
    const fake = api();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9]);
    const provider: MaterialProvider = {
      tool: "fake-provider@1",
      generate: async (request) => ({
        bytes,
        contentType: "image/png" as const,
        provenance: {
          tool: "fake-provider@1",
          prompt: request.prompt,
          seed: 11,
          sha256: sha256(bytes),
        },
      }),
    };
    const handler = createWorkflowJobHandler({
      api: fake,
      materialProvider: provider,
    } as unknown as WorkflowPipelineDependencies);
    const generated = spec(
      [
        {
          assetId: "backdrop",
          kind: "image",
          origin: "generated",
          ref: "generated://backdrop",
          provenance: {
            tool: "author-declared",
            prompt: "a dark studio backdrop",
            seed: 7,
            sha256: "0".repeat(64),
          },
        },
      ],
      ["backdrop"],
    );

    const result = await handler(job("assets", generated), signal);

    expect(result).toMatchObject({
      assets: [
        {
          assetId: "backdrop",
          provenance: {
            tool: "fake-provider@1",
            prompt: "a dark studio backdrop",
            seed: 11,
            sha256: sha256(bytes),
          },
        },
      ],
    });
  });

  it("refuses a payload whose spec is not the spec its digest names", async () => {
    const fake = api();
    const handler = createWorkflowJobHandler({
      api: fake,
    } as unknown as WorkflowPipelineDependencies);
    const bad = job("assets", spec());
    bad.payload.specDigest = "a".repeat(64);

    await expect(handler(bad, signal)).rejects.toThrow(
      /WORKER_SPEC_DIGEST_MISMATCH/u,
    );
  });
});

describe("the gen-render worker phase", () => {
  const renderGenerated: WorkflowPipelineDependencies["renderGenerated"] =
    vi.fn(async ({ outPath }) => {
      await writeFile(outPath, "generated-mp4");
      return generatedReport(outPath);
    });

  it("fetches every stored asset, renders the scene, and binds its report", async () => {
    const fake = api();
    const handler = createWorkflowJobHandler({
      api: fake,
      renderGenerated,
    } as unknown as WorkflowPipelineDependencies);

    const result = (await handler(
      job("gen-render", attachmentSpec, {
        assets: [
          {
            assetId: "logo",
            artifactId: "genasset-logo",
            sha256: sha256(logoBytes),
            contentType: "image/png",
          },
        ],
      }),
      signal,
    )) as Record<string, unknown>;

    expect(fake.downloadSceneAsset).toHaveBeenCalledWith(
      "job-a",
      "logo",
      expect.stringMatching(/logo\.png$/u),
      signal,
    );
    expect(fake.downloadSource).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      protocol: "rvs.worker.v1",
      phase: "gen-render",
      artifactId: "genartifact-a",
      safetySampleArtifactId: "safetysample-a",
    });
    // The wire report carries the job/attempt this render belongs to, and
    // drops the local sample path the API's strict schema would reject.
    expect(result["report"]).toMatchObject({
      schema: "rvs.gen-render-report.v1",
      jobId: "job-a",
      attemptId: "attempt-a",
    });
    expect(result["report"]).not.toHaveProperty("safetySampleFramePath");
  });

  it("refuses an asset whose bytes are not the ones the API bound", async () => {
    const fake = api();
    const handler = createWorkflowJobHandler({
      api: fake,
      renderGenerated,
    } as unknown as WorkflowPipelineDependencies);

    await expect(
      handler(
        job("gen-render", attachmentSpec, {
          assets: [
            {
              assetId: "logo",
              artifactId: "genasset-logo",
              sha256: "a".repeat(64),
              contentType: "image/png",
            },
          ],
        }),
        signal,
      ),
    ).rejects.toThrow(/WORKER_ASSET_DIGEST_MISMATCH/u);
  });
});
