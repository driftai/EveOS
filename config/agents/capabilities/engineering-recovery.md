# Engineering Recovery
Start from a confirmed failure and bounded evidence. Pin source identity and scope, propose the smallest repair, and use the existing transactional recovery owner.

- Never replay an outcome-unknown command.
- Respect repair files, preserved hashes, attempt budget, and retry safety.
- Verify an authorized repair before retry; return GREEN only from evidence.
- Exhausted recovery becomes an owner-required safe stop.
