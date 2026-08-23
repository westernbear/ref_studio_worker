import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createQueueDatabase, JobQueue, type QueueJob } from "./queue.js"

function fixture(): { db: ReturnType<typeof createQueueDatabase>; queue: JobQueue } {
  const db = createQueueDatabase(join(mkdtempSync(join(tmpdir(), "rvs-queue-")), "queue.sqlite"))
  return { db, queue: new JobQueue(db, { workerId: crypto.randomUUID(), leaseSeconds: 1 }) }
}
function claimRequired(queue: JobQueue): QueueJob {
  const claimed = queue.claim()
  if (!claimed) throw new Error("claim fixture failed")
  return claimed
}

describe("SQLite job queue", () => {
  it("claims exactly once across competing claimers", () => {
    const { db, queue } = fixture()
    queue.enqueue("job-a")
    const competing = new JobQueue(db, { workerId: "worker-b", leaseSeconds: 60 })
    const first = queue.claim()
    const second = competing.claim()
    expect(first?.jobId).toBe("job-a")
    expect(second).toBeUndefined()
    db.close()
  })

  it("requires the lease token and preserves immutable retry history", () => {
    const { db, queue } = fixture()
    queue.enqueue("job-a")
    const claimed = queue.claim()
    expect(claimed).toBeDefined()
    if (!claimed) throw new Error("claim fixture failed")
    expect(() => queue.heartbeat({ ...claimed, leaseToken: "stale" })).toThrow("STALE_LEASE")
    queue.transition(claimed, "QUEUED"); queue.transition({ ...claimed, state: "QUEUED" }, "RENDERING")
    const retried = queue.retry({ ...claimed, state: "RENDERING" }, "TRANSIENT_WORKER")
    expect(retried.attempt).toBe(2)
    expect(db.prepare("SELECT count(*) AS count FROM worker_attempts WHERE job_id=?").get("job-a")).toEqual({ count: 2 })
    db.close()
  })

  it("stops claims while draining and resumes persisted work after restart", () => {
    const { db, queue } = fixture()
    queue.enqueue("job-a")
    queue.setDraining(true)
    expect(queue.claim()).toBeUndefined()
    queue.setDraining(false)
    const claimed = queue.claim()
    expect(claimed?.jobId).toBe("job-a")
    db.close()
  })

  it("acknowledges cancellation only through a leased worker", () => {
    const { db, queue } = fixture()
    queue.enqueue("job-a")
    const claimed = queue.claim()
    expect(claimed).toBeDefined()
    if (!claimed) throw new Error("claim fixture failed")
    queue.requestCancel("job-a")
    expect(() => queue.acknowledgeCancel(claimed)).not.toThrow()
    expect(db.prepare("SELECT state FROM worker_queue WHERE job_id=?").get("job-a")).toEqual({ state: "CANCELLED" })
    db.close()
  })

  it("rejects validation retries and the fourth automatic retry", () => {
    const { db, queue } = fixture()
    queue.enqueue("job-a")
    let claimed = claimRequired(queue)
    expect(() => queue.retry({ ...claimed, state: "PREPARING" }, "VALIDATION")).toThrow("RETRY_NOT_ALLOWED")
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (claimed.state === "READY") queue.transition(claimed, "QUEUED")
      queue.transition({ ...claimed, state: "QUEUED" }, "RENDERING")
      claimed = queue.retry({ ...claimed, state: "RENDERING" }, "TRANSIENT_WORKER")
      if (attempt < 3) claimed = claimRequired(queue)
    }
    expect(() => queue.retry({ ...claimed, state: "RENDERING" }, "TRANSIENT_WORKER")).toThrow("AUTOMATIC_RETRY_EXHAUSTED")
    db.close()
  })
})
