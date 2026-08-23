import type { WorkerApi, WorkerJob } from "./worker-api.js"
import type { WorkerConfig } from "./worker-config.js"

export type WorkerJobHandler = (job: WorkerJob, signal: AbortSignal) => Promise<unknown>
export const WORKER_JOB_HANDLER_NOT_IMPLEMENTED = "WORKER_JOB_HANDLER_NOT_IMPLEMENTED"
export const WORKER_JOB_HANDLER_FAILED = "WORKER_JOB_HANDLER_FAILED"

export const unimplementedWorkerJobHandler: WorkerJobHandler = async () => { throw new Error(WORKER_JOB_HANDLER_NOT_IMPLEMENTED) }

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return }
  const timer = setTimeout(resolve, milliseconds)
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
})

export async function runWorkerDaemon(config: WorkerConfig, api: WorkerApi, signal: AbortSignal, handleJob: WorkerJobHandler = unimplementedWorkerJobHandler): Promise<void> {
  await api.register()
  while (!signal.aborted) {
    await api.heartbeat()
    if (signal.aborted) break
    const job = await api.claim()
    if (job) {
      try {
        const result = await handleJob(job, signal)
        await api.complete(job.jobId, result)
      } catch (error) {
        const failure = error instanceof Error && error.message === WORKER_JOB_HANDLER_NOT_IMPLEMENTED ? WORKER_JOB_HANDLER_NOT_IMPLEMENTED : WORKER_JOB_HANDLER_FAILED
        await api.fail(job.jobId, failure)
      }
    }
    await wait(Math.min(config.heartbeatIntervalMs, config.pollIntervalMs), signal)
  }
}
