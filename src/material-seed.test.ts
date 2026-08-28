import { describe, expect, it } from "vitest";
import { deriveMaterialSeed } from "./material-seed.js";

describe("deriveMaterialSeed", () => {
  it("is stable for the same asset id and prompt", () => {
    expect(deriveMaterialSeed("hero", "a glass orb")).toBe(
      deriveMaterialSeed("hero", "a glass orb"),
    );
  });
  it("differs when the prompt differs", () => {
    expect(deriveMaterialSeed("hero", "a glass orb")).not.toBe(
      deriveMaterialSeed("hero", "a wooden orb"),
    );
  });
  it("differs when the asset id differs", () => {
    expect(deriveMaterialSeed("hero", "a glass orb")).not.toBe(
      deriveMaterialSeed("sidekick", "a glass orb"),
    );
  });
  it("always returns a non-negative 32-bit integer", () => {
    const seed = deriveMaterialSeed("hero", "a glass orb");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});
