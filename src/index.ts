import { fileURLToPath } from "node:url";
import { restrictToKind } from "./material-provider.js";
import { createRemoteImageMaterialProvider } from "./remote-image-material-provider.js";
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
      // Image goes out to the API (which holds the vendor key and the only
      // outbound network); video is served by a self-hosted service on
      // worker-internal. Anything else -- `font` today -- still fails
      // closed through the innermost fallback.
      //
      // The Hi3DGen provider is deliberately absent: it returns a PNG for
      // an `image` request, so wiring it here would have it fight the
      // remote image provider for every generated image. A scene has no
      // way to say "this asset is a rendered 3D object" yet, and inventing
      // one is a schema decision, not a wiring decision.
      materialProviderFactory: (jobId) =>
        restrictToKind(
          "image",
          createRemoteImageMaterialProvider(api, jobId),
          restrictToKind(
            "video",
            createSelfHostedVideoMaterialProvider({
              baseUrl: config.wanAlphaBaseUrl,
            }),
          ),
        ),
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
