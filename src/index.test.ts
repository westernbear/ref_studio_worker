import { describe, expect, it } from "vitest";
import { createWorkerRuntime } from "./index.js";
import type { WorkerConfig } from "./worker-config.js";

const config: WorkerConfig = {
  apiBaseUrl: "https://api.example.test",
  token: "secret-token",
  workerId: "worker-test",
  capabilities: ["compiler"],
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 10_000,
};

describe("worker entrypoint", () => {
  it("uses a real handler for claimed workflow jobs instead of the default not implemented handler", async () => {
    const { handleJob } = createWorkerRuntime(config);
    await expect(
      handleJob(
        {
          jobId: "job-a",
          attemptId: "attempt-a",
          payload: {
            tenantId: "ten_a",
            uploadId: "upl_a",
            frameCount: 120,
            phase: "prepare",
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      jobId: "job-a",
      attemptId: "attempt-a",
      tenantId: "ten_a",
      uploadId: "upl_a",
      frameCount: 120,
      phase: "prepare",
    });
  });
});
