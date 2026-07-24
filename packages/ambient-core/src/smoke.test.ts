import { describe, expect, it } from "vitest";
import { AMBIENT_CORE_VERSION } from "./index.js";
import type { CaptureMode } from "@phenometrix/contracts";

describe("ambient-core toolchain", () => {
  it("exposes a version and resolves the contracts package", () => {
    const mode: CaptureMode = "fixture-playback";
    expect(AMBIENT_CORE_VERSION).toBe("0.1.0");
    expect(mode).toBe("fixture-playback");
  });
});
