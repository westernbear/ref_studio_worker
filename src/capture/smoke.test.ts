import { describe, expect, it } from "vitest"
import { captureFrame, CAPTURE_RUNTIME, CapturePreflightError, type CaptureDiagnostics, type CaptureSource } from "./index.js"

const diagnostics: CaptureDiagnostics = { runtime: CAPTURE_RUNTIME, fontReady: true, modelReady: true, webgl2: true, shaderReady: true, contextErrors: [], externalRequests: [], networkDenied: true }
const source: CaptureSource = { renderFrame: (frame) => ({ frame, readBackFrame: frame, markup: `<svg data-frame="${frame}" />`, nodes: [], seed: CAPTURE_RUNTIME.seed, fontPaths: [] }), readBack: (frame) => frame.readBackFrame, capturePng: (frame) => new TextEncoder().encode(`PNG:${frame.frame}`) }

describe("deterministic capture boundary", () => {
  it("captures only after strict preflight and records identity evidence", () => {
    const result = captureFrame(source, diagnostics, 7)
    expect(result.evidence.requestedFrame).toBe(7)
    expect(result.evidence.readBackFrame).toBe(7)
    expect(result.evidence.repeatedFrameByteIdentity).toBe(true)
    expect(result.evidence.pngSha256).toHaveLength(64)
  })

  it("rejects host Chromium and produces no capture", () => {
    const bad = { ...diagnostics, runtime: { ...CAPTURE_RUNTIME, chromiumVersion: "151.0.7922.169" } }
    expect(() => captureFrame(source, bad, 0)).toThrowError(new CapturePreflightError("CHROMIUM_VERSION_MISMATCH"))
  })

  it("rejects external request attempts", () => {
    const bad = { ...diagnostics, externalRequests: ["https://example.invalid"] }
    expect(() => captureFrame(source, bad, 0)).toThrowError(new CapturePreflightError("EXTERNAL_REQUEST_ATTEMPT"))
  })
})
