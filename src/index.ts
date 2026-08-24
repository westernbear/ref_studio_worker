import { fileURLToPath } from "node:url";
import { createWorkerApi, type Fetcher } from "./worker-api.js";
import { runWorkerDaemon } from "./worker-daemon.js";
import { parseWorkerConfig } from "./worker-config.js";
import { createWorkflowJobHandler } from "./worker-job-handler.js";
import { runWorkerPreflight } from "./worker-preflight.js";
import type { WorkerConfig } from "./worker-config.js";
import type { WorkerPreflightReport } from "./worker-preflight.js";

export const createWorkerRuntime = (
  config: WorkerConfig,
  preflight?: WorkerPreflightReport,
  fetcher: Fetcher = fetch,
) => {
  const api = createWorkerApi(config, fetcher, preflight);
  return { api, handleJob: createWorkflowJobHandler({ api }) };
};

export const main = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  const config = parseWorkerConfig(env);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const preflight = await runWorkerPreflight(controller.signal);
  console.info(
    JSON.stringify({ event: "worker.preflight.passed", ...preflight }),
  );
  const runtime = createWorkerRuntime(config, preflight);
  await runWorkerDaemon(
    config,
    runtime.api,
    controller.signal,
    runtime.handleJob,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "worker daemon failed",
    );
    process.exitCode = 1;
  }
}
