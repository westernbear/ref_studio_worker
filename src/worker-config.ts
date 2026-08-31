import os from "node:os";
import { z } from "zod";
import {
  parseBlenderCapabilityEnv,
  type BlenderCapabilitySnapshot,
} from "./blender-capability.js";

const EnvSchema = z.object({
  RVS_API_BASE_URL: z.string().url(),
  RVS_WORKER_TOKEN: z.string().min(1),
  RVS_WORKER_ID: z.string().min(1).optional(),
  RVS_WORKER_CAPABILITIES: z.string().min(1).default("compiler,renderer"),
  RVS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  RVS_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
  RVS_API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  RVS_MEDIA_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(1_800_000),
  // Self-hosted material-generation services, reachable only on
  // worker-internal (see docker-compose.yml) -- unlike the image provider,
  // which has no worker-side base URL at all because it goes through the
  // API relay. Both are optional: a deployment that never sets them keeps
  // getting MATERIAL_PROVIDER_NOT_CONFIGURED for that kind, exactly as
  // before self-hosted-*-material-provider.ts existed.
  RVS_WAN_ALPHA_BASE_URL: z.string().url().optional(),
  RVS_HI3DGEN_BASE_URL: z.string().url().optional(),
  RVS_BLENDER_CAPABILITY_JSON: z.string().optional(),
});

export type WorkerConfig = Readonly<{
  apiBaseUrl: string;
  token: string;
  workerId: string;
  capabilities: readonly string[];
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  apiRequestTimeoutMs: number;
  mediaRequestTimeoutMs: number;
  wanAlphaBaseUrl?: string;
  hi3dgenBaseUrl?: string;
  blenderCapability?: BlenderCapabilitySnapshot;
}>;

export function parseWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkerConfig {
  const parsed = EnvSchema.parse(env);
  const capabilities = parsed.RVS_WORKER_CAPABILITIES.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (capabilities.length === 0)
    throw new Error("RVS_WORKER_CAPABILITIES must contain a capability");
  return {
    apiBaseUrl: parsed.RVS_API_BASE_URL.replace(/\/$/, ""),
    token: parsed.RVS_WORKER_TOKEN,
    workerId: parsed.RVS_WORKER_ID ?? `worker-${os.hostname()}`,
    capabilities,
    heartbeatIntervalMs: parsed.RVS_HEARTBEAT_INTERVAL_MS,
    pollIntervalMs: parsed.RVS_POLL_INTERVAL_MS,
    apiRequestTimeoutMs: parsed.RVS_API_REQUEST_TIMEOUT_MS,
    mediaRequestTimeoutMs: parsed.RVS_MEDIA_REQUEST_TIMEOUT_MS,
    ...(parsed.RVS_WAN_ALPHA_BASE_URL !== undefined
      ? { wanAlphaBaseUrl: parsed.RVS_WAN_ALPHA_BASE_URL }
      : {}),
    ...(parsed.RVS_HI3DGEN_BASE_URL !== undefined
      ? { hi3dgenBaseUrl: parsed.RVS_HI3DGEN_BASE_URL }
      : {}),
    ...(parsed.RVS_BLENDER_CAPABILITY_JSON !== undefined
      ? {
          blenderCapability: parseBlenderCapabilityEnv(
            parsed.RVS_BLENDER_CAPABILITY_JSON,
          ),
        }
      : {}),
  };
}
