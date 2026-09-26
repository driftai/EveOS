# Durable Dex inbox: ordering and recovery addendum

Every authenticated out-of-band room SEND has an independent stable request ID and is written to localhost's durable FIFO before acknowledgement. An identical request ID is idempotent; using it for another payload or room is rejected. Concurrent admission is serialized. A receipt saying *queued* confirms local commit, not remote delivery or model processing.

During a running or recovering turn, incoming reports wait in FIFO order and do not interrupt the provider gesture. At the next safe turn boundary, only consecutive reports targeting the same exact member may be batched. Every queued report retains its admission-time recipient. If that recipient is temporarily disabled, keep the report queued; do not reroute it to the sending member. A blocked room does not starve other rooms with runnable entries. A stale browser snapshot cannot clear queued messages.

When an agent sends NOTE, that round-robin conversation ends. Later fresh authorized SEND reports can start a new relay after the old turn has settled; the stopped turn is never replayed. The complete task report must either arrive as a new authorized SEND or through the existing explicitly registered local task-completion facility. An empty Antigravity input prompt with a positive /tasks counter is not evidence that local background work finished.

Read-only room_log and room_budget requests bypass waiting for a previous turn's control origin. A direct room SEND does not create an additional pending origin-control receipt after response_final. No manual or automatic replay is permitted for uncertain prior dispatches. Post-idle deployment and separate background notification injection wait until durable queue entries clear.

The queue is bounded to eight unconsumed requests per room. Reject overflow without appending a room message. Preserve request IDs, transcript anchors, pending/recovery journals and context override flags. Verify full local Node tests, root smoke, guardrails, AI-control and a fresh headed one-submission relay before production deployment.
