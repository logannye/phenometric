import { expect, test, type Page, type Request } from "@playwright/test";
import {
  ambientProbe,
  installAmbientBrowserFixture,
  resolveLateAudio
} from "./ambient-browser-fixture.js";

const appUrl = "/phenometric/";

async function consentAndStart(page: Page): Promise<void> {
  await page.locator("#consent-checkbox").check();
  await expect(page.locator("#start-button")).toBeEnabled();
  await page.locator("#start-button").click();
}

async function startAudioOnlyObservation(page: Page): Promise<void> {
  await consentAndStart(page);
  await expect(page.locator("#phase-label")).toHaveText("Ambient session", {
    timeout: 15_000
  });
}

test("consent gates ambient setup and states the implemented boundary", async ({
  page
}) => {
  await installAmbientBrowserFixture(page, "deny-all");
  await page.goto(appUrl);

  await expect(page.locator("#welcome-title")).toHaveText(
    "Observe the conversation, locally."
  );
  await expect(page.getByText("Nonclinical prototype")).toBeVisible();
  await expect(page.getByText("No recording or upload")).toBeVisible();
  await expect(page.locator("#start-button")).toBeDisabled();
  await page.locator("#consent-checkbox").check();
  await expect(page.locator("#start-button")).toBeEnabled();
});

test("permission denial creates no report and leaves devices off", async ({
  page
}) => {
  await installAmbientBrowserFixture(page, "deny-all");
  await page.goto(appUrl);
  await consentAndStart(page);

  await expect(page.locator("#message-title")).toHaveText("Session unavailable");
  await expect(page.locator("#message-detail")).toContainText(
    "no report was created"
  );
  await expect(page.locator("#report-view")).toBeHidden();
  await expect(page.locator("#privacy-state")).toHaveText("Devices off");
  expect((await ambientProbe(page)).trackStops).toBe(0);
});

test("audio calibration starts observation while face abstains independently", async ({
  page
}) => {
  await installAmbientBrowserFixture(page, "audio-only");
  await page.goto(appUrl);
  await startAudioOnlyObservation(page);

  await expect(page.locator("#audio-lane-state")).toHaveText("Ready");
  await expect(page.locator("#face-lane-state")).toHaveText("Not measurable");
  await expect(page.locator("#finish-button")).toBeEnabled();
  await expect(page.locator("#capture-instruction")).toContainText(
    "No exercises or scripted prompts"
  );
});

test("dual-lane capture shows the live face mesh and bounded voice dashboard", async ({
  page
}) => {
  await installAmbientBrowserFixture(page, "dual-lane");
  await page.goto(appUrl);
  await consentAndStart(page);
  await expect(page.locator("#phase-label")).toHaveText("Ambient session", {
    timeout: 15_000
  });

  await expect(page.locator("#face-mesh-status")).toHaveText(
    "◆ TRACKING · 478 pts"
  );
  await expect(page.locator("#landmark-overlay")).toBeVisible();
  await expect(page.locator("#voice-live-state")).toHaveText(
    "Quiet/background"
  );
  await expect(page.locator("#voice-live-state")).toHaveText(
    "Speech/noise",
    { timeout: 1_500 }
  );
  await expect(page.locator("#voice-live-state")).toHaveText(
    "Voiced speech",
    { timeout: 1_500 }
  );
  await expect(page.locator("#voice-pitch-value")).toContainText("Hz");
  await expect(page.locator("#voice-level-value")).toContainText("dBFS");
  await expect(page.locator("#voice-energy-chart")).toHaveAttribute(
    "data-sample-count",
    "800",
    { timeout: 2_000 }
  );

  // NOTE: this fixture (ambient-browser-fixture.ts) replaces window.Worker
  // with a same-thread WorkerMock, so the real face-worker.ts (renderer
  // selection, rAF loop, drawFrame canvas resize) never runs here. This
  // poll only confirms the #landmark-overlay <canvas> element is present
  // and attached to the DOM — it does NOT exercise the WebGL2/2D renderer
  // or rAF-driven buffer sizing. Live mesh rendering is verified manually
  // via `pnpm dev`, not by this smoke test.
  const overlay = page.locator("#landmark-overlay");
  await expect
    .poll(async () => overlay.evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(0);

  // Telemetry: the gauges + waveform canvases attach and a live readout
  // populates (replacing the "—" placeholder) during dual-lane capture.
  await expect(page.locator("#voice-level-gauge")).toBeAttached();
  await expect(page.locator("#voice-energy-chart")).toBeAttached();
  await expect(page.locator("#voice-clarity-chart")).toBeAttached();
  await expect
    .poll(async () => page.locator("#voice-level-value").textContent())
    .not.toBe("—");

  await page.locator("#discard-button").click();
  await expect(page.locator("#message-title")).toHaveText("Session discarded");
  await expect(page.locator("#landmark-overlay")).toBeHidden();
  await expect(page.locator("#face-mesh-status")).toBeHidden();
  await expect(page.locator("#voice-energy-chart")).toHaveAttribute(
    "data-sample-count",
    "0"
  );
  await expect.poll(async () => await ambientProbe(page)).toMatchObject({
    trackStops: 2,
    audioContextsClosed: 1,
    workersTerminated: 2
  });
});

test("ambient finalization creates the bounded report without upload or persistence", async ({
  page
}) => {
  const requests: Array<Pick<Request, "url" | "method">> = [];
  page.on("request", (request) => requests.push(request));
  await installAmbientBrowserFixture(page, "audio-only");
  await page.goto(appUrl);
  await startAudioOnlyObservation(page);
  await page.locator("#finish-button").click();

  await expect(page.locator("#report-title")).toHaveText(
    "Ambient session measurement report"
  );
  await expect(page.locator(".report-section")).toHaveCount(10);
  await expect(page.locator(".metric-row")).toHaveCount(27);
  await expect(page.locator("#report-boundary")).toContainText(
    "not intended for medical decisions or longitudinal comparison"
  );
  const pitch = page.locator(
    '[data-metric-code="ambient.voice.f0.median"]'
  );
  await expect(pitch.locator(".metric-value strong")).toHaveText(
    "Not measurable"
  );
  await pitch.locator("summary").click();
  await expect(pitch.locator(".trace-grid")).toContainText("no-usable-signal");

  const origin = new URL(page.url()).origin;
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.every(
      (request) => request.method() === "GET" && request.url().startsWith(origin)
    )
  ).toBe(true);
  expect(
    await page.evaluate(async () => ({
      localStorage: localStorage.length,
      sessionStorage: sessionStorage.length,
      indexedDatabases:
        typeof indexedDB.databases === "function"
          ? (await indexedDB.databases()).length
          : 0
    }))
  ).toEqual({ localStorage: 0, sessionStorage: 0, indexedDatabases: 0 });
  expect(await ambientProbe(page)).toMatchObject({
    trackStops: 1,
    audioContextsClosed: 1,
    workersTerminated: 1
  });
});

test("discard, withdrawal, and late media resolution release resources", async ({
  page
}) => {
  await test.step("a late stream is stopped after discard", async () => {
    await installAmbientBrowserFixture(page, "late-audio");
    await page.goto(appUrl);
    await consentAndStart(page);
    await expect(page.locator("#phase-label")).toHaveText("Requesting devices");
    await page.locator("#discard-button").click();
    await resolveLateAudio(page);
    await expect(page.locator("#message-title")).toHaveText("Session discarded");
    await expect.poll(async () => (await ambientProbe(page)).trackStops).toBe(1);
    await expect(page.locator("#report-view")).toBeHidden();
  });

  await test.step("withdrawing consent disposes an active session", async () => {
    await installAmbientBrowserFixture(page, "audio-only");
    await page.goto(appUrl);
    await startAudioOnlyObservation(page);
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLInputElement>(
        "#consent-checkbox"
      );
      if (!checkbox) throw new Error("Consent checkbox is unavailable.");
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator("#message-title")).toHaveText("Session discarded");
    await expect.poll(async () => (await ambientProbe(page)).trackStops).toBe(1);
    await expect(page.locator("#report-view")).toBeHidden();
  });
});
