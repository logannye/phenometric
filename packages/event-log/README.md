# Session-only workflow event journal

`@phenometrix/event-log` is the in-memory journal for the standalone ambient
prototype. It accepts only the discriminated
`phenometric.workflow-event.v1` contract from `@phenometrix/contracts`.

The journal:

- assigns UUID event IDs and monotonic, one-based session sequence numbers;
- validates every event at runtime before append;
- rejects cross-session, cross-protocol, duplicate, backward-timestamp, and
  unresolved causal references;
- recursively freezes accepted events;
- returns immutable snapshots and a deterministic replay projection; and
- clears all retained events and permanently closes when disposed.

It is deliberately not a durable audit store. It does not write JSONL, local
storage, IndexedDB, a server, or raw media. Resetting or reloading the app ends
the journal's lifetime.

```ts
import { AMBIENT_LOCAL_PROTOCOL_REF } from "@phenometrix/contracts";
import { InMemoryEventJournal } from "@phenometrix/event-log";

const journal = new InMemoryEventJournal({
  sessionId: "session-local-1",
  subjectRef: "subject-session-local-1",
  protocolRef: AMBIENT_LOCAL_PROTOCOL_REF
});

const event = journal.append({
  sessionId: "session-local-1",
  subjectRef: "subject-session-local-1",
  protocolRef: AMBIENT_LOCAL_PROTOCOL_REF,
  actor: { kind: "application", id: "capture-web", version: "1.0.0" },
  type: "consent.recorded",
  stage: "requesting-permission",
  summary: "Local in-memory consent recorded.",
  payload: { consentId: "consent-local-1" },
  evidenceRefs: []
});

journal.replay();
journal.dispose();
```
