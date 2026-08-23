import os from "node:os"
import { z } from "zod"

const EnvSchema = z.object({
  RVS_API_BASE_URL: z.string().url(),
  RVS_WORKER_TOKEN: z.string().min(1),
  RVS_WORKER_ID: z.string().min(1).optional(),
  RVS_WORKER_CAPABILITIES: z.string().min(1).default("compiler,renderer"),
  RVS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  RVS_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
})

export type WorkerConfig = Readonly<{ apiBaseUrl: string; token: string; workerId: string; capabilities: readonly string[]; heartbeatIntervalMs: number; pollIntervalMs: number }>

export function parseWorkerConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const parsed = EnvSchema.parse(env)
  const capabilities = parsed.RVS_WORKER_CAPABILITIES.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
  if (capabilities.length === 0) throw new Error("RVS_WORKER_CAPABILITIES must contain a capability")
  return { apiBaseUrl: parsed.RVS_API_BASE_URL.replace(/\/$/, ""), token: parsed.RVS_WORKER_TOKEN, workerId: parsed.RVS_WORKER_ID ?? `worker-${os.hostname()}`, capabilities, heartbeatIntervalMs: parsed.RVS_HEARTBEAT_INTERVAL_MS, pollIntervalMs: parsed.RVS_POLL_INTERVAL_MS }
}
