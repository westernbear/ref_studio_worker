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
  uploadScenePackageArtifact: vi.fn(
    async (_jobId: string, sourcePath: string) => ({
      artifactId: "scenepackage-a",
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
    runtimeSnapshotDigest: "a".repeat(64),
  },
  qc: { status: "PASS" },
  safetySampleFramePath: `${outPath}.sample.png`,
  scenePackageArchivePath: `${outPath}.scene-package.tar`,
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

    // Not the job's own signal: the assets phase composes it with its own
    // material deadline (see materialDeadlineMs) and passes the composed
    // one down, so every call in this phase aborts when either fires.
    expect(fake.downloadAttachment).toHaveBeenCalledWith(
      "job-a",
      "att_1",
      expect.stringContaining("logo"),
      expect.any(AbortSignal),
    );
    expect(fake.uploadSceneAsset).toHaveBeenCalledWith(
      "job-a",
      "logo",
      expect.stringMatching(/logo\.png$/u),
      "image/png",
      expect.any(AbortSignal),
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
      materialProviderFactory: () => provider,
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

  it("gives up on a material provider that never returns", async () => {
    // The lease is 90s but the heartbeat keeps renewing it, so without a
    // deadline of its own a stuck or swapping inference service held the
    // job for as long as the worker process lived. Quantised weights on a
    // small card make that a realistic failure, not a theoretical one.
    const fake = api();
    let aborted = false;
    const provider: MaterialProvider = {
      tool: "hanging-provider@1",
      generate: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("MATERIAL_ABORTED"));
          });
        }),
    };
    const handler = createWorkflowJobHandler({
      api: fake,
      materialProviderFactory: () => provider,
      materialDeadlineMs: 20,
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

    await expect(handler(job("assets", generated), signal)).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(fake.uploadSceneAsset).not.toHaveBeenCalled();
  });

  it("builds the real provider through the factory, once per job, with that job's id", async () => {
    const fake = api();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9]);
    const materialProviderFactory = vi.fn(
      (jobId: string): MaterialProvider => ({
        tool: `remote@${jobId}`,
        generate: async (request) => ({
          bytes,
          contentType: "image/png" as const,
          provenance: {
            tool: `remote@${jobId}`,
            prompt: request.prompt,
            seed: 11,
            sha256: sha256(bytes),
          },
        }),
      }),
    );
    const handler = createWorkflowJobHandler({
      api: fake,
      materialProviderFactory,
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

    // The endpoints default to "no such service" when the API sends none
    // -- an older API, or a deployment that configured neither generator.
    expect(materialProviderFactory).toHaveBeenCalledWith("job-a", {
      video: null,
      model3d: null,
    });
    expect(materialProviderFactory).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      assets: [
        {
          assetId: "backdrop",
          provenance: {
            tool: "remote@job-a",
            prompt: "a dark studio backdrop",
            seed: 11,
            sha256: sha256(bytes),
          },
        },
      ],
    });
  });

  // The two self-hosted generators are addressed from the admin console
  // now, not from each worker host's environment.
  it("passes the material endpoints the API sent through to the factory", async () => {
    const fake = api();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9]);
    const materialProviderFactory = vi.fn(
      (jobId: string): MaterialProvider => ({
        tool: `remote@${jobId}`,
        generate: async (request) => ({
          bytes,
          contentType: "image/png" as const,
          provenance: {
            tool: `remote@${jobId}`,
            prompt: request.prompt,
            seed: 11,
            sha256: sha256(bytes),
          },
        }),
      }),
    );
    const handler = createWorkflowJobHandler({
      api: fake,
      materialProviderFactory,
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
    const claimed = job("assets", generated);
    const withEndpoints = {
      ...claimed,
      payload: {
        ...claimed.payload,
        materialEndpoints: {
          video: "http://wan-alpha:8000",
          model3d: "http://hi3dgen:8000",
        },
      },
    };

    await handler(withEndpoints, signal);

    expect(materialProviderFactory).toHaveBeenCalledWith("job-a", {
      video: "http://wan-alpha:8000",
      model3d: "http://hi3dgen:8000",
    });
  });

  it("never calls generate on the factory's provider for a scene needing only attachments", async () => {
    // The factory itself may run per job (building the wrapper is cheap,
    // no network call happens until generate() is invoked) -- what must
    // never happen is a vendor call for a scene that names no generated
    // asset at all.
    const fake = api();
    const generate = vi.fn(() => {
      throw new Error("must not be called");
    });
    const materialProviderFactory = vi.fn(
      (): MaterialProvider => ({ tool: "remote", generate }),
    );
    const handler = createWorkflowJobHandler({
      api: fake,
      materialProviderFactory,
    } as unknown as WorkflowPipelineDependencies);

    await handler(job("assets", attachmentSpec), signal);

    expect(generate).not.toHaveBeenCalled();
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
      await writeFile(`${outPath}.scene-package.tar`, "scene-package");
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
      scenePackageArtifactId: "scenepackage-a",
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
    expect(result["report"]).not.toHaveProperty("scenePackageArchivePath");
    expect(
      (result["report"] as { runtime: Record<string, unknown> }).runtime,
    ).not.toHaveProperty("runtimeSnapshotDigest");
    expect(renderGenerated).toHaveBeenCalledWith(
      expect.objectContaining({
        renderCachePath: expect.stringMatching(
          /rvs-render-cache\/[a-f0-9]{64}$/u,
        ),
      }),
      expect.any(Object),
    );
    expect(fake.uploadScenePackageArtifact).toHaveBeenCalledWith(
      "job-a",
      expect.stringMatching(/scene-package\.tar$/u),
      expect.any(AbortSignal),
    );
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

  it("publishes nothing when audio validation or mux is cancelled", async () => {
    const fake = api();
    const controller = new AbortController();
    const handler = createWorkflowJobHandler({
      api: fake,
      renderGenerated: vi.fn(async ({ signal }) => {
        controller.abort(new Error("WORKER_JOB_CANCELLED"));
        expect(signal.aborted).toBe(true);
        throw signal.reason;
      }),
    } as unknown as WorkflowPipelineDependencies);

    await expect(
      handler(job("gen-render", spec(), { assets: [] }), controller.signal),
    ).rejects.toThrow("WORKER_JOB_CANCELLED");
    expect(fake.uploadGeneratedArtifact).not.toHaveBeenCalled();
    expect(fake.uploadScenePackageArtifact).not.toHaveBeenCalled();
    expect(fake.uploadSafetySample).not.toHaveBeenCalled();
  });
});
