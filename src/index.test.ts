import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createWorkerRuntime } from "./index.js";
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
});
