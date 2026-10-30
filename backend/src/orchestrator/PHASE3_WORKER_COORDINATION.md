# Future worker coordination design

Status: design only. Phase 3 runs one backend process and one Electron ledger writer. The current in-memory session lock is not a distributed lock. Do not deploy multiple backend writers against the current checkpoint files.

## Ownership and storage

Move checkpoints and execution leases into one transactional database before adding workers. A session row contains sessionId, authenticated ownerId, revision, serialized AgentState, leaseOwner, leaseExpiresAt, and monotonically increasing fencingToken. LeaseOwner is a random worker-instance UUID, never a PID. Use database time for expiry, not worker clocks. Keep state serialization and legal transitions in AgentState.

Acquire a lease with one transaction that verifies expectedRevision and ownerId, checks lease expiry, increments fencingToken, and writes the new lease owner and expiry. Renew only when worker instance and fencing token still match. A lost renewal immediately stops scheduling work; expiry does not prove that a previously dispatched side effect stopped.

## Fenced execution protocol

1. In one database transaction, validate the lease and expected revision, persist the AgentState act transition, and insert an outbox request keyed by sessionId and attempt number. The outbox includes requestId, idempotencyKey, toolCallId, ownerId, the canonical action hash, and fencingToken.
2. A dispatcher sends the outbox record to Electron. Electron must independently reject stale fencing tokens and continue to enforce the existing bearer secret, owner scope, idempotency ledger, validation, and confirmation checks. Fencing only at the database is insufficient: a stalled worker could still send an old side effect.
3. Atomically persist the ledger reservation before dispatch. Use a transactional unique constraint on owner scope and idempotencyKey, and another on owner scope and requestId. All Electron processes must share that transactional store, or retain a single elected Electron execution broker.
4. Save the result in the ledger before acknowledging the request. Commit observe/decide with a compare-and-swap of revision and the active lease token. A stale worker may retain raw result evidence, but cannot advance AgentState.
5. On takeover, reconcile every act/observe attempt against the ledger. Never replay solely because a lease expired. Uncertain effects still require the authenticated manual review workflow and evidence that the original operation stopped.

## Confirmation and manual review transactions

Renewal must atomically supersede the previous token and create its replacement under a unique renewal operation ID. Approval consumes the current token in the same transaction that admits its continuation request. Neither duplicate approval nor a stale generation can create another effect. Original action parameters are immutable across the lineage.

Manual review uses a unique review ID and action hash. Write the review and its ledger resolution transactionally, then commit the checkpoint by revision and fencing token. A crash between these commits is recovered from the recorded resolution. Human attestation remains distinguished from automatic proof. Reject review while the original execution is known to be active; a lease expiry is not quiescence evidence.

## Cancellation and release

Persist request cancellation tombstones in shared storage and publish a notification to the execution broker. Cancelling the HTTP response alone is insufficient. The broker checks tombstones before admission and forwards AbortSignal to running handlers. If it cannot establish that side effects stopped, retain uncertain status. Lease release must match worker instance and fencing token so an old worker cannot delete a new worker's lease.

## Required deployment gates

- Race two workers at the same revision: exactly one obtains the lease and creates the outbox request.
- Suspend the old worker, expire its lease, take over, then resume it: both database and broker reject its stale token.
- Crash before dispatch, after dispatch, after ledger persistence, and before checkpoint persistence: no duplicate side effect occurs.
- Deliver approval, renewal, manual review, and cancellation messages repeatedly and out of order: only one operation is admitted and audit history remains consistent.
- Simulate database outage, clock skew, broker partition, and storage corruption: workers stop admitting new effects and retain recoverable evidence.
- Exercise cancellation before reservation and during takeover. Verify durable tombstones and uncertain-effect handling.

This design does not add Windows repair actions, command generation, privilege escalation, rollback, or repair policy. Those remain a separate future Windows Repair phase.
