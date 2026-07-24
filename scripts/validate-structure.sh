#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

required_files=(
  "README.md"
  "AGENTS.md"
  "SECURITY.md"
  "CONTRIBUTING.md"
  "docs/architecture.md"
  "docs/demo-experience.md"
  "docs/operator-guide.md"
  "docs/safety.md"
  "docs/validation.md"
  "apps/capture-web/index.html"
  "apps/capture-web/e2e/ambient-browser-fixture.ts"
  "apps/capture-web/e2e/ambient-smoke.spec.ts"
  "apps/capture-web/e2e/static-server.ts"
  "apps/capture-web/public/asset-manifest.json"
  "apps/capture-web/public/voice-capture-worklet.js"
  "apps/capture-web/src/ambient-core-adapter.ts"
  "apps/capture-web/src/ambient-workflow.ts"
  "apps/capture-web/src/capture-runtime.ts"
  "apps/capture-web/src/face-worker.ts"
  "apps/capture-web/src/main.ts"
  "apps/capture-web/src/static-assets.ts"
  "apps/capture-web/src/voice-worker.ts"
  "packages/ambient-core/src/ambient-face.ts"
  "packages/ambient-core/src/ambient-metrics.ts"
  "packages/ambient-core/src/ambient-registry.ts"
  "packages/ambient-core/src/ambient-voice.ts"
  "packages/contracts/src/ambient-protocol.ts"
  "packages/contracts/src/observation-v3.ts"
  "packages/contracts/src/report.ts"
  "packages/contracts/src/workflow-event.ts"
  "packages/evidence-core/src/report.ts"
  "packages/event-log/src/journal.ts"
  "agents/ambient-capture/README.md"
  "agents/personal-trajectory/README.md"
  "agents/evidence-card/README.md"
  "services/voice-inference/README.md"
  "services/voice-inference/pyproject.toml"
  "services/voice-inference/phenometrix_voice/app.py"
  "services/voice-inference/tests/test_service.py"
  "services/voice-inference/uv.lock"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Missing required ambient-v3 file: $required_file" >&2
    exit 1
  fi
done

node <<'NODE'
  const fs = require("node:fs");

  const rootPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const capturePackage = JSON.parse(
    fs.readFileSync("apps/capture-web/package.json", "utf8")
  );
  const manifest = JSON.parse(
    fs.readFileSync("apps/capture-web/public/asset-manifest.json", "utf8")
  );

  if (rootPackage.name !== "phenometrix") {
    throw new Error("The root package name must remain phenometrix.");
  }
  for (const command of [
    "check",
    "test",
    "test:unit",
    "test:browser",
    "typecheck",
    "build",
    "demo:smoke"
  ]) {
    if (typeof rootPackage.scripts?.[command] !== "string") {
      throw new Error(`Missing root command: ${command}`);
    }
  }
  for (const command of [
    "build",
    "verify:assets",
    "test:unit",
    "test:browser",
    "typecheck",
    "demo:smoke"
  ]) {
    if (typeof capturePackage.scripts?.[command] !== "string") {
      throw new Error(`Missing capture-web command: ${command}`);
    }
  }
  if (manifest.schemaVersion !== "phenometric.static-assets.v1") {
    throw new Error("Unexpected static-asset manifest schema.");
  }
  const requiredAssets = [
    "faceModel",
    "voiceWorklet",
    "visionWasmScript",
    "visionWasm",
    "visionWasmSimdScript",
    "visionWasmSimd",
    "visionWasmNoSimdScript",
    "visionWasmNoSimd"
  ];
  for (const name of requiredAssets) {
    const asset = manifest.assets?.[name];
    if (
      !asset ||
      typeof asset.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error(`Invalid static-asset entry: ${name}`);
    }
  }
NODE

agent_count="$(find agents -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [[ "$agent_count" != "3" ]]; then
  echo "Expected exactly 3 top-level capability directories; found $agent_count." >&2
  exit 1
fi

tracked_media="$(
  git ls-files |
    grep -E '\.(wav|mp3|m4a|mp4|mov|webm)$' || true
)"
if [[ -n "$tracked_media" ]]; then
  echo "Captured audiovisual files must not be tracked:" >&2
  echo "$tracked_media" >&2
  exit 1
fi

pnpm --filter @phenometrix/capture-web verify:assets

# The pack's contentSha256 is hand-edited hex. The runtime check compares the
# pack against itself, so a stale digest ships to the browser and stamps every
# observation without anything objecting. Fail the gate instead.
npx tsx scripts/protocol-digest.mjs --check

echo "PhenoMetrix ambient-v3 structure and static assets are valid."
