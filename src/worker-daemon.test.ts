import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApi, WorkerApiError } from "./worker-api.js";
import { runWorkerDaemon, WORKER_JOB_HANDLER_FAILED } from "./worker-daemon.js";
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
const sourceBytes = Uint8Array.from([1, 2, 3]);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

const createMediaApi = (
  source: () => Response | Promise<Response>,
): ReturnType<typeof createWorkerApi> =>
  createWorkerApi(config, async (input) => {
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
          leaseExpiresAt: "2026-08-23T01:00:00.000Z",
          payload: {},
        },
      });
    return source();
  });

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "rvs-worker-test-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("worker daemon API", () => {
  it("registers, heartbeats, and polls using typed payloads", async () => {
    const requests: Request[] = [];
    const fetcher = async (
      input: URL | RequestInfo,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      const path = new URL(input.toString()).pathname;
      return new Response(
        path.endsWith("/claim")
          ? JSON.stringify({ job: null })
          : JSON.stringify({
              workerId: "worker-test",
              sessionToken: "session-token",
            }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const api = createWorkerApi(config, fetcher);
    await api.register();
    await api.heartbeat();
    expect(await api.claim()).toBeNull();
    expect(
      requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual([
      "POST /v1/workers/register",
      "POST /v1/workers/worker-test/heartbeat",
      "POST /v1/workers/worker-test/claim",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer secret-token",
    );
    expect(requests[1]?.headers.get("authorization")).toBe(
      "Bearer session-token",
    );
    expect(requests[2]?.headers.get("authorization")).toBe(
      "Bearer session-token",
    );
    expect(await requests[0]?.text()).not.toContain("secret-token");
  });

  it("streams source and rendered media through file paths", async () => {
    // Given
    const requests: Request[] = [];
    const uploadedBodies: Uint8Array[] = [];
    const sourceArrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const api = createWorkerApi(config, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
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
            leaseExpiresAt: "2026-08-23T01:00:00.000Z",
            payload: {},
          },
        });
      if (path.endsWith("/source")) {
        const response = new Response(sourceBytes, {
          headers: { "content-type": "video/mp4" },
        });
        Object.defineProperty(response, "arrayBuffer", {
          value: sourceArrayBuffer,
        });
        return response;
      }
      if (path.endsWith("artifact")) {
        uploadedBodies.push(new Uint8Array(await request.arrayBuffer()));
        return Response.json({
          artifactId: "artifact-a",
          sha256: "a".repeat(64),
          sizeBytes: 3,
        });
      }
      return Response.json({ ok: true });
    });
    const signal = new AbortController().signal;
    const sourcePath = join(temporaryDirectory, "source.mp4");
    const artifactPath = join(temporaryDirectory, "artifact.mp4");
    const previewPath = join(temporaryDirectory, "preview.mp4");
    await writeFile(artifactPath, Uint8Array.from([4, 5, 6]));
    await writeFile(previewPath, Uint8Array.from([7, 8, 9]));
    await api.register();
    await api.claim();

    // When
    await api.downloadSource("job-a", sourcePath, sourceSha256, signal);
    await api.reportProgress(
      "job-a",
      {
        phase: "prepare",
        stage: "ffprobe",
        fraction: 0.2,
        framesProcessed: null,
        framesTotal: null,
      },
      signal,
    );
    await expect(
      api.uploadArtifact("job-a", artifactPath, signal),
    ).resolves.toMatchObject({ artifactId: "artifact-a", sizeBytes: 3 });
    await expect(
      api.uploadPreview("job-a", previewPath, signal),
    ).resolves.toMatchObject({ artifactId: "artifact-a", sizeBytes: 3 });

    // Then
    expect([...(await readFile(sourcePath))]).toEqual([1, 2, 3]);
    expect(sourceArrayBuffer).not.toHaveBeenCalled();
    expect(
      requests
        .slice(2)
        .map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ).toEqual([
      "GET /v1/workers/worker-test/jobs/job-a/source",
      "POST /v1/workers/worker-test/jobs/job-a/progress",
      "POST /v1/workers/worker-test/jobs/job-a/artifact",
      "POST /v1/workers/worker-test/jobs/job-a/preview-artifact",
    ]);
    expect(requests[2]?.headers.get("content-type")).toBe(null);
    expect(
      requests
        .slice(2)
        .every((request) => request.headers.has("X-Worker-Lease")),
    ).toBe(true);
    expect(requests[2]?.headers.get("X-Worker-Lease")).toBe("lease-token");
    expect(requests[4]?.headers.get("content-type")).toBe("video/mp4");
    expect(requests[4]?.headers.get("content-length")).toBe("3");
    expect(requests[5]?.headers.get("content-length")).toBe("3");
    expect(uploadedBodies).toEqual([
      Uint8Array.from([4, 5, 6]),
      Uint8Array.from([7, 8, 9]),
    ]);
  });

  it("removes source bytes and returns a deterministic digest mismatch", async () => {
    const api = createMediaApi(
      () =>
        new Response(sourceBytes, {
          headers: { "content-type": "video/mp4" },
        }),
    );
    const destinationPath = join(temporaryDirectory, "mismatch.mp4");
    await api.register();
    await api.claim();

    await expect(
      api.downloadSource(
        "job-a",
        destinationPath,
        "0".repeat(64),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "WORKER_SOURCE_DIGEST_MISMATCH" });
    await expect(readFile(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes an empty source destination", async () => {
    // Given
    const api = createMediaApi(
      () =>
        new Response(new Uint8Array(), {
          headers: { "content-type": "video/mp4" },
        }),
    );
    const destinationPath = join(temporaryDirectory, "empty.mp4");
    await api.register();
    await api.claim();

    // When / Then
    await expect(
      api.downloadSource(
        "job-a",
        destinationPath,
        sourceSha256,
        new AbortController().signal,
      ),
    ).rejects.toThrow("invalid media");
    await expect(readFile(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a partial source destination when streaming fails", async () => {
    // Given
    const api = createMediaApi(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.from([1, 2, 3]));
              queueMicrotask(() =>
                controller.error(new Error("stream failed")),
              );
            },
          }),
          { headers: { "content-type": "video/mp4" } },
        ),
    );
    const destinationPath = join(temporaryDirectory, "partial.mp4");
    await api.register();
    await api.claim();

    // When / Then
    await expect(
      api.downloadSource(
        "job-a",
        destinationPath,
        sourceSha256,
        new AbortController().signal,
      ),
    ).rejects.toThrow("stream failed");
    await expect(readFile(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes a partial source destination when streaming is aborted", async () => {
    // Given
    const controller = new AbortController();
    let chunkSent = false;
    const api = createMediaApi(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(streamController) {
              if (chunkSent) return;
              chunkSent = true;
              streamController.enqueue(new Uint8Array(64 * 1024));
              queueMicrotask(() => controller.abort(new Error("cancelled")));
            },
          }),
          { headers: { "content-type": "video/mp4" } },
        ),
    );
    const destinationPath = join(temporaryDirectory, "aborted.mp4");
    await api.register();
    await api.claim();

    // When / Then
    await expect(
      api.downloadSource(
        "job-a",
        destinationPath,
        sourceSha256,
        controller.signal,
      ),
    ).rejects.toMatchObject({
      path: "/v1/workers/worker-test/jobs/job-a/source",
      status: null,
    });
    await expect(readFile(destinationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves source response diagnostics", async () => {
    // Given
    const api = createMediaApi(() =>
      Response.json(
        {
          error: {
            code: "SOURCE_MISSING",
            message: "Source media was not found.",
          },
        },
        { status: 404 },
      ),
    );
    await api.register();
    await api.claim();

    // When / Then
    await expect(
      api.downloadSource(
        "job-a",
        join(temporaryDirectory, "missing.mp4"),
        sourceSha256,
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: WorkerApiError.name,
        path: "/v1/workers/worker-test/jobs/job-a/source",
        status: 404,
        code: "SOURCE_MISSING",
        message: expect.stringContaining("Source media was not found"),
      }),
    );
  });

  it("explains HTML responses as an API base URL misconfiguration", async () => {
    const api = createWorkerApi(
      config,
      async () =>
        new Response("<!DOCTYPE html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    await expect(api.register()).rejects.toThrow(
      "RVS_API_BASE_URL points to the API server",
    );
  });

  it("explains network failures with the worker API path", async () => {
    const api = createWorkerApi(config, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(api.register()).rejects.toThrow(
      "worker API fetch failed for /v1/workers/register",
    );
  });

  it("times out stalled worker API requests", async () => {
    const api = createWorkerApi(
      { ...config, apiRequestTimeoutMs: 1 },
      async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing abort signal");
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("request aborted"),
              ),
            { once: true },
          );
        });
      },
    );

    await expect(api.register()).rejects.toThrow("request timed out after 1ms");
  });

  it("times out stalled worker API response bodies", async () => {
    const api = createWorkerApi(
      { ...config, apiRequestTimeoutMs: 1 },
      async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing abort signal");
        const body = new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () =>
                controller.error(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("request aborted"),
                ),
              { once: true },
            );
          },
        });
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      },
    );

    await expect(api.register()).rejects.toThrow("request timed out after 1ms");
  });

  it("reports completed jobs after a successful handler", async () => {
    const calls: string[] = [];
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const api = {
      register: async () => {
        calls.push("register");
      },
      heartbeat: async () => {
        calls.push("heartbeat");
      },
      claim: async () => {
        calls.push("claim");
        return {
          jobId: "job-a",
          attemptId: "attempt-a",
          leaseToken: "lease-token",
          leaseExpiresAt: "2026-08-23T01:00:00.000Z",
          payload: {},
        };
      },
      complete: async (jobId: string) => {
        calls.push(`complete:${jobId}`);
      },
      fail: async () => {
        calls.push("fail");
      },
      acknowledgeCancellation: async () => {},
    };
    const controller = new AbortController();
    let logLines: string[] = [];
    try {
      await runWorkerDaemon(
        { ...config, heartbeatIntervalMs: 1_000, pollIntervalMs: 1_000 },
        api,
        controller.signal,
        async () => {
          controller.abort();
          return { ok: true };
        },
      );
      logLines = infoSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      infoSpy.mockRestore();
    }
    expect(calls).toEqual(["register", "heartbeat", "claim", "complete:job-a"]);
    expect(logLines).toEqual([
      expect.stringContaining('"event":"worker.job.claimed"'),
      expect.stringContaining('"event":"worker.job.completing"'),
      expect.stringContaining('"event":"worker.job.completed"'),
    ]);
  });

  it("heartbeats during a claimed job and prevents stale completion when one fails", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const api = {
      register: async () => {},
      heartbeat: vi.fn(async () => {
        calls.push("heartbeat");
        if (calls.length === 2)
          throw new Error("heartbeat failed: secret-token");
      }),
      claim: vi.fn(async () => ({
        jobId: "job-a",
        attemptId: "attempt-a",
        leaseToken: "lease-token",
        leaseExpiresAt: "2026-08-23T01:00:00.000Z",
        payload: {},
      })),
      complete: async () => {
        calls.push("complete");
      },
      fail: async () => {
        calls.push("fail");
      },
      acknowledgeCancellation: async () => {
        calls.push("cancelled");
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const run = runWorkerDaemon(
      { ...config, heartbeatIntervalMs: 10 },
      api,
      controller.signal,
      async (_job, signal) =>
        await new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ ok: true }), {
            once: true,
          }),
        ),
    );
    await vi.waitFor(() => expect(api.claim).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await run;

    expect(calls).toEqual(["heartbeat", "heartbeat"]);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      '"event":"worker.job.heartbeat_failed"',
    );
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      '"errorCause":"heartbeat failed: [redacted]"',
    );
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain("secret-token");
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("combines outer cancellation with the claimed-job signal", async () => {
    // Given
    const calls: string[] = [];
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedReason: unknown = null;
    const api = {
      register: async () => {},
      heartbeat: async () => {},
      claim: async () => ({
        jobId: "job-a",
        attemptId: "attempt-a",
        leaseToken: "lease-token",
        leaseExpiresAt: "2026-08-23T01:00:00.000Z",
        payload: {},
      }),
      complete: async () => {
        calls.push("complete");
      },
      fail: async () => {
        calls.push("fail");
      },
      acknowledgeCancellation: async () => {
        calls.push("cancelled");
      },
    };
    const controller = new AbortController();
    const run = runWorkerDaemon(
      config,
      api,
      controller.signal,
      async (_job, signal) => {
        resolveStarted();
        return await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedReason = signal.reason;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    );
    await started;
    const reason = new Error("outer cancellation");

    // When
    controller.abort(reason);
    await run;

    // Then
    expect(observedReason).toBe(reason);
    expect(calls).toEqual([]);
  });

  it("logs claimed jobs before running the handler", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const api = {
      register: async () => {},
      heartbeat: async () => {},
      claim: async () => ({
        jobId: "job-a",
        attemptId: "attempt-a",
        leaseToken: "lease-token",
        leaseExpiresAt: "2026-08-23T01:00:00.000Z",
        payload: {
          tenantId: "tenant-a",
          phase: "render",
          deletionEpoch: 2,
          restoreEpoch: 3,
        },
      }),
      complete: async () => {},
      fail: async () => {},
      acknowledgeCancellation: async () => {},
    };
    const controller = new AbortController();
    let logLine = "";
    try {
      await runWorkerDaemon(config, api, controller.signal, async () => {
        controller.abort();
        return { ok: true };
      });
      logLine = String(infoSpy.mock.calls[0]?.[0]);
    } finally {
      infoSpy.mockRestore();
    }
    expect(logLine).toContain('"event":"worker.job.claimed"');
    expect(logLine).toContain('"workerId":"worker-test"');
    expect(logLine).toContain('"jobId":"job-a"');
    expect(logLine).toContain('"attemptId":"attempt-a"');
    expect(logLine).toContain('"tenantId":"tenant-a"');
    expect(logLine).toContain('"phase":"render"');
    expect(logLine).toContain('"deletionEpoch":2');
    expect(logLine).toContain('"restoreEpoch":3');
  });

  it("reports deterministic handler error codes", async () => {
    const failures: string[] = [];
    const controller = new AbortController();
    const api = {
      register: async () => {},
      heartbeat: async () => {},
      claim: async () => ({
        jobId: "job-a",
        attemptId: "attempt-a",
        leaseToken: "lease-token",
        leaseExpiresAt: "2026-08-23T01:00:00.000Z",
        payload: {},
      }),
      complete: async () => {},
      fail: async (_jobId: string, message: string) => {
        failures.push(message);
        controller.abort();
      },
      acknowledgeCancellation: async () => {},
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runWorkerDaemon(config, api, controller.signal, async () => {
        throw new Error("IR_VERSION_MISMATCH");
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(failures).toEqual(["IR_VERSION_MISMATCH"]);
  });

  it("reports a stable failure without exposing handler errors", async () => {
    const failures: string[] = [];
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = {
      register: async () => {},
      heartbeat: async () => {},
      claim: async () => ({
        jobId: "job-a",
        attemptId: "attempt-a",
        leaseToken: "lease-token",
        leaseExpiresAt: "2026-08-23T01:00:00.000Z",
        payload: {},
      }),
      complete: async () => {},
      fail: async (_jobId: string, message: string) => {
        failures.push(message);
        controller.abort();
      },
      acknowledgeCancellation: async () => {},
    };
    const controller = new AbortController();
    let logLine = "";
    try {
      await runWorkerDaemon(config, api, controller.signal, async () => {
        throw new Error("secret-token");
      });
      logLine = String(errorSpy.mock.calls[0]?.[0]);
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(failures).toEqual([WORKER_JOB_HANDLER_FAILED]);
    expect(failures.join()).not.toContain("secret-token");
    expect(logLine).toContain('"event":"worker.job.failed"');
    expect(logLine).toContain('"workerId":"worker-test"');
    expect(logLine).toContain('"attemptId":"attempt-a"');
    expect(logLine).toContain(WORKER_JOB_HANDLER_FAILED);
    expect(logLine).toContain("[redacted]");
    expect(logLine).not.toContain("secret-token");
  });

  it("acknowledges API cancellation instead of reporting a failed job", async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const api = createWorkerApi(config, async (input) => {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (path.endsWith("/claim"))
        return Response.json({
          job: {
            jobId: "job-a",
            attemptId: "attempt-a",
            leaseToken: "lease-token",
            leaseExpiresAt: "2026-08-23T01:00:00.000Z",
            payload: {},
          },
        });
      if (path.endsWith("/progress"))
        return Response.json(
          {
            error: {
              code: "CANCEL_REQUESTED",
              message: "The request could not be completed.",
            },
          },
          { status: 409 },
        );
      if (path.endsWith("/cancelled")) {
        controller.abort();
        return Response.json({ ok: true });
      }
      return Response.json(
        path.endsWith("/register")
          ? { workerId: "worker-test", sessionToken: "session-token" }
          : { workerId: "worker-test" },
      );
    });
    let logLines: string[] = [];
    try {
      await runWorkerDaemon(config, api, controller.signal, async (job) => {
        await api.reportProgress(
          job.jobId,
          {
            phase: "prepare",
            stage: "evidence",
            fraction: 0.5,
            framesProcessed: 60,
            framesTotal: 120,
          },
          controller.signal,
        );
      });
      logLines = infoSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      infoSpy.mockRestore();
    }

    expect(paths).toEqual([
      "/v1/workers/register",
      "/v1/workers/worker-test/heartbeat",
      "/v1/workers/worker-test/claim",
      "/v1/workers/worker-test/jobs/job-a/progress",
      "/v1/workers/worker-test/jobs/job-a/cancelled",
    ]);
    expect(logLines).toEqual([
      expect.stringContaining('"event":"worker.job.claimed"'),
      expect.stringContaining('"event":"worker.job.cancelling"'),
      expect.stringContaining('"event":"worker.job.cancelled"'),
    ]);
  });

  it("acknowledges cancellation when daemon shutdown races the handler error", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const api = {
      register: async () => {},
      heartbeat: async () => {},
      claim: async () => ({
        jobId: "job-a",
        attemptId: "attempt-a",
        leaseToken: "lease-token",
        leaseExpiresAt: "2026-08-23T01:00:00.000Z",
        payload: {},
      }),
      complete: async () => calls.push("complete"),
      fail: async () => calls.push("fail"),
      acknowledgeCancellation: async () => calls.push("cancelled"),
    };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runWorkerDaemon(config, api, controller.signal, async () => {
        controller.abort();
        throw new WorkerApiError(
          "/progress",
          409,
          "cancellation requested",
          "CANCEL_REQUESTED",
        );
      });
    } finally {
      infoSpy.mockRestore();
    }

    expect(calls).toEqual(["cancelled"]);
  });

  it("stops polling when its signal is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const api = createWorkerApi(config, async (input) => {
      calls += 1;
      if (calls === 2) controller.abort();
      return new Response(
        new URL(input.toString()).pathname.endsWith("/claim")
          ? JSON.stringify({ job: null })
          : JSON.stringify(
              calls === 1
                ? { workerId: "worker-test", sessionToken: "session-token" }
                : { workerId: "worker-test" },
            ),
        { headers: { "content-type": "application/json" } },
      );
    });
    await runWorkerDaemon(
      config,
      api,
      controller.signal,
      async () => undefined,
    );
    expect(calls).toBe(2);
  });
});
