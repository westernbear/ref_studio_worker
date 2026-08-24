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
      readIdentityFile: async (path: string) =>
        Buffer.from(path.includes("font") ? "font-v1" : "manifest-v1"),
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

  it("derives a deterministic digest from every runtime identity input", async () => {
    const digest = async (
      overrides: Readonly<{
        modelManifest?: string;
        font?: string;
        ffmpeg?: string;
        ffprobe?: string;
        rendererFrame?: string;
      }>,
    ): Promise<string> =>
      (
        await runWorkerPreflight(new AbortController().signal, {
          runCommand: async (command) => ({
            stdout: command.includes("chrome")
              ? "Google Chrome 151.0.7922.138"
              : command.includes("ffprobe")
                ? (overrides.ffprobe ?? "ffprobe-v1")
                : command.includes("ffmpeg")
                  ? (overrides.ffmpeg ?? "ffmpeg-v1")
                  : "models-ok",
            stderr: "",
          }),
          captureFrames: async () => ({
            chromiumVersion: "151.0.7922.138",
            renderer: "ANGLE SwiftShader",
            fontReady: true,
            webgl2: true,
            networkPolicy: "external-blocked",
            repeatedFrameByteIdentity: true,
            frameSha256: [overrides.rendererFrame ?? "a".repeat(64)],
            passIds: [],
            shaderDiagnostics: [],
            limits: {
              MAX_TEXTURE_SIZE: 16_384,
              MAX_RENDERBUFFER_SIZE: 16_384,
            },
          }),
          readIdentityFile: async (path: string) =>
            Buffer.from(
              path.includes("font")
                ? (overrides.font ?? "font-v1")
                : (overrides.modelManifest ?? "manifest-v1"),
            ),
        })
      ).runtimeDigest;

    const baseline = await digest({});
    expect(await digest({})).toBe(baseline);
    for (const changed of [
      { modelManifest: "manifest-v2" },
      { font: "font-v2" },
      { ffmpeg: "ffmpeg-v2" },
      { ffprobe: "ffprobe-v2" },
      { rendererFrame: "b".repeat(64) },
    ])
      expect(await digest(changed)).not.toBe(baseline);
  });
});
