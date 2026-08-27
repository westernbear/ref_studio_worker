import type { MaterialProvider } from "./material-provider.js";
import type { WorkerApi } from "./worker-api.js";

// The worker's half of the image material seam: it has no outbound
// network and holds no vendor key (see docker-compose.yml's
// worker-internal network), so `generate` is nothing but a call through
// the API relay it already trusts. The API makes the actual OpenAI call
// and returns finished bytes plus provenance; this just carries the
// request there and the answer back, honouring the AbortSignal the same
// way every other worker<->API call does.
//
// `tool` starts as a placeholder and is overwritten by whatever the API
// declares in its response's provenance.tool -- this provider does not
// know, and must not guess, which vendor/model the API is actually
// configured to use. produceMaterial reads `.tool` only after `generate`
// resolves, so the getter always reflects the most recent response by the
// time that check runs.
export function createRemoteImageMaterialProvider(
  api: Pick<WorkerApi, "requestMaterial">,
  jobId: string,
): MaterialProvider {
  let tool = "unset";
  return {
    get tool() {
      return tool;
    },
    generate: async (request, signal) => {
      const material = await api.requestMaterial(jobId, request, signal);
      tool = material.provenance.tool;
      return material;
    },
  };
}
