import {
  WorkerApiError,
  type WorkerApi,
  type WorkerJob,
} from "./worker-api.js";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkerConfig } from "./worker-config.js";

export type WorkerJobHandler = (
  job: WorkerJob,
  signal: AbortSignal,
) => Promise<unknown>;
type WorkerDaemonApi = Pick<
  WorkerApi,
  | "register"
  | "heartbeat"
  | "claim"
  | "complete"
  | "fail"
  | "acknowledgeCancellation"
>;
export const WORKER_JOB_HANDLER_FAILED = "WORKER_JOB_HANDLER_FAILED";
type WorkerFailureLog = Readonly<{
  event: "worker.job.failed";
  workerId: string;
  jobId: string;
  attemptId: string;
  failure: typeof WORKER_JOB_HANDLER_FAILED;
  errorName: string;
  errorMessage: string;
  errorStack: string | null;
}>;
type WorkerClaimedLog = Readonly<{
  event:
    | "worker.job.claimed"
    | "worker.job.completing"
    | "worker.job.completed"
    | "worker.job.cancelling"
    | "worker.job.cancelled";
  workerId: string;
  jobId: string;
  attemptId: string;
}>;

const wait = async (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
};

const redactSensitive = (value: string, token: string): string => {
  const withoutToken =
    token.length === 0 ? value : value.replaceAll(token, "[redacted]");
  return withoutToken
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(password|secret|token)=\S+/giu, "$1=[redacted]");
};

const describeError = (
  error: unknown,
  token: string,
): Pick<WorkerFailureLog, "errorName" | "errorMessage" | "errorStack"> => {
  if (error instanceof Error)
    return {
      errorName: error.name,
      errorMessage: redactSensitive(error.message, token),
      errorStack:
        error.stack === undefined ? null : redactSensitive(error.stack, token),
    };
  return {
    errorName: "NonError",
    errorMessage: redactSensitive(String(error), token),
    errorStack: null,
  };
};

const logWorkerJobFailure = (
  config: WorkerConfig,
  job: WorkerJob,
  error: unknown,
): void => {
  console.error(
    JSON.stringify({
      event: "worker.job.failed",
      workerId: config.workerId,
      jobId: job.jobId,
      attemptId: job.attemptId,
      failure: WORKER_JOB_HANDLER_FAILED,
      ...describeError(error, config.token),
    } satisfies WorkerFailureLog),
  );
};

const logWorkerJobInfo = (
  event: WorkerClaimedLog["event"],
  config: WorkerConfig,
  job: WorkerJob,
): void => {
  console.info(
    JSON.stringify({
      event,
      workerId: config.workerId,
      jobId: job.jobId,
      attemptId: job.attemptId,
    } satisfies WorkerClaimedLog),
  );
};

export async function runWorkerDaemon(
  config: WorkerConfig,
  api: WorkerDaemonApi,
  signal: AbortSignal,
  handleJob: WorkerJobHandler,
): Promise<void> {
  await api.register();
  while (!signal.aborted) {
    await api.heartbeat();
    if (signal.aborted) break;
    const job = await api.claim();
    if (job) {
      logWorkerJobInfo("worker.job.claimed", config, job);
      try {
        const result = await handleJob(job, signal);
        logWorkerJobInfo("worker.job.completing", config, job);
        await api.complete(job.jobId, result);
        logWorkerJobInfo("worker.job.completed", config, job);
      } catch (error) {
        if (
          (error instanceof WorkerApiError &&
            error.code === "CANCEL_REQUESTED") ||
          (error instanceof Error && error.message === "WORKER_JOB_CANCELLED")
        ) {
          logWorkerJobInfo("worker.job.cancelling", config, job);
          await api.acknowledgeCancellation(job.jobId);
          logWorkerJobInfo("worker.job.cancelled", config, job);
          continue;
        }
        logWorkerJobFailure(config, job, error);
        await api.fail(job.jobId, WORKER_JOB_HANDLER_FAILED);
      }
    }
    await wait(
      Math.min(config.heartbeatIntervalMs, config.pollIntervalMs),
      signal,
    );
  }
}
