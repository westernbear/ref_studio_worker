import { assertLegalTransition, type JobState } from "./contracts/lifecycle.js"

export type AttemptProgress = Readonly<{ approvedGateCount: number; requiredGateCount: number; framesRendered: number; framesTotal: number; phase?: "PREPARING" | "RENDERING" | "ASSEMBLING" }>
export type AttemptRecord = { state: JobState; attemptId: string; deletionEpoch: number; restoreEpoch: number; progress: AttemptProgress; error: string | null }
export type OrchestrationOptions = Readonly<{
  attempt: AttemptRecord
  currentDeletionEpoch: () => number
  currentRestoreEpoch: () => number
  leaseValid: () => boolean
  approvedGates: () => number
  compile: (onProgress: (framesRendered: number, framesTotal: number) => void) => Promise<void>
  render: (onProgress: (framesRendered: number, framesTotal: number) => void) => Promise<void>
  assemble: () => Promise<void>
  publishAfterT5: () => Promise<void>
  signal?: AbortSignal
}>

export class OrchestrationError extends Error {
  readonly code: "STALE_APPROVAL" | "STALE_EPOCH" | "LEASE_LOST" | "CANCELLED" | "T5_REJECTED" | "TRANSIENT_WORKER_FAILURE"
  constructor(code: OrchestrationError["code"]) { super(code); this.name = "OrchestrationError"; this.code = code }
}

const transition = (attempt: AttemptRecord, next: JobState): void => { assertLegalTransition(attempt.state, next); attempt.state = next }
const guard = (options: OrchestrationOptions): void => {
  if (!options.leaseValid()) throw new OrchestrationError("LEASE_LOST")
  if (options.currentDeletionEpoch() !== options.attempt.deletionEpoch || options.currentRestoreEpoch() !== options.attempt.restoreEpoch) throw new OrchestrationError("STALE_EPOCH")
}
const cancelRequested = (options: OrchestrationOptions): boolean => options.signal?.aborted === true
const progress = (attempt: AttemptRecord, options: OrchestrationOptions, framesRendered: number, framesTotal: number, phase: AttemptProgress["phase"]): void => {
  attempt.progress = { approvedGateCount: Math.min(options.approvedGates(), 5), requiredGateCount: 5, framesRendered, framesTotal, ...(phase ? { phase } : {}) }
}

export async function orchestrateAttempt(options: OrchestrationOptions): Promise<AttemptRecord> {
  const { attempt } = options
  try {
    guard(options)
    if (attempt.state === "PREPARING") {
      progress(attempt, options, 0, 1, "PREPARING")
      await options.compile((framesRendered, framesTotal) => progress(attempt, options, framesRendered, framesTotal, "PREPARING"))
      guard(options)
      transition(attempt, "READY")
      if (options.approvedGates() < 4) transition(attempt, "STALE_APPROVAL")
    }
    if (attempt.state === "READY") {
      if (options.approvedGates() < 4) throw new OrchestrationError("STALE_APPROVAL")
      transition(attempt, "QUEUED")
    }
    if (attempt.state === "QUEUED") transition(attempt, "RENDERING")
    if (attempt.state === "RENDERING") {
      if (cancelRequested(options)) { transition(attempt, "CANCEL_REQUESTED"); throw new OrchestrationError("CANCELLED") }
      progress(attempt, options, 0, 120, "RENDERING")
      await options.render((framesRendered, framesTotal) => progress(attempt, options, framesRendered, framesTotal, "RENDERING"))
      guard(options)
      transition(attempt, "ASSEMBLING")
    }
    if (attempt.state === "ASSEMBLING") {
      progress(attempt, options, 120, 120, "ASSEMBLING")
      await options.assemble()
      guard(options)
      transition(attempt, "AWAITING_T5")
    }
    if (attempt.state === "AWAITING_T5") {
      if (options.approvedGates() < 5) return attempt
      await options.publishAfterT5()
      guard(options)
      transition(attempt, "COMPLETED")
    }
    return attempt
  } catch (error) {
    if (error instanceof OrchestrationError) {
      attempt.error = error.code
      if (error.code === "CANCELLED") { if (attempt.state === "CANCEL_REQUESTED") transition(attempt, "CANCELLED"); return attempt }
      if (error.code === "STALE_APPROVAL" && attempt.state === "READY") transition(attempt, "STALE_APPROVAL")
      else if (attempt.state !== "FAILED" && attempt.state !== "AWAITING_T5") transition(attempt, "FAILED")
      return attempt
    }
    attempt.error = "TRANSIENT_WORKER_FAILURE"
    if (attempt.state === "RENDERING" || attempt.state === "ASSEMBLING") transition(attempt, "RETRYABLE_ERROR")
    else if (attempt.state !== "FAILED" && attempt.state !== "AWAITING_T5") transition(attempt, "FAILED")
    return attempt
  }
}
