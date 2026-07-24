#!/usr/bin/env node
/**
 * Recomputes the ambient protocol pack's content digest.
 *
 * The digest was hand-pasted hex with one assertion behind it
 * (contracts-v3.test.ts), and the runtime check at report.ts compares the pack
 * against itself because the only live caller passes the pack it just loaded.
 * A wrong digest therefore reaches the browser and stamps every observation.
 * This makes regenerating it mechanical and drift detectable in CI.
 *
 *   npx tsx scripts/protocol-digest.mjs --check    verify, exit 1 on drift
 *   npx tsx scripts/protocol-digest.mjs --write    rewrite the literal in place
 *
 * Run under tsx: the script imports the parsed pack, and the contracts sources
 * use NodeNext ".js" specifiers that plain node will not remap to ".ts".
 *
 * The consent digest is deliberately NOT regenerated here. It hashes
 * AMBIENT_LOCAL_CONSENT_TEXT, the exact string rendered into the consent
 * checkbox at main.ts, and contracts-v3.test.ts already asserts the two match.
 * Recomputing it from the constant would make any edit to the consent wording
 * self-certifying, which is precisely the property that check needs to lack:
 * changing the terms a participant agreed to should break a test and force a
 * deliberate version bump, not quietly re-hash itself.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_SOURCE = resolve(ROOT, "packages/contracts/src/ambient-protocol.ts");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Mirrors `canonicalize` in ambient-protocol.ts: recursive key sort, not JCS.
 * Kept byte-identical rather than replaced with a standard canonical form,
 * because changing the canonicalizer would silently change the digest.
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

/** The pack's own `contentSha256`, which sits in the block opened by `packId`. */
const PACK_LITERAL = /(packId:[\s\S]*?contentSha256:\s*\n?\s*")[a-f0-9]{64}(")/;

async function expectedDigest() {
  // Import the parsed, frozen pack the application actually uses, so the digest
  // covers post-Zod output. A pack that cannot parse therefore fails here too.
  const { AMBIENT_LOCAL_PROTOCOL_PACK: pack } = await import(
    resolve(ROOT, "packages/contracts/src/index.ts")
  );
  const { contentSha256: _omitted, ...content } = pack;
  return sha256(canonicalize(content));
}

async function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  if (write === check) {
    console.error("Usage: protocol-digest.mjs --check | --write");
    process.exit(2);
  }

  const expected = await expectedDigest();
  const source = await readFile(PACK_SOURCE, "utf8");
  const match = PACK_LITERAL.exec(source);
  if (!match) {
    console.error("Could not locate the pack contentSha256 literal.");
    process.exit(1);
  }
  const actual = /contentSha256:\s*\n?\s*"([a-f0-9]{64})"/.exec(match[0])[1];

  if (check) {
    if (actual !== expected) {
      console.error("Protocol pack digest is stale:");
      console.error(`  actual   ${actual}`);
      console.error(`  expected ${expected}`);
      console.error("\nRun: npx tsx scripts/protocol-digest.mjs --write");
      process.exit(1);
    }
    console.log("Protocol pack digest is current.");
    return;
  }

  if (actual === expected) {
    console.log(`Protocol pack digest already current: ${expected}`);
    return;
  }
  await writeFile(PACK_SOURCE, source.replace(PACK_LITERAL, `$1${expected}$2`), "utf8");
  console.log(`Protocol pack digest updated: ${actual} -> ${expected}`);
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
