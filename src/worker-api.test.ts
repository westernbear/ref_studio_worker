import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkerApi, WorkerApiError } from "./worker-api.js";
import type { WorkerConfig } from "./worker-config.js";
import type { MaterialRequest } from "./material-provider.js";

const config: WorkerConfig = {
  apiBaseUrl: "https://api.example.test",
  token: "secret-token",
  workerId: "worker-test",
  capabilities: ["renderer"],
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 10_000,
  apiRequestTimeoutMs: 30_000,
  mediaRequestTimeoutMs: 1_800_000,
};

const request: MaterialRequest = {
  assetId: "backdrop",
  kind: "image",
  prompt: "a dark studio backdrop",
  seed: 7,
  canvas: { width: 1080, height: 1920, fps: 30, frameCount: 60 },
};

describe("WorkerApi.uploadScenePackageArtifact", () => {
  it("uploads the archive to the scene-package route", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rvs-scene-upload-"));
    try {
      const archive = join(workspace, "scene-package.tar");
      await writeFile(archive, "archive");
      const requests: Request[] = [];
      const api = createWorkerApi(config, async (input, init) => {
        const sent = new Request(input, init);
        requests.push(sent);
        const path = new URL(sent.url).pathname;
        if (path.endsWith("/register"))
          return Response.json({
            workerId: "worker-test",
            sessionToken: "session-token",
          });
        if (path.endsWith("/claim"))
          return Response.json({
            job: {
              jobId: "job-a",
              attemptId: "attempt-a",
              leaseToken: "lease-token",
              leaseExpiresAt: "2099-08-23T01:00:00.000Z",
              payload: {},
            },
          });
        if (path.endsWith("/artifacts/scene-package"))
          return Response.json({
            artifactId: "scene-package-a",
            sha256: "a".repeat(64),
            sizeBytes: 7,
          });
        throw new Error(`unexpected request: ${path}`);
      });
      await api.register();
      await api.claim();
      requests.length = 0;

      await api.uploadScenePackageArtifact(
        "job-a",
        archive,
        new AbortController().signal,
      );

      expect(new URL(requests[0]!.url).pathname).toBe(
        "/v1/workers/worker-test/jobs/job-a/artifacts/scene-package",
      );
      expect(requests[0]?.headers.get("content-type")).toBe(
        "application/x-tar",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// Registers and claims a job so requestMaterial has a session token and a
// lease to attach, the same as every other authenticated call this client
// makes.
const readyApi = async (
  onMaterial: (body: unknown) => Response,
): Promise<{
  api: ReturnType<typeof createWorkerApi>;
  requests: Request[];
}> => {
  const requests: Request[] = [];
  const api = createWorkerApi(config, async (input, init) => {
    const request_ = new Request(input, init);
    requests.push(request_);
    const path = new URL(input.toString()).pathname;
    if (path.endsWith("/register"))
      return Response.json({
        workerId: "worker-test",
        sessionToken: "session-token",
      });
    if (path.endsWith("/claim"))
      return Response.json({
        job: {
          jobId: "job-a",
          attemptId: "attempt-a",
          leaseToken: "lease-token",
          leaseExpiresAt: "2099-08-23T01:00:00.000Z",
          payload: {},
        },
      });
    if (path.endsWith("/material"))
      return onMaterial(JSON.parse(await request_.clone().text()));
    throw new Error(`unexpected request: ${path}`);
  });
  await api.register();
  await api.claim();
  requests.length = 0;
  return { api, requests };
};

describe("WorkerApi.requestMaterial", () => {
  // The API relays this to an image model and holds the request open until
  // it answers -- tens of seconds, not milliseconds. Under the ordinary
  // JSON timeout the worker gave up mid-generation and failed the job with
  // WORKER_JOB_HANDLER_FAILED, for an asset that was on its way.
  it("waits on the media budget, not the ordinary JSON one", async () => {
    const budgets: number[] = [];
    const { api } = await readyApi(() =>
      Response.json({
        contentType: "image/png",
        bytesBase64: Buffer.from(Uint8Array.from([1])).toString("base64"),
        provenance: {
          tool: "t",
          prompt: "p",
          sha256: createHash("sha256")
            .update(Uint8Array.from([1]))
            .digest("hex"),
        },
      }),
    );
    // AbortSignal.timeout is how readResponse budgets a call; recording
    // what it is asked for is the only way to see the budget from outside.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ((ms: number) => {
      budgets.push(ms);
      return realTimeout(ms);
    }) as typeof AbortSignal.timeout;
    try {
      await api.requestMaterial("job-a", request, new AbortController().signal);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    expect(budgets).toEqual([config.mediaRequestTimeoutMs]);
    expect(budgets).not.toContain(config.apiRequestTimeoutMs);
  });

  it("posts the request to the job's material endpoint with the lease header", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { api, requests } = await readyApi((body) => {
      expect(body).toEqual({
        assetId: "backdrop",
        kind: "image",
        prompt: "a dark studio backdrop",
        seed: 7,
        canvas: { width: 1080, height: 1920, fps: 30, frameCount: 60 },
      });
      return Response.json({
        contentType: "image/png",
        bytesBase64: Buffer.from(bytes).toString("base64"),
        provenance: {
          tool: "openai:gpt-image-2",
          prompt: "a dark studio backdrop",
          seed: 11,
          sha256,
        },
      });
    });

    const material = await api.requestMaterial(
      "job-a",
      request,
      new AbortController().signal,
    );

    expect(material.bytes).toEqual(Buffer.from(bytes));
    expect(material.contentType).toBe("image/png");
    expect(material.provenance).toEqual({
      tool: "openai:gpt-image-2",
      prompt: "a dark studio backdrop",
      seed: 11,
      sha256,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/workers/worker-test/jobs/job-a/material",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer session-token",
    );
    expect(requests[0]?.headers.get("x-worker-lease")).toBe("lease-token");
  });

  it("omits seed from provenance when the response does not surface one", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { api } = await readyApi(() =>
      Response.json({
        contentType: "image/png",
        bytesBase64: Buffer.from(bytes).toString("base64"),
        provenance: {
          tool: "openai:gpt-image-2",
          prompt: "a dark studio backdrop",
          sha256,
        },
      }),
    );

    const material = await api.requestMaterial(
      "job-a",
      request,
      new AbortController().signal,
    );

    expect("seed" in material.provenance).toBe(false);
  });

  it("surfaces the API's error code when the request is refused", async () => {
    const { api } = await readyApi(() =>
      Response.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message:
              'material generation for kind "video" is not implemented; only "image" material generation is available',
            correlationId: "cor_test",
            details: [],
          },
        },
        { status: 422 },
      ),
    );

    const error = await api
      .requestMaterial("job-a", request, new AbortController().signal)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WorkerApiError);
    expect((error as WorkerApiError).code).toBe("INVALID_REQUEST");
    expect((error as WorkerApiError).message).toMatch(/not implemented/);
  });
});
