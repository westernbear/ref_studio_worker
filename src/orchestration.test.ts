import { describe, expect, it } from "vitest"
import { ProgressSchema } from "./contracts/lifecycle.js"
import { orchestrateAttempt, type AttemptRecord } from "./orchestration.js"

const fixture = (state: AttemptRecord["state"] = "PREPARING"): AttemptRecord => ({ state, attemptId: "attempt-a", deletionEpoch: 2, restoreEpoch: 3, progress: { approvedGateCount: 0, requiredGateCount: 4, framesRendered: 0, framesTotal: 120 }, error: null })
const options = (attempt: AttemptRecord, gates = 5) => ({ attempt, currentDeletionEpoch: () => 2, currentRestoreEpoch: () => 3, leaseValid: () => true, approvedGates: () => gates, compile: async (report: (frames: number, total: number) => void) => report(120, 120), render: async (report: (frames: number, total: number) => void) => report(120, 120), assemble: async () => undefined, publishAfterT5: async () => undefined })

describe("job attempt orchestration", () => {
  it("connects accepted work through T5 publication without conflating progress", async () => {
    const attempt = fixture(); const result = await orchestrateAttempt(options(attempt))
    expect(result.state).toBe("COMPLETED"); expect(result.progress.approvedGateCount).toBe(5); expect(result.progress.requiredGateCount).toBe(5); expect(result.progress.framesRendered).toBe(120); expect(ProgressSchema.parse(result.progress)).toEqual(result.progress)
  })
  it("holds at AWAITING_T5 and never falsely completes", async () => {
    const attempt = fixture(); const result = await orchestrateAttempt(options(attempt, 4))
    expect(result.state).toBe("AWAITING_T5"); expect(result.error).toBeNull()
  })
  it("fails closed on stale epochs and preserves cancellation boundaries", async () => {
    const stale = fixture(); const result = await orchestrateAttempt({ ...options(stale), currentDeletionEpoch: () => 9 }); expect(result.state).toBe("FAILED"); expect(result.error).toBe("STALE_EPOCH")
    const controller = new AbortController(); controller.abort(); const cancelled = fixture("RENDERING"); const stopped = await orchestrateAttempt({ ...options(cancelled), signal: controller.signal }); expect(stopped.state).toBe("CANCELLED")
  })
})
