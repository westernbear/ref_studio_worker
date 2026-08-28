import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createWorkerRuntime } from "./index.js";
import {
  CANVAS,
  DELIVERY_FPS,
  sha256Hex,
  type SceneSpec,
} from "./contracts/index.js";
import type { WorkerConfig } from "./worker-config.js";

const config: WorkerConfig = {
  apiBaseUrl: "https://api.example.test",
  token: "secret-token",
  workerId: "worker-test",
  capabilities: ["compiler"],
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 10_000,
  apiRequestTimeoutMs: 30_000,
  mediaRequestTimeoutMs: 1_800_000,
};

const assetsJob = (spec: SceneSpec) => ({
  jobId: "job-a",
  attemptId: "attempt-a",
  leaseToken: "lease",
  leaseExpiresAt: "2026-08-23T01:00:00.000Z",
  payload: {
    tenantId: "ten_a",
    uploadId: "upl_a",
    sourceSha256: createHash("sha256")
      .update(Uint8Array.from([1]))
      .digest("hex"),
    startFrame: 0,
    sourceFps: 30,
    frameCount: 120,
    phase: "assets",
    spec,
    specDigest: sha256Hex(spec),
    attachmentIds: [],
    deletionEpoch: 0,
    restoreEpoch: 0,
  },
});

const objectFormScene = (): SceneSpec => ({
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
  assets: [
    {
      assetId: "handset",
      kind: "image",
      origin: "generated",
      form: "object",
      ref: "generated://handset",
      provenance: {
        tool: "author-declared",
        prompt: "a matte black handset, three-quarter view",
        seed: 7,
        sha256: "0".repeat(64),
      },
    },
  ],
  beats: [
    {
      beatId: "beat-only",
      startFrame: 0,
      endFrame: 30,
      shot: "hard-cut",
      elements: [
        {
          elementId: "asset-0",
          kind: "image",
          assetRef: "handset",
          box: { x: 0, y: 0, width: 100, height: 100 },
          keyframes: [],
          effects: [],
        },
      ],
    },
  ],
});

describe("worker entrypoint", () => {
  it("routes an analysis job through the workflow handler to source download", async () => {
    const requests: string[] = [];
    const runtime = createWorkerRuntime(config, undefined, async (input) => {
      const path = new URL(input.toString()).pathname;
      requests.push(path);
      if (path.endsWith("/register"))
        return Response.json({
          workerId: "worker-test",
          sessionToken: "session",
        });
      if (path.endsWith("/claim"))
        return Response.json({
          job: {
            jobId: "job-a",
            attemptId: "attempt-a",
            leaseToken: "lease",
            leaseExpiresAt: "2026-08-23T01:00:00.000Z",
            payload: {
              tenantId: "ten_a",
              uploadId: "upl_a",
              sourceSha256: createHash("sha256")
                .update(Uint8Array.from([1]))
                .digest("hex"),
              startFrame: 0,
              sourceFps: 30,
              frameCount: 120,
              phase: "analyze",
              deletionEpoch: 0,
              restoreEpoch: 0,
            },
          },
        });
      if (path.endsWith("/source"))
        return new Response(Uint8Array.from([1]), {
          headers: { "content-type": "video/mp4" },
        });
      return Response.json({ ok: true });
    });
    await runtime.api.register();
    const job = await runtime.api.claim();
    if (!job) throw new Error("expected claimed job");

    await expect(
      runtime.handleJob(job, AbortSignal.abort()),
    ).rejects.not.toThrow("WORKER_JOB_HANDLER_NOT_IMPLEMENTED");
    expect(requests).toContain("/v1/workers/worker-test/jobs/job-a/source");
  });

  // The Hi3DGen provider is reachable only through form: "object", and
  // only when RVS_HI3DGEN_BASE_URL is set. With it unset -- the shape of
  // every deployment that runs the image provider alone -- an object-form
  // asset must fail by name rather than quietly falling through to the 2D
  // image provider, which would render a flat picture of something the
  // scene asked to be a real object. The live Hi3DGen+Blender path itself
  // is unexercised here: there is no service and no Blender binary in this
  // environment (see self-hosted-3d-material-provider.test.ts for the
  // injected-fake coverage of that provider's own behaviour).
  it("routes an object-form asset to the 3D provider, which refuses when unconfigured", async () => {
    const scene = objectFormScene();
    const paths: string[] = [];
    const runtime = createWorkerRuntime(config, undefined, async (input) => {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (path.endsWith("/register"))
        return Response.json({
          workerId: "worker-test",
          sessionToken: "session",
        });
      if (path.endsWith("/claim"))
        return Response.json({ job: assetsJob(scene) });
      return Response.json({ ok: true });
    });
    await runtime.api.register();
    const job = await runtime.api.claim();
    if (!job) throw new Error("expected claimed job");

    await expect(
      runtime.handleJob(job, new AbortController().signal),
    ).rejects.toThrow(/MATERIAL_PROVIDER_NOT_CONFIGURED:handset/);
    // Never offered to the remote image provider, whose whole request path
    // is /material.
    expect(paths.some((path) => path.endsWith("/material"))).toBe(false);
  });

  it("wires the assets phase's real image material provider end to end", async () => {
    const scene: SceneSpec = {
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
      assets: [
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
      beats: [
        {
          beatId: "beat-only",
          startFrame: 0,
          endFrame: 30,
          shot: "hard-cut",
          elements: [
            {
              elementId: "asset-0",
              kind: "image",
              assetRef: "backdrop",
              box: { x: 0, y: 0, width: 100, height: 100 },
              keyframes: [],
              effects: [],
            },
          ],
        },
      ],
    };
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const requestedMaterial: unknown[] = [];
    const runtime = createWorkerRuntime(config, undefined, async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/register"))
        return Response.json({
          workerId: "worker-test",
          sessionToken: "session",
        });
      if (path.endsWith("/claim"))
        return Response.json({
          job: {
            jobId: "job-a",
            attemptId: "attempt-a",
            leaseToken: "lease",
            leaseExpiresAt: "2026-08-23T01:00:00.000Z",
            payload: {
              tenantId: "ten_a",
              uploadId: "upl_a",
              sourceSha256: createHash("sha256")
                .update(Uint8Array.from([1]))
                .digest("hex"),
              startFrame: 0,
              sourceFps: 30,
              frameCount: 120,
              phase: "assets",
              spec: scene,
              specDigest: sha256Hex(scene),
              attachmentIds: [],
              deletionEpoch: 0,
              restoreEpoch: 0,
            },
          },
        });
      if (path.endsWith("/material"))
        return (async () => {
          requestedMaterial.push(await new Request(input).clone());
          return Response.json({
            contentType: "image/png",
            bytesBase64: Buffer.from(bytes).toString("base64"),
            provenance: {
              tool: "openai:gpt-image-2",
              prompt: "a dark studio backdrop",
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          });
        })();
      if (path.includes("/asset-artifact/"))
        return Response.json({
          artifactId: "genasset-backdrop",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
        });
      return Response.json({ ok: true });
    });
    await runtime.api.register();
    const job = await runtime.api.claim();
    if (!job) throw new Error("expected claimed job");

    const result = (await runtime.handleJob(
      job,
      new AbortController().signal,
    )) as { assets: readonly Record<string, unknown>[] };

    expect(requestedMaterial).toHaveLength(1);
    expect(result.assets).toEqual([
      {
        assetId: "backdrop",
        artifactId: "genasset-backdrop",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        provenance: {
          tool: "openai:gpt-image-2",
          prompt: "a dark studio backdrop",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    ]);
  });
});
