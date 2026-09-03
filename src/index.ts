import { fileURLToPath } from "node:url";
import { createMaterialProvider } from "./material-provider.js";
import { createSelfHosted3DMaterialProvider } from "./self-hosted-3d-material-provider.js";
import { createSelfHostedVideoMaterialProvider } from "./self-hosted-video-material-provider.js";
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
  return {
    api,
    handleJob: createWorkflowJobHandler({
      api,
      // Image: API (vendor key, only outbound network). Object-form image:
      // Hi3DGen+Blender. Video: self-hosted wan-alpha. Unset endpoints refuse
      // that kind by name. Console payload first, env as host pin / fallback.
      materialProviderFactory: (jobId, endpoints) =>
        createMaterialProvider({
          requestImage: (request, signal) =>
            api.requestMaterial(jobId, request, signal),
          object: createSelfHosted3DMaterialProvider({
            baseUrl: endpoints.model3d ?? config.hi3dgenBaseUrl,
            ...(config.blenderCapability !== undefined
              ? { capability: config.blenderCapability }
              : {}),
          }),
          video: createSelfHostedVideoMaterialProvider({
            baseUrl: endpoints.video ?? config.wanAlphaBaseUrl,
          }),
        }),
    }),
  };
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
