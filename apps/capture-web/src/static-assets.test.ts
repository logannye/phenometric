import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAssetUrl,
  staticAssetManifestSchema,
  verifyStaticAsset
} from "./static-assets.js";

describe("static asset manifest", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resolves below an arbitrary deployment base", () => {
    expect(
      resolveAssetUrl(
        "models/face_landmarker.task",
        "https://example.test/tools/phenometrix/index.html"
      )
    ).toBe("https://example.test/tools/phenometrix/models/face_landmarker.task");
  });

  it("rejects root-relative and escaping paths", () => {
    const template = {
      schemaVersion: "phenometrix.static-assets.v1",
      assets: {}
    };
    expect(() =>
      staticAssetManifestSchema.parse({
        ...template,
        assets: {
          faceModel: { path: "/model", sha256: "a".repeat(64) }
        }
      })
    ).toThrow();
  });

  it("withholds an asset whose runtime bytes do not match", async () => {
    vi.stubGlobal("crypto", {
      subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) }
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1]), { status: 200 })
    ) as unknown as typeof fetch;
    await expect(
      verifyStaticAsset(
        { path: "model.task", sha256: "f".repeat(64) },
        "https://example.test/app/",
        fetcher
      )
    ).rejects.toThrow("asset-integrity-failed:model.task");
  });
});
