import { fileURLToPath } from "node:url";
import { restrictToForm, restrictToKind } from "./material-provider.js";
import { createRemoteImageMaterialProvider } from "./remote-image-material-provider.js";
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
      // Image goes out to the API (which holds the vendor key and the only
      // outbound network); video is served by a self-hosted service on
      // worker-internal. Anything else -- `font` today -- still fails
      // closed through the innermost fallback.
      //
      // Two providers answer an `image` request, so kind alone cannot pick
      // between them: the scene's asset `form` does. An object-form asset
      // ("this is a physical thing in space") goes to Hi3DGen+Blender,
      // which generates a mesh and renders one still of it; everything
      // else goes to the 2D image provider, which is every generated image
      // authored before `form` existed. With RVS_HI3DGEN_BASE_URL unset,
      // the 3D provider refuses by name rather than falling through -- a
      // deployment running only the image provider is unaffected, and an
      // object-form scene fails loudly there instead of silently getting a
      // flat picture of what it asked to be an object.
      //
      // Both endpoints come from the job payload, which carries what the
      // admin console has set (material-provider-settings.ts). The
      // environment variables remain as a fallback for a worker talking to
      // an API that predates the setting, and for a deployment that would
      // rather pin them per host -- console first, because that is the one
      // an operator can see and change.
      materialProviderFactory: (jobId, endpoints) =>
        restrictToKind(
          "image",
          restrictToForm(
            "object",
            createSelfHosted3DMaterialProvider({
              baseUrl: endpoints.model3d ?? config.hi3dgenBaseUrl,
            }),
            createRemoteImageMaterialProvider(api, jobId),
          ),
          restrictToKind(
            "video",
            createSelfHostedVideoMaterialProvider({
              baseUrl: endpoints.video ?? config.wanAlphaBaseUrl,
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
