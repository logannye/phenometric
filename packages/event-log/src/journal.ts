import {
  WorkflowEventV1Schema,
  type ProtocolRef,
  type WorkflowEventInputV1,
  type WorkflowEventV1,
  type WorkflowStageV1
} from "@phenometrix/contracts";

export interface EventJournalOptions {
  sessionId: string;
  subjectRef: string;
  protocolRef: ProtocolRef;
  clock?: () => Date;
  idGenerator?: () => string;
}

export interface WorkflowReplayState {
  sessionId: string | null;
  subjectRef: string | null;
  stage: WorkflowStageV1 | "empty";
  eventCount: number;
  lastSequence: number;
  lastEventId: string | null;
  observationId: string | null;
  reportId: string | null;
  recordedMetricCodes: string[];
  withheldMetricCodes: string[];
}

export class EventJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventJournalError";
  }
}

function sameProtocol(left: ProtocolRef, right: ProtocolRef): boolean {
  return (
    left.packId === right.packId &&
    left.version === right.version &&
    left.contentSha256 === right.contentSha256
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateSequence(
  events: readonly WorkflowEventV1[],
  expected?: Pick<EventJournalOptions, "sessionId" | "subjectRef" | "protocolRef">
): void {
  const ids = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let boundary:
    | Pick<EventJournalOptions, "sessionId" | "subjectRef" | "protocolRef">
    | undefined = expected;
  events.forEach((eventInput, index) => {
    const event = WorkflowEventV1Schema.parse(eventInput);
    boundary ??= {
      sessionId: event.sessionId,
      subjectRef: event.subjectRef,
      protocolRef: event.protocolRef
    };
    if (event.sequence !== index + 1) {
      throw new EventJournalError(
        `Expected sequence ${index + 1}, received ${event.sequence}.`
      );
    }
    if (ids.has(event.eventId)) {
      throw new EventJournalError(`Duplicate event ID ${event.eventId}.`);
    }
    if (
      (event.sessionId !== boundary.sessionId ||
        event.subjectRef !== boundary.subjectRef ||
        !sameProtocol(event.protocolRef, boundary.protocolRef))
    ) {
      throw new EventJournalError(
        "Event does not belong to this session and protocol."
      );
    }
    const timestamp = Date.parse(event.occurredAt);
    if (timestamp < previousTimestamp) {
      throw new EventJournalError("Event timestamps must not move backward.");
    }
    if (event.causedByEventId && !ids.has(event.causedByEventId)) {
      throw new EventJournalError(
        `Causal event ${event.causedByEventId} must already exist.`
      );
    }
    for (const ref of event.evidenceRefs) {
      if (
        ref.sessionId !== event.sessionId ||
        !sameProtocol(ref.protocolRef, event.protocolRef)
      ) {
        throw new EventJournalError(
          "Event evidence reference crosses a session or protocol boundary."
        );
      }
    }
    ids.add(event.eventId);
    previousTimestamp = timestamp;
  });
}

export function replayWorkflowEvents(
  eventInputs: readonly WorkflowEventV1[]
): Readonly<WorkflowReplayState> {
  validateSequence(eventInputs);
  const events = eventInputs.map((event) =>
    WorkflowEventV1Schema.parse(event)
  );
  const first = events[0];
  const state: WorkflowReplayState = {
    sessionId: first?.sessionId ?? null,
    subjectRef: first?.subjectRef ?? null,
    stage: events.at(-1)?.stage ?? "empty",
    eventCount: events.length,
    lastSequence: events.at(-1)?.sequence ?? 0,
    lastEventId: events.at(-1)?.eventId ?? null,
    observationId: null,
    reportId: null,
    recordedMetricCodes: [],
    withheldMetricCodes: []
  };
  const recorded = new Set<string>();
  const withheld = new Set<string>();
  for (const event of events) {
    if (event.sessionId !== state.sessionId || event.subjectRef !== state.subjectRef) {
      throw new EventJournalError("Replay contains more than one session.");
    }
    if (event.type === "measurement.recorded") {
      recorded.add(event.payload.metricCode);
    } else if (event.type === "measurement.withheld") {
      withheld.add(event.payload.metricCode);
    } else if (event.type === "observation.created") {
      state.observationId = event.payload.observationId;
    } else if (event.type === "report.created") {
      state.observationId = event.payload.observationId;
      state.reportId = event.payload.reportId;
    }
  }
  state.recordedMetricCodes = [...recorded].sort();
  state.withheldMetricCodes = [...withheld].sort();
  return deepFreeze(state);
}

export class InMemoryEventJournal {
  readonly #sessionId: string;
  readonly #subjectRef: string;
  readonly #protocolRef: ProtocolRef;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #events: WorkflowEventV1[] = [];
  #disposed = false;

  constructor(options: EventJournalOptions) {
    this.#sessionId = options.sessionId;
    this.#subjectRef = options.subjectRef;
    this.#protocolRef = structuredClone(options.protocolRef);
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  append(input: WorkflowEventInputV1): Readonly<WorkflowEventV1> {
    if (this.#disposed) {
      throw new EventJournalError("Cannot append to a disposed journal.");
    }
    if (
      input.sessionId !== this.#sessionId ||
      input.subjectRef !== this.#subjectRef ||
      !sameProtocol(input.protocolRef, this.#protocolRef)
    ) {
      throw new EventJournalError(
        "Event does not belong to this session and protocol."
      );
    }
    const event = WorkflowEventV1Schema.parse({
      ...structuredClone(input),
      schemaVersion: "phenometric.workflow-event.v1",
      eventId: this.#idGenerator(),
      sequence: this.#events.length + 1,
      occurredAt: this.#clock().toISOString()
    });
    validateSequence([...this.#events, event], {
      sessionId: this.#sessionId,
      subjectRef: this.#subjectRef,
      protocolRef: this.#protocolRef
    });
    const immutable = deepFreeze(structuredClone(event)) as WorkflowEventV1;
    this.#events.push(immutable);
    return immutable;
  }

  snapshot(): readonly Readonly<WorkflowEventV1>[] {
    return Object.freeze([...this.#events]);
  }

  replay(): Readonly<WorkflowReplayState> {
    return replayWorkflowEvents(this.#events);
  }

  dispose(): void {
    this.#events.splice(0, this.#events.length);
    this.#disposed = true;
  }

  get disposed(): boolean {
    return this.#disposed;
  }
}
