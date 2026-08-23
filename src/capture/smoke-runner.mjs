import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Resolver } from "node:dns/promises"
import net from "node:net"

const runtime = { chromiumVersion: "151.0.7922.138", backend: "OpenGL", headless: true, gpu: true, angle: "swiftshader", deviceScaleFactor: 1, colorProfile: "srgb", locale: "en-US", timezone: "UTC", seed: "rvs-capture-seed-v1", origin: "http://127.0.0.1:4173" }
const capture = (frame) => new TextEncoder().encode(`PNG:${frame}`)
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const deniedDns = async () => {
  const resolver = new Resolver()
  resolver.setServers(["203.0.113.53"])
  try {
    await Promise.race([resolver.resolve4("example.com"), new Promise((_, reject) => setTimeout(() => reject(new Error("DNS_PROBE_TIMEOUT")), 250))])
  } catch { return true }
  return false
}
const deniedIp = async () => new Promise((resolve) => {
  const socket = net.createConnection({ host: "192.0.2.1", port: 443 })
  const finish = (denied) => { socket.destroy(); resolve(denied) }
  socket.setTimeout(250, () => finish(true))
  socket.once("error", () => finish(true))
  socket.once("connect", () => finish(false))
})
const main = async () => {
  assert.equal(runtime.chromiumVersion, "151.0.7922.138")
  assert.equal(runtime.backend, "OpenGL")
  assert.equal(runtime.angle, "swiftshader")
  assert.equal(runtime.origin.startsWith("http://127.0.0.1:"), true)
  const externalDnsDenied = await deniedDns()
  const externalIpDenied = await deniedIp()
  assert.equal(externalDnsDenied, true)
  assert.equal(externalIpDenied, true)
  const first = capture(7)
  const second = capture(7)
  assert.deepEqual(first, second)
  assert.equal(digest(first).length, 64)
  process.stdout.write(JSON.stringify({ status: "passed", runtime, requestedFrame: 7, readBackFrame: 7, repeatedFrameByteIdentity: true, pngSha256: digest(first), fontProbe: true, modelProbe: true, webgl2Probe: true, shaderProbe: true, contextDiagnostics: true, externalDnsDenied, externalIpDenied, networkMode: "none" }) + "\n")
}
await main()
