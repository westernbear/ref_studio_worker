import crypto from "node:crypto"
import Database from "better-sqlite3"
import { assertLegalTransition, type JobState, type RetryClass } from "./contracts/lifecycle.js"

export type QueueJob = Readonly<{ jobId: string; attemptId: string; attempt: number; state: JobState; leaseToken: string; deletionEpoch: number }>
export type QueueOptions = Readonly<{ leaseSeconds?: number; workerId: string }>
type Row = { job_id: string; attempt_id: string; attempt: number; state: JobState; lease_token: string; deletion_epoch: number }

const transient: ReadonlySet<RetryClass> = new Set(["TRANSIENT_WORKER", "TRANSIENT_UPLOAD"])
const retryableStates: ReadonlySet<JobState> = new Set(["PREPARING", "RENDERING", "ASSEMBLING", "RETRYABLE_ERROR"])

export function createQueueDatabase(filename: string): Database {
  const db = new Database(filename, { timeout: 5000 })
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_control (id INTEGER PRIMARY KEY CHECK (id=1), draining INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO worker_control(id, draining) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS worker_queue (
      job_id TEXT PRIMARY KEY, eligible_at TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL, deletion_epoch INTEGER NOT NULL, drain_epoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS worker_attempts (
      attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES worker_queue(job_id),
      number INTEGER NOT NULL, state TEXT NOT NULL, retry_class TEXT, created_at TEXT NOT NULL,
      UNIQUE(job_id, number)
    );
    CREATE TABLE IF NOT EXISTS worker_leases (
      job_id TEXT PRIMARY KEY REFERENCES worker_queue(job_id), attempt_id TEXT NOT NULL,
      lease_owner TEXT NOT NULL, lease_token TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      deletion_epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_queue_order ON worker_queue(eligible_at, created_at, job_id);
  `)
  return db
}

function token(): string { return crypto.randomBytes(32).toString("hex") }
function id(prefix: string): string { return `${prefix}_${crypto.randomUUID()}` }
function seconds(value: number): number { return Math.max(1, Math.floor(value)) }

export class JobQueue {
  readonly #db: Database
  readonly #workerId: string
  readonly #leaseSeconds: number
  constructor(db: Database, options: QueueOptions) {
    this.#db = db
    this.#workerId = options.workerId
    this.#leaseSeconds = seconds(options.leaseSeconds ?? 60)
  }

  enqueue(jobId: string, deletionEpoch = 0): void {
    const now = "datetime('now')"
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      this.#db.prepare(`INSERT INTO worker_queue(job_id, eligible_at, created_at, state, deletion_epoch) VALUES (?, ${now}, ${now}, 'READY', ?)`).run(jobId, deletionEpoch)
      this.#db.prepare(`INSERT INTO worker_attempts(attempt_id, job_id, number, state, created_at) VALUES (?, ?, 1, 'READY', ${now})`).run(id("attempt"), jobId)
      this.#db.exec("COMMIT")
    } catch (error) { this.#db.exec("ROLLBACK"); throw error }
  }

  setDraining(draining: boolean): void { this.#db.prepare("UPDATE worker_control SET draining=? WHERE id=1").run(draining ? 1 : 0) }

  claim(): QueueJob | undefined {
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const row = this.#db.prepare<readonly [], Row>(`SELECT q.job_id, a.attempt_id, a.number AS attempt, q.state, q.deletion_epoch, '' AS lease_token
        FROM worker_queue q JOIN worker_attempts a ON a.job_id=q.job_id AND a.number=(SELECT max(number) FROM worker_attempts WHERE job_id=q.job_id)
        WHERE q.state IN ('READY','QUEUED','PREPARING','RENDERING','ASSEMBLING') AND q.eligible_at <= datetime('now') AND NOT EXISTS
        (SELECT 1 FROM worker_leases l WHERE l.job_id=q.job_id AND l.lease_expires_at > datetime('now'))
        AND (SELECT draining FROM worker_control WHERE id=1) = 0 ORDER BY q.eligible_at, q.created_at, q.job_id LIMIT 1`).get()
      if (!row) { this.#db.exec("COMMIT"); return undefined }
      const leaseToken = token()
      const changed = this.#db.prepare(`INSERT INTO worker_leases(job_id, attempt_id, lease_owner, lease_token, lease_expires_at, deletion_epoch)
        VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'), ?)`).run(row.job_id, row.attempt_id, this.#workerId, leaseToken, this.#leaseSeconds, row.deletion_epoch)
      if (changed.changes !== 1) throw new Error("DUPLICATE_CLAIM")
      this.#db.exec("COMMIT")
      return { jobId: row.job_id, attemptId: row.attempt_id, attempt: row.attempt, state: row.state, leaseToken, deletionEpoch: row.deletion_epoch }
    } catch (error) { this.#db.exec("ROLLBACK"); throw error }
  }

  heartbeat(job: QueueJob): void { this.#mutateLease(`UPDATE worker_leases SET lease_expires_at=datetime('now', '+' || ? || ' seconds') WHERE job_id=? AND lease_token=? AND deletion_epoch=?`, this.#leaseSeconds, job.jobId, job.leaseToken, job.deletionEpoch) }

  transition(job: QueueJob, next: JobState): void {
    assertLegalTransition(job.state, next)
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const lease = this.#db.prepare("SELECT 1 AS ok FROM worker_leases WHERE job_id=? AND lease_token=? AND deletion_epoch=?").get(job.jobId, job.leaseToken, job.deletionEpoch)
      if (!lease) throw new Error("STALE_LEASE")
      this.#db.prepare("UPDATE worker_queue SET state=? WHERE job_id=? AND deletion_epoch=?").run(next, job.jobId, job.deletionEpoch)
      this.#db.prepare("UPDATE worker_attempts SET state=? WHERE attempt_id=?").run(next === "COMPLETED" ? "COMPLETED" : next === "CANCELLED" ? "CANCELLED" : next === "FAILED" ? "FAILED" : "RUNNING", job.attemptId)
      if (["COMPLETED", "CANCELLED", "FAILED"].includes(next)) this.#db.prepare("DELETE FROM worker_leases WHERE job_id=? AND lease_token=?").run(job.jobId, job.leaseToken)
      this.#db.exec("COMMIT")
    } catch (error) { this.#db.exec("ROLLBACK"); throw error }
  }

  requestCancel(jobId: string): void { this.#db.prepare("UPDATE worker_queue SET state='CANCEL_REQUESTED' WHERE job_id=? AND state IN ('QUEUED','PREPARING','RENDERING')").run(jobId) }
  acknowledgeCancel(job: QueueJob): void { this.transition({ ...job, state: "CANCEL_REQUESTED" }, "CANCELLED") }

  retry(job: QueueJob, retryClass: RetryClass, manual = false): QueueJob {
    if (!manual && !transient.has(retryClass)) throw new Error("RETRY_NOT_ALLOWED")
    if (!manual && job.attempt > 3) throw new Error("AUTOMATIC_RETRY_EXHAUSTED")
    if (!retryableStates.has(job.state) && job.state !== "FAILED") throw new Error("RETRY_NOT_ALLOWED")
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const nextAttempt = job.attempt + 1
      const attemptId = id("attempt")
      this.#db.prepare("UPDATE worker_attempts SET state='FAILED', retry_class=? WHERE attempt_id=?").run(retryClass, job.attemptId)
      this.#db.prepare(`INSERT INTO worker_attempts(attempt_id, job_id, number, state, created_at) VALUES (?, ?, ?, 'QUEUED', datetime('now'))`).run(attemptId, job.jobId, nextAttempt)
      this.#db.prepare("UPDATE worker_queue SET state='QUEUED', eligible_at=datetime('now') WHERE job_id=? AND deletion_epoch=?").run(job.jobId, job.deletionEpoch)
      this.#db.prepare("DELETE FROM worker_leases WHERE job_id=? AND lease_token=?").run(job.jobId, job.leaseToken)
      this.#db.exec("COMMIT")
      return { ...job, attemptId, attempt: nextAttempt, state: "QUEUED", leaseToken: "", }
    } catch (error) { this.#db.exec("ROLLBACK"); throw error }
  }
  #mutateLease(sql: string, ...parameters: readonly unknown[]): void {
    this.#db.exec("BEGIN IMMEDIATE")
    try { const result = this.#db.prepare(sql).run(...parameters); if (result.changes !== 1) throw new Error("STALE_LEASE"); this.#db.exec("COMMIT") }
    catch (error) { this.#db.exec("ROLLBACK"); throw error }
  }
}
