import { describe, expect, it } from "vitest";
import { runWorkerPreflight } from "./worker-preflight.js";

describe("worker runtime preflight", () => {
  it("checks the pinned tools and browser before returning PASS", async () => {
    const commands: string[] = [];
    const report = await runWorkerPreflight(new AbortController().signal, {
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        return {
          stdout: command.includes("chrome")
            ? "Google Chrome 151.0.7922.138"
            : "ok",
          stderr: "",
        };
      },
      captureFrames: async () => ({
        chromiumVersion: "151.0.7922.138",
        renderer: "ANGLE SwiftShader",
        fontReady: true,
        webgl2: true,
        networkPolicy: "external-blocked",
        repeatedFrameByteIdentity: true,
        frameSha256: ["a".repeat(64)],
        passIds: [],
        shaderDiagnostics: [],
        limits: {
          MAX_TEXTURE_SIZE: 16_384,
          MAX_RENDERBUFFER_SIZE: 16_384,
        },
      }),
    });

    expect(report).toMatchObject({
      status: "PASS",
      chromiumVersion: "151.0.7922.138",
      renderer: "ANGLE SwiftShader",
      ffmpeg: true,
      ffprobe: true,
      compilerModels: true,
    });
    expect(report.runtimeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(commands).toHaveLength(4);
  });
});
