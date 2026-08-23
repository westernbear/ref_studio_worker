import { createWorkerApi } from "./worker-api.js"
import { runWorkerDaemon } from "./worker-daemon.js"
import { parseWorkerConfig } from "./worker-config.js"

const main = async (): Promise<void> => {
  const config = parseWorkerConfig(process.env)
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  await runWorkerDaemon(config, createWorkerApi(config), controller.signal)
}

try { await main() } catch (error) {
  console.error(error instanceof Error ? error.message : "worker daemon failed")
  process.exitCode = 1
}
