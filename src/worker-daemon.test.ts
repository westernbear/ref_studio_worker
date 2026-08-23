import { describe, expect, it } from "vitest";
import { createWorkerApi } from "./worker-api.js";
import {
  runWorkerDaemon,
  WORKER_JOB_HANDLER_FAILED,
  WORKER_JOB_HANDLER_NOT_IMPLEMENTED,
} from "./worker-daemon.js";
import type { WorkerConfig } from "./worker-config.js";

const config: WorkerConfig = {
  apiBaseUrl: "https://api.example.test",
  token: "secret-token",
  workerId: "worker-test",
  capabilities: ["compiler"],
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 10_000,
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

  it("reports completed jobs after a successful handler", async () => {
    const calls: string[] = [];
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
    };
    const controller = new AbortController();
    await runWorkerDaemon(
      { ...config, heartbeatIntervalMs: 1_000, pollIntervalMs: 1_000 },
      api,
      controller.signal,
      async () => {
        controller.abort();
        return { ok: true };
      },
    );
    expect(calls).toEqual(["register", "heartbeat", "claim", "complete:job-a"]);
  });

  it("reports not implemented for the default handler", async () => {
    const failures: string[] = [];
    const controller = new AbortController();
    const api = {
      register: async () => {},
      heartbeat: async () => {},
      claim: async () => {
        controller.abort();
        return { jobId: "job-a", attemptId: "attempt-a", payload: {} };
      },
      complete: async () => {},
      fail: async (_jobId: string, message: string) => {
        failures.push(message);
      },
    };
    await runWorkerDaemon(config, api, controller.signal);
    expect(failures).toEqual([WORKER_JOB_HANDLER_NOT_IMPLEMENTED]);
  });

  it("reports a stable failure without exposing handler errors", async () => {
    const failures: string[] = [];
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
    };
    const controller = new AbortController();
    await runWorkerDaemon(config, api, controller.signal, async () => {
      controller.abort();
      throw new Error("secret-token");
    });
    expect(failures).toEqual([WORKER_JOB_HANDLER_FAILED]);
    expect(failures.join()).not.toContain("secret-token");
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
    await runWorkerDaemon(config, api, controller.signal);
    expect(calls).toBe(2);
  });
});
