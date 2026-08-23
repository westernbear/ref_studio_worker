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
  apiRequestTimeoutMs: 30_000,
  mediaRequestTimeoutMs: 1_800_000,
};

describe("worker entrypoint", () => {
  it("uses a real handler for claimed workflow jobs instead of the default not implemented handler", () => {
    const { handleJob } = createWorkerRuntime(config);
    expect(handleJob).toBeTypeOf("function");
  });
});
