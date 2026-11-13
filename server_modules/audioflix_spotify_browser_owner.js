'use strict';

// A new web server can answer on the old port before the old helper's 30s HTTP
// liveness grace period expires. Bind the helper to its original Python owner.
// Signal 0 is a non-destructive process existence probe on Windows and POSIX.
function ownerAlive(pid, probe = process.kill.bind(process)) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try { probe(pid, 0); return true; } catch { return false; }
}

module.exports = { ownerAlive };
