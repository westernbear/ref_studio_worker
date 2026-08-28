import { describe, expect, it } from "vitest";
import { parseWorkerConfig } from "./worker-config.js";

describe("worker config", () => {
  it("parses required values and safe interval defaults", () => {
    const config = parseWorkerConfig({
      RVS_API_BASE_URL: "https://api.example.test/",
      RVS_WORKER_TOKEN: "secret",
      RVS_WORKER_CAPABILITIES: "compiler,renderer",
    });
    expect(config.apiBaseUrl).toBe("https://api.example.test");
    expect(config.capabilities).toEqual(["compiler", "renderer"]);
    expect(config.heartbeatIntervalMs).toBe(30_000);
    expect(config.apiRequestTimeoutMs).toBe(30_000);
    expect(config.mediaRequestTimeoutMs).toBe(1_800_000);
  });
  it("parses an API request timeout override", () => {
    const config = parseWorkerConfig({
      RVS_API_BASE_URL: "https://api.example.test/",
      RVS_WORKER_TOKEN: "secret",
      RVS_API_REQUEST_TIMEOUT_MS: "1500",
      RVS_MEDIA_REQUEST_TIMEOUT_MS: "900000",
    });
    expect(config.apiRequestTimeoutMs).toBe(1_500);
    expect(config.mediaRequestTimeoutMs).toBe(900_000);
  });
  it("rejects missing token and unsafe intervals", () => {
    expect(() =>
      parseWorkerConfig({
        RVS_API_BASE_URL: "https://api.example.test",
        RVS_HEARTBEAT_INTERVAL_MS: "99",
      }),
    ).toThrow();
  });
  it("leaves the self-hosted material base URLs unset by default", () => {
    const config = parseWorkerConfig({
      RVS_API_BASE_URL: "https://api.example.test",
      RVS_WORKER_TOKEN: "secret",
    });
    expect(config.wanAlphaBaseUrl).toBeUndefined();
    expect(config.hi3dgenBaseUrl).toBeUndefined();
  });
  it("parses the self-hosted material base URLs when configured", () => {
    const config = parseWorkerConfig({
      RVS_API_BASE_URL: "https://api.example.test",
      RVS_WORKER_TOKEN: "secret",
      RVS_WAN_ALPHA_BASE_URL: "http://wan-alpha:8000",
      RVS_HI3DGEN_BASE_URL: "http://hi3dgen:8000",
    });
    expect(config.wanAlphaBaseUrl).toBe("http://wan-alpha:8000");
    expect(config.hi3dgenBaseUrl).toBe("http://hi3dgen:8000");
  });
  it("rejects a self-hosted material base URL that isn't a valid URL", () => {
    expect(() =>
      parseWorkerConfig({
        RVS_API_BASE_URL: "https://api.example.test",
        RVS_WORKER_TOKEN: "secret",
        RVS_WAN_ALPHA_BASE_URL: "not-a-url",
      }),
    ).toThrow();
  });
});
