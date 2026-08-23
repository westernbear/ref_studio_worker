import type { WorkerApi, WorkerJob } from "./worker-api.js"
import type { WorkerConfig } from "./worker-config.js"

export type WorkerJobHandler = (job: WorkerJob, signal: AbortSignal) => Promise<unknown>
export const WORKER_JOB_HANDLER_NOT_IMPLEMENTED = "WORKER_JOB_HANDLER_NOT_IMPLEMENTED"
export const WORKER_JOB_HANDLER_FAILED = "WORKER_JOB_HANDLER_FAILED"
type WorkerFailure = typeof WORKER_JOB_HANDLER_NOT_IMPLEMENTED | typeof WORKER_JOB_HANDLER_FAILED
type WorkerFailureLog = Readonly<{
  event: "worker.job.failed"
  workerId: string
  jobId: string
  attemptId: string
  failure: WorkerFailure
  errorName: string
  errorMessage: string
  errorStack: string | null
}>

export const unimplementedWorkerJobHandler: WorkerJobHandler = async () => { throw new Error(WORKER_JOB_HANDLER_NOT_IMPLEMENTED) }

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return }
  const timer = setTimeout(resolve, milliseconds)
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
})

const redactSensitive = (value: string, token: string): string => {
  const withoutToken = token.length === 0 ? value : value.replaceAll(token, "[redacted]")
  return withoutToken
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(password|secret|token)=\S+/giu, "$1=[redacted]")
}

const describeError = (error: unknown, token: string): Pick<WorkerFailureLog, "errorName" | "errorMessage" | "errorStack"> => {
  if (error instanceof Error) return {
    errorName: error.name,
    errorMessage: redactSensitive(error.message, token),
    errorStack: error.stack === undefined ? null : redactSensitive(error.stack, token),
  }
  return {
    errorName: "NonError",
    errorMessage: redactSensitive(String(error), token),
    errorStack: null,
  }
}

const logWorkerJobFailure = (config: WorkerConfig, job: WorkerJob, failure: WorkerFailure, error: unknown): void => {
  console.error(JSON.stringify({
    event: "worker.job.failed",
    workerId: config.workerId,
    jobId: job.jobId,
    attemptId: job.attemptId,
    failure,
    ...describeError(error, config.token),
  } satisfies WorkerFailureLog))
}

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
        logWorkerJobFailure(config, job, failure, error)
        await api.fail(job.jobId, failure)
      }
    }
    await wait(Math.min(config.heartbeatIntervalMs, config.pollIntervalMs), signal)
  }
}
