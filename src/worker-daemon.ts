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
    | "worker.job.heartbeat_failed"
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

const runClaimedJob = async (
  config: WorkerConfig,
  api: WorkerDaemonApi,
  signal: AbortSignal,
  job: WorkerJob,
  handleJob: WorkerJobHandler,
): Promise<boolean> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let stopped = false;
  const heartbeat = async (): Promise<void> => {
    while (!stopped && !controller.signal.aborted) {
      await wait(config.heartbeatIntervalMs, controller.signal);
      if (!stopped && !controller.signal.aborted) await api.heartbeat();
    }
  };
  const heartbeatTask = heartbeat();
  const handlerTask = handleJob(job, controller.signal);
  try {
    const outcome = await Promise.race([
      handlerTask.then((result) => ({ kind: "result" as const, result })),
      heartbeatTask.then(
        () => ({ kind: "heartbeat-stopped" as const }),
        (error: unknown) => ({ kind: "heartbeat-failed" as const, error }),
      ),
    ]);
    if (outcome.kind === "heartbeat-failed") {
      controller.abort(outcome.error);
      await handlerTask.catch(() => undefined);
      console.error(
        JSON.stringify({
          event: "worker.job.heartbeat_failed",
          workerId: config.workerId,
          jobId: job.jobId,
          attemptId: job.attemptId,
        } satisfies WorkerClaimedLog),
      );
      return false;
    }
    if (outcome.kind === "heartbeat-stopped") {
      controller.abort();
      await handlerTask.catch(() => undefined);
      return false;
    }
    logWorkerJobInfo("worker.job.completing", config, job);
    await api.complete(job.jobId, outcome.result);
    logWorkerJobInfo("worker.job.completed", config, job);
    return true;
  } finally {
    stopped = true;
    controller.abort();
    signal.removeEventListener("abort", abort);
    await heartbeatTask.catch(() => undefined);
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
        if (!(await runClaimedJob(config, api, signal, job, handleJob))) break;
      } catch (error) {
        if (signal.aborted) break;
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
