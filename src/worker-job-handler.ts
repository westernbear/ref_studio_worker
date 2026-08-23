import { z } from "zod"
import type { WorkerJobHandler } from "./worker-daemon.js"

const WorkflowPayload = z
  .object({
    tenantId: z.string().min(1),
    uploadId: z.string().min(1),
    frameCount: z.number().int().positive(),
    phase: z.enum(["prepare", "render"]),
  })
  .strict()

export const handleWorkflowJob: WorkerJobHandler = async (job) => {
  const payload = WorkflowPayload.parse(job.payload)
  return {
    protocol: "rvs.worker.v1",
    jobId: job.jobId,
    attemptId: job.attemptId,
    tenantId: payload.tenantId,
    uploadId: payload.uploadId,
    frameCount: payload.frameCount,
    phase: payload.phase,
  }
}
