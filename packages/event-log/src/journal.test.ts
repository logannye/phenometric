import { describe, expect, it } from "vitest";
import {
  AMBIENT_LOCAL_PROTOCOL_REF,
  type WorkflowEventInputV1,
  type WorkflowEventV1
} from "@phenometrix/contracts";
import {
  EventJournalError,
  InMemoryEventJournal,
  replayWorkflowEvents
} from "./journal.js";

function journal() {
  let clockTick = 0;
  let idTick = 0;
  return new InMemoryEventJournal({
    sessionId: "session-journal",
    subjectRef: "subject-session-journal",
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    clock: () => new Date(Date.UTC(2026, 6, 20, 16, 0, clockTick++)),
    idGenerator: () =>
      `00000000-0000-4000-8000-${(++idTick).toString().padStart(12, "0")}`
  });
}

function consentInput(): WorkflowEventInputV1 {
  return {
    sessionId: "session-journal",
    subjectRef: "subject-session-journal",
    protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
    actor: { kind: "application", id: "capture-web", version: "1.0.0" },
    type: "consent.recorded",
    stage: "requesting-permission",
    summary: "Local in-memory consent recorded.",
    payload: { consentId: "consent-journal" },
    evidenceRefs: []
  };
}

describe("InMemoryEventJournal", () => {
  it("assigns immutable UUID events and validates causal append order", () => {
    const store = journal();
    const consent = store.append(consentInput());
    const permission = store.append({
      sessionId: "session-journal",
      subjectRef: "subject-session-journal",
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      actor: { kind: "application", id: "capture-web", version: "1.0.0" },
      type: "capture.permission.requested",
      stage: "requesting-permission",
      summary: "Requested local media permission.",
      payload: { modalities: ["voice", "face"] },
      evidenceRefs: [],
      causedByEventId: consent.eventId
    });

    expect(consent.sequence).toBe(1);
    expect(permission.sequence).toBe(2);
    expect(Object.isFrozen(consent)).toBe(true);
    expect(Object.isFrozen(consent.payload)).toBe(true);
    expect(() => {
      (consent.payload as { consentId: string }).consentId = "changed";
    }).toThrow();
    expect(store.snapshot()).toHaveLength(2);
  });

  it("rejects cross-session and missing causal references", () => {
    const store = journal();
    expect(() =>
      store.append({ ...consentInput(), sessionId: "other-session" })
    ).toThrow(EventJournalError);
    expect(() =>
      store.append({
        ...consentInput(),
        causedByEventId: "00000000-0000-4000-8000-999999999999"
      })
    ).toThrow(/must already exist/);
  });

  it("replays deterministically and rejects altered ordering", () => {
    const store = journal();
    store.append(consentInput());
    store.append({
      sessionId: "session-journal",
      subjectRef: "subject-session-journal",
      protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
      actor: { kind: "processor", id: "voice-analysis", version: "1.0.0" },
      type: "measurement.withheld",
      stage: "finalizing",
      summary: "Pitch metric was not measurable.",
      payload: {
        outcomeId: "outcome-f0",
        aggregateId: "aggregate-f0",
        metricCode: "ambient.voice.f0.median",
        reasonCode: "insufficient-duration"
      },
      evidenceRefs: []
    });

    expect(store.replay()).toMatchObject({
      eventCount: 2,
      lastSequence: 2,
      stage: "finalizing",
      withheldMetricCodes: ["ambient.voice.f0.median"]
    });
    expect(store.replay()).toEqual(store.replay());

    const altered = structuredClone(store.snapshot()) as WorkflowEventV1[];
    altered[1].sequence = 8;
    expect(() => replayWorkflowEvents(altered)).toThrow(/sequence 2/);
  });

  it("clears session state and permanently closes on dispose", () => {
    const store = journal();
    store.append(consentInput());
    store.dispose();
    expect(store.snapshot()).toEqual([]);
    expect(store.disposed).toBe(true);
    expect(() => store.append(consentInput())).toThrow(/disposed/);
  });
});
