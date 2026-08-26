import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkerPreflight } from "./worker-preflight.js";

afterEach(() => vi.restoreAllMocks());

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

  it("passes the existing preflight deadline to browser capture", async () => {
    const deadline = new AbortController();
    deadline.abort(new Error("preflight deadline"));
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);

    await expect(
      runWorkerPreflight(new AbortController().signal, {
        runCommand: async () => ({ stdout: "151.0.7922.138", stderr: "" }),
        readIdentityFile: async () => Buffer.from("identity"),
        captureFrames: async (input) => {
          if (input.signal.aborted) throw new Error("PREFLIGHT_TIMEOUT");
          throw new Error("BROWSER_CAPTURE_WAS_UNBOUNDED");
        },
      }),
    ).rejects.toThrow("PREFLIGHT_TIMEOUT");
    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("fails closed when the pinned font file is missing", async () => {
    await expect(
      runWorkerPreflight(new AbortController().signal, {
        runCommand: async () => ({ stdout: "151.0.7922.138", stderr: "" }),
        readIdentityFile: async (path: string) => {
          if (path.includes("font")) throw new Error("ENOENT");
          return Buffer.from("manifest-v1");
        },
        captureFrames: async () => {
          throw new Error("must not capture without a verified font");
        },
      }),
    ).rejects.toThrow("ENOENT");
  });
});
