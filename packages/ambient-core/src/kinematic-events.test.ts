import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * These are type declarations, so there is no runtime value to inspect. What
 * can go wrong is a field name, and it can only be caught in the source.
 *
 * Three separate privacy assertions elsewhere reject serialised structures
 * carrying these names. A Tier-2 record that reaches one of those boundaries
 * with a field called `eyeAperture` fails there -- at which point the fix is a
 * rename that ripples through every consumer. Catching it at the declaration
 * is the cheap version of the same check.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL("./kinematic-events.ts", import.meta.url)),
  "utf8"
);

/** Field-name portion of each declared property, comments excluded. */
function declaredFieldNames(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .flatMap((line) => {
      const match = /^\s{2,}([A-Za-z][A-Za-z0-9]*)\??:/.exec(line);
      return match ? [match[1]] : [];
    });
}

describe("tier-2 event record naming", () => {
  const FORBIDDEN = [
    "pcm",
    "waveform",
    "landmarks",
    "mouthCorners",
    "eyeAperture",
    "imageBitmap",
    "embedding",
    "voiceprint",
    "blendshapes",
    "transformationMatrix"
  ];

  it("declares no field the privacy assertions reject", () => {
    const fields = declaredFieldNames(SOURCE);
    expect(fields.length).toBeGreaterThan(20);
    const offending = fields.filter((field) =>
      FORBIDDEN.some(
        (name) => field.toLowerCase() === name.toLowerCase()
      )
    );
    expect(offending).toEqual([]);
  });

  it("carries no identifier matching the landmark pattern", () => {
    // The face-frame assertion is a substring match on /landmarks/i rather than
    // an exact field name, so `irisLandmarks` would fail it too. Comments are
    // stripped first: that assertion runs against a serialised frame, which
    // contains field names and values but no prose.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /\/\/.*$/gm,
      ""
    );
    expect(/landmarks/i.test(code)).toBe(false);
  });

  it("names lid fields so they survive the outcome-level assertion", () => {
    // `eyeAperture` is rejected at the outcome boundary; `lidAperture` is the
    // same quantity under a name that passes, and is the more precise term for
    // what is actually measured.
    const fields = declaredFieldNames(SOURCE);
    expect(fields).toContain("lidApertureMinimum");
    expect(fields.some((field) => field.startsWith("eyeAperture"))).toBe(false);
  });
});
