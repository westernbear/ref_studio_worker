import { fileURLToPath } from "node:url"
import { createWorkerApi } from "./worker-api.js"
import { runWorkerDaemon } from "./worker-daemon.js"
import { parseWorkerConfig } from "./worker-config.js"
import { handleWorkflowJob } from "./worker-job-handler.js"
import type { WorkerConfig } from "./worker-config.js"

export const createWorkerRuntime = (config: WorkerConfig) => ({
  api: createWorkerApi(config),
  handleJob: handleWorkflowJob,
})

export const main = async (env: NodeJS.ProcessEnv = process.env): Promise<void> => {
  const config = parseWorkerConfig(env)
  const runtime = createWorkerRuntime(config)
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  await runWorkerDaemon(config, runtime.api, controller.signal, runtime.handleJob)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) {
    console.error(error instanceof Error ? error.message : "worker daemon failed")
    process.exitCode = 1
  }
}
