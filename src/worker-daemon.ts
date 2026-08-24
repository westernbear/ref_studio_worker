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
  failure: string;
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
  tenantId: string | null;
  phase: string | null;
  deletionEpoch: number | null;
  restoreEpoch: number | null;
}>;
type WorkerHeartbeatFailureLog = WorkerClaimedLog &
  Readonly<{ errorCause: string }>;
type WorkerLogContext = Pick<
  WorkerClaimedLog,
  "tenantId" | "phase" | "deletionEpoch" | "restoreEpoch"
>;

const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
const CANCELLATION_CODES = new Set([
  "CANCEL_REQUESTED",
  "COMPILER_CANCELLED",
  "WORKER_JOB_CANCELLED",
]);

const jobLogContext = (job: WorkerJob): WorkerLogContext => {
  const tenantId = job.payload["tenantId"];
  const phase = job.payload["phase"];
  const deletionEpoch = job.payload["deletionEpoch"];
  const restoreEpoch = job.payload["restoreEpoch"];
  return {
    tenantId: typeof tenantId === "string" ? tenantId : null,
    phase: typeof phase === "string" ? phase : null,
    deletionEpoch:
      typeof deletionEpoch === "number" && Number.isSafeInteger(deletionEpoch)
        ? deletionEpoch
        : null,
    restoreEpoch:
      typeof restoreEpoch === "number" && Number.isSafeInteger(restoreEpoch)
        ? restoreEpoch
        : null,
  };
};

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
  const jobSignal = AbortSignal.any([signal, controller.signal]);
  const heartbeat = async (): Promise<void> => {
    while (!jobSignal.aborted) {
      await wait(config.heartbeatIntervalMs, jobSignal);
      if (!jobSignal.aborted) await api.heartbeat();
    }
  };
  const heartbeatTask = heartbeat();
  const handlerTask = handleJob(job, jobSignal);
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
          ...jobLogContext(job),
          errorCause: describeError(outcome.error, config.token).errorMessage,
        } satisfies WorkerHeartbeatFailureLog),
      );
      return false;
    }
    if (outcome.kind === "heartbeat-stopped") {
      controller.abort();
      await handlerTask;
      return false;
    }
    logWorkerJobInfo("worker.job.completing", config, job);
    await api.complete(job.jobId, outcome.result);
    logWorkerJobInfo("worker.job.completed", config, job);
    return true;
  } finally {
    controller.abort();
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

const errorCodeFrom = (error: unknown): string | null => {
  if (error instanceof WorkerApiError) return error.code;
  if (!(error instanceof Error)) return null;
  const separator = error.message.indexOf(":");
  return separator === -1 ? error.message : error.message.slice(0, separator);
};

const logWorkerJobFailure = (
  config: WorkerConfig,
  job: WorkerJob,
  error: unknown,
): string => {
  const candidate = errorCodeFrom(error);
  const failure =
    candidate !== null && ERROR_CODE.test(candidate)
      ? candidate
      : WORKER_JOB_HANDLER_FAILED;
  console.error(
    JSON.stringify({
      event: "worker.job.failed",
      workerId: config.workerId,
      jobId: job.jobId,
      attemptId: job.attemptId,
      failure,
      ...jobLogContext(job),
      ...describeError(error, config.token),
    } satisfies WorkerFailureLog),
  );
  return failure;
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
      ...jobLogContext(job),
    } satisfies WorkerClaimedLog),
  );
};

const isCancellation = (error: unknown): boolean => {
  const code = errorCodeFrom(error);
  return code !== null && CANCELLATION_CODES.has(code);
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
        if (
          (error instanceof WorkerApiError &&
            error.code === "CANCEL_REQUESTED") ||
          (!signal.aborted && isCancellation(error))
        ) {
          logWorkerJobInfo("worker.job.cancelling", config, job);
          await api.acknowledgeCancellation(job.jobId);
          logWorkerJobInfo("worker.job.cancelled", config, job);
          continue;
        }
        if (signal.aborted) break;
        await api.fail(job.jobId, logWorkerJobFailure(config, job, error));
      }
    }
    await wait(
      Math.min(config.heartbeatIntervalMs, config.pollIntervalMs),
      signal,
    );
  }
}
