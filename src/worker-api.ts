import { z } from "zod"
import type { WorkerConfig } from "./worker-config.js"

const RegisterResponse = z.object({ workerId: z.string().min(1) })
const Job = z.object({ jobId: z.string().min(1), attemptId: z.string().min(1), payload: z.record(z.string(), z.unknown()).default({}) })
const ClaimResponse = z.object({ job: Job.nullable() })
export type WorkerJob = z.infer<typeof Job>
export type WorkerApi = Readonly<{ register(): Promise<void>; heartbeat(): Promise<void>; claim(): Promise<WorkerJob | null>; complete(jobId: string, result: unknown): Promise<void>; fail(jobId: string, message: string): Promise<void> }>
type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export function createWorkerApi(config: WorkerConfig, fetcher: Fetcher = fetch): WorkerApi {
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await fetcher(`${config.apiBaseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`worker API request failed (${response.status})`)
    return schema.parse(await response.json())
  }
  const prefix = `/v1/workers/${encodeURIComponent(config.workerId)}`
  return {
    register: async () => { await post("/v1/workers/register", { workerId: config.workerId, capabilities: config.capabilities }, RegisterResponse) },
    heartbeat: async () => { await post(`${prefix}/heartbeat`, { capabilities: config.capabilities }, RegisterResponse) },
    claim: async () => (await post(`${prefix}/claim`, {}, ClaimResponse)).job,
    complete: async (jobId, result) => { await post(`${prefix}/jobs/${encodeURIComponent(jobId)}/complete`, { result }, z.object({ ok: z.literal(true) })) },
    fail: async (jobId, message) => { await post(`${prefix}/jobs/${encodeURIComponent(jobId)}/fail`, { message }, z.object({ ok: z.literal(true) })) },
  }
}
