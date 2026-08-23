import { z } from "zod"

export const JobStates = ["PREPARING", "READY", "QUEUED", "RENDERING", "ASSEMBLING", "AWAITING_T5", "COMPLETED", "STALE_APPROVAL", "CANCEL_REQUESTED", "CANCELLED", "RETRYABLE_ERROR", "FAILED"] as const
export type JobState = (typeof JobStates)[number]
export const RetryClasses = ["TRANSIENT_WORKER", "TRANSIENT_UPLOAD", "VALIDATION", "STALE_APPROVAL", "NON_RETRYABLE"] as const
export type RetryClass = (typeof RetryClasses)[number]
const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  PREPARING: ["READY", "CANCEL_REQUESTED", "FAILED"], READY: ["QUEUED", "STALE_APPROVAL", "FAILED"], STALE_APPROVAL: ["READY", "FAILED"], QUEUED: ["RENDERING", "CANCEL_REQUESTED", "FAILED"], RENDERING: ["ASSEMBLING", "CANCEL_REQUESTED", "RETRYABLE_ERROR", "FAILED"], ASSEMBLING: ["AWAITING_T5", "RETRYABLE_ERROR", "FAILED"], AWAITING_T5: ["COMPLETED", "FAILED", "STALE_APPROVAL"], CANCEL_REQUESTED: ["CANCELLED", "FAILED"], RETRYABLE_ERROR: ["PREPARING", "QUEUED", "FAILED"], COMPLETED: [], CANCELLED: [], FAILED: [],
}
export function assertLegalTransition(from: JobState, to: JobState): void {
  if (!transitions[from].includes(to)) throw new Error("INVALID_JOB_TRANSITION")
}
export const ProgressSchema = z.object({ approvedGateCount: z.number().int().nonnegative(), requiredGateCount: z.number().int().positive(), framesRendered: z.number().int().nonnegative(), framesTotal: z.number().int().positive(), phase: z.enum(["PREPARING", "RENDERING", "ASSEMBLING"]).optional() }).refine((value) => value.approvedGateCount <= value.requiredGateCount && value.framesRendered <= value.framesTotal)
