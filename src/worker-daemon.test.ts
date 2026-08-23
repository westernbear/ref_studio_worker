import { describe, expect, it, vi } from "vitest";
import { createWorkerApi } from "./worker-api.js";
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
          : JSON.stringify({ workerId: "worker-test" }),
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
    expect(await requests[0]?.text()).not.toContain("secret-token");
  });

  it("downloads source bytes, reports progress, and uploads rendered media", async () => {
    const requests: Request[] = [];
    const api = createWorkerApi(config, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/source"))
        return new Response(Uint8Array.from([1, 2, 3]), {
          headers: { "content-type": "video/mp4" },
        });
      if (path.endsWith("artifact"))
        return Response.json({
          artifactId: "artifact-a",
          sha256: "a".repeat(64),
          sizeBytes: 3,
        });
      return Response.json({ ok: true });
    });
    const signal = new AbortController().signal;

    await expect(api.downloadSource("job-a", signal)).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    );
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
      api.uploadArtifact("job-a", Uint8Array.from([4, 5, 6]), signal),
    ).resolves.toMatchObject({ artifactId: "artifact-a", sizeBytes: 3 });
    await expect(
      api.uploadPreview("job-a", Uint8Array.from([7, 8, 9]), signal),
    ).resolves.toMatchObject({ artifactId: "artifact-a", sizeBytes: 3 });

    expect(
      requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual([
      "GET /v1/workers/worker-test/jobs/job-a/source",
      "POST /v1/workers/worker-test/jobs/job-a/progress",
      "POST /v1/workers/worker-test/jobs/job-a/artifact",
      "POST /v1/workers/worker-test/jobs/job-a/preview-artifact",
    ]);
    expect(requests[2]?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await requests[2]!.arrayBuffer())).toEqual(
      Uint8Array.from([4, 5, 6]),
    );
    expect(new Uint8Array(await requests[3]!.arrayBuffer())).toEqual(
      Uint8Array.from([7, 8, 9]),
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

    await expect(api.complete("job-a", {})).rejects.toThrow(
      "request timed out after 1ms",
    );
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
        return { jobId: "job-a", attemptId: "attempt-a", payload: {} };
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

  it("logs claimed jobs before running the handler", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const api = {
      register: async () => {},
      heartbeat: async () => {},
      claim: async () => ({
        jobId: "job-a",
        attemptId: "attempt-a",
        payload: {},
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
        payload: {},
      }),
      complete: async () => {},
      fail: async (_jobId: string, message: string) => {
        failures.push(message);
      },
      acknowledgeCancellation: async () => {},
    };
    const controller = new AbortController();
    let logLine = "";
    try {
      await runWorkerDaemon(config, api, controller.signal, async () => {
        controller.abort();
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
          job: { jobId: "job-a", attemptId: "attempt-a", payload: {} },
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
      return Response.json({ workerId: "worker-test" });
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

  it("stops polling when its signal is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const api = createWorkerApi(config, async (input) => {
      calls += 1;
      if (calls === 2) controller.abort();
      return new Response(
        new URL(input.toString()).pathname.endsWith("/claim")
          ? JSON.stringify({ job: null })
          : JSON.stringify({ workerId: "worker-test" }),
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
