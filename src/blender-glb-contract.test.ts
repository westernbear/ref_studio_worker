import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { BLENDER_3D_BUDGET, parseGlbContract } from "./blender-glb-contract.js";

const glb = (json: Readonly<Record<string, unknown>>): Uint8Array => {
  const encoded = Buffer.from(JSON.stringify(json), "utf8");
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  encoded.copy(bytes, 20);
  return bytes;
};

const png = (width: number, height: number): Uint8Array => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const glbWithBin = (
  json: Readonly<Record<string, unknown>>,
  binary: Uint8Array,
): Uint8Array => {
  const encoded = Buffer.from(JSON.stringify(json), "utf8");
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonLength + binaryLength, 0);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonLength);
  encoded.copy(bytes, 20);
  const binaryHeader = 20 + jsonLength;
  bytes.writeUInt32LE(binaryLength, binaryHeader);
  bytes.writeUInt32LE(0x004e4942, binaryHeader + 4);
  Buffer.from(binary).copy(bytes, binaryHeader + 8);
  return bytes;
};

describe("parseGlbContract", () => {
  it("accepts a bounded embedded GLB", () => {
    const parsed = parseGlbContract(
      glb({
        asset: { version: "2.0" },
        accessors: [{ count: 3 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        materials: [{}],
      }),
      BLENDER_3D_BUDGET,
    );
    expect(parsed).toMatchObject({ triangles: 1, materials: 1, textures: 0 });
  });

  it.each([
    ["remote texture", { images: [{ uri: "https://example.com/t.png" }] }],
    ["local sidecar without hash", { images: [{ uri: "texture.png" }] }],
    ["script extension", { extensionsUsed: ["RVS_arbitrary_script"] }],
  ])("rejects %s", (_name, extra) => {
    expect(() =>
      parseGlbContract(
        glb({ asset: { version: "2.0" }, ...extra }),
        BLENDER_3D_BUDGET,
      ),
    ).toThrow(/GLB_CONTRACT_REJECTED/u);
  });

  it("rejects triangle and material budgets", () => {
    const accessors = [{ count: (BLENDER_3D_BUDGET.maxTriangles + 1) * 3 }];
    expect(() =>
      parseGlbContract(
        glb({
          asset: { version: "2.0" },
          accessors,
          meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
          materials: Array.from(
            { length: BLENDER_3D_BUDGET.maxMaterials + 1 },
            () => ({}),
          ),
        }),
        BLENDER_3D_BUDGET,
      ),
    ).toThrow(/GLB_RESOURCE_BUDGET_EXCEEDED/u);
  });

  it("verifies embedded and local texture hashes", () => {
    const texture = png(32, 16);
    const sha256 = createHash("sha256").update(texture).digest("hex");
    const embedded = glbWithBin(
      {
        asset: { version: "2.0" },
        bufferViews: [{ buffer: 0, byteLength: texture.length }],
        images: [
          {
            bufferView: 0,
            mimeType: "image/png",
            extras: { rvsSha256: sha256 },
          },
        ],
      },
      texture,
    );
    expect(parseGlbContract(embedded, BLENDER_3D_BUDGET).textureSha256).toEqual(
      [sha256],
    );
    const uri = `assets/${sha256}.png`;
    const local = glb({
      asset: { version: "2.0" },
      images: [{ uri, extras: { rvsSha256: sha256 } }],
    });
    expect(
      parseGlbContract(local, BLENDER_3D_BUDGET, new Map([[uri, texture]]))
        .textureSha256,
    ).toEqual([sha256]);
    expect(() =>
      parseGlbContract(local, BLENDER_3D_BUDGET, new Map([[uri, png(1, 1)]])),
    ).toThrow(/GLB_CONTRACT_REJECTED:texture-hash/u);
  });

  it("rejects over-budget texture dimensions", () => {
    const texture = png(BLENDER_3D_BUDGET.maxTextureDimension + 1, 1);
    const sha256 = createHash("sha256").update(texture).digest("hex");
    expect(() =>
      parseGlbContract(
        glbWithBin(
          {
            asset: { version: "2.0" },
            bufferViews: [{ buffer: 0, byteLength: texture.length }],
            images: [
              {
                bufferView: 0,
                mimeType: "image/png",
                extras: { rvsSha256: sha256 },
              },
            ],
          },
          texture,
        ),
        BLENDER_3D_BUDGET,
      ),
    ).toThrow(/GLB_RESOURCE_BUDGET_EXCEEDED:texture-dimensions/u);
  });
});
