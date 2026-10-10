"""Broker-level control-plane preemption for managed Spotify starts.

Proves the ownership boundary rather than unit-testing cancelLeases: a newer accepted playback
intent interrupts an in-flight start *before* waiting on the broker ``_transport_lock``, and an
older intent queued behind that lock performs no browser transport work once it obtains it.
"""
from __future__ import annotations

import pathlib
import socket
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server_modules import audioflix_spotify_broker as mod  # noqa: E402
from server_modules import audioflix_spotify_browser_rpc as rpc  # noqa: E402
from server_modules import audioflix_spotify_browser as browser  # noqa: E402

HOLD_S = 4.0  # stands in for the 15.5s helper start lease


class SlowStartEngine:
    """Helper stand-in: Play blocks like a slow start until an interrupt aborts it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.calls, self.interrupts = [], []
        self.generation = 0
        self.spotify_id = ""
        self.play_entered = threading.Event()
        self.abort = threading.Event()
        self.hold_next_play = True
        self.abort_on_interrupt = True
        self.hold_startup = False
        self.startup_entered = threading.Event()
        self.release_startup = threading.Event()

    def ensure_engine(self, page_url):
        if self.hold_startup:
            # First managed-browser launch (budget up to 135s); the helper cannot be interrupted.
            self.hold_startup = False
            self.startup_entered.set()
            self.release_startup.wait(HOLD_S)
        return {"ok": True, "helperReachable": True, "engineStartedAt": 1000, "authState": "signed-in",
                "browserRunning": True, "presentation": "hidden"}

    def status(self):
        return {"ok": True, "helperReachable": True, "engineStartedAt": 1000, "authState": "signed-in",
                "browserRunning": True, "state": "ready", "presentation": "hidden"}

    def set_effective_volume(self, volume, track_id=""):
        with self.lock:
            self.calls.append(("volume", track_id, time.monotonic()))
        return {"ok": True}

    def interrupt(self, reason):
        with self.lock:
            self.interrupts.append((reason, time.monotonic()))
        if self.abort_on_interrupt:
            self.abort.set()
        return {"ok": True, "interrupted": True, "reason": reason}

    def transport(self, payload=None):
        payload = dict(payload or {})
        action = payload.get("action")
        with self.lock:
            self.calls.append((action, payload.get("spotifyId") or self.spotify_id, time.monotonic()))
            if action == "load":
                self.generation = payload.get("generation", self.generation + 1)
                self.spotify_id = payload.get("spotifyId", "")
            hold = action == "play" and self.hold_next_play
            if hold:
                self.hold_next_play = False
        state = {"generation": self.generation, "spotifyId": self.spotify_id, "status": "starting"}
        if hold:
            self.play_entered.set()
            aborted = self.abort.wait(HOLD_S)
            if aborted:
                return {"ok": False, "lifecycle": "superseded", "superseded": True, "state": state}
        if action == "play":
            state["status"] = "playing"
        if action in {"pause", "stop"}:
            state["status"] = "paused" if action == "pause" else "stopped"
        return {"ok": True, "state": state}

    def reset(self):
        self.calls, self.interrupts = [], []
        self.play_entered.clear()
        self.abort.clear()
        self.hold_next_play = True
        self.abort_on_interrupt = True
        self.hold_startup = False
        self.startup_entered.clear()
        self.release_startup.clear()


real_interrupt = rpc.interrupt
fake = SlowStartEngine()
for name in ("ensure_engine", "status", "set_effective_volume", "transport", "interrupt"):
    setattr(mod.engine, name, getattr(fake, name))

context = {"serverOrigin": "http://127.0.0.1:8765"}


def new_broker():
    broker = mod.SpotifyClientBroker()
    grant = broker.connect({"mode": "localhost", "parentOrigin": "http://127.0.0.1:8765",
                            "documentId": "doc", "libraryScopeId": "origin:http://127.0.0.1:8765"}, context)
    assert grant["ok"] and grant["clientToken"], grant
    return broker, grant


SEQ = [0]


def send(broker, grant, action, payload=None):
    SEQ[0] += 1
    return broker.command({"clientToken": grant["clientToken"], "command": {
        "connectionId": grant["connectionId"], "action": action, "payload": dict(payload or {}),
        "commandId": f"cmd-{SEQ[0]}", "clientCommandSeq": SEQ[0]}}, context)


def spawn(results, key, fn):
    thread = threading.Thread(target=lambda: results.__setitem__(key, fn()), daemon=True)
    thread.start()
    return thread


def browser_work_for(track):
    return [c for c in fake.calls if c[0] in {"load", "play"} and c[1] == track]


A, B = "4cOdK2wGLETKBW3PvgPWqT", "7ouMYWpwJ422jRcDASZB7P"

# 3. Stale queued command: Play A keeps the lock for its whole window (its interrupt is ignored,
# as if the helper start were past help), while Play B then Pause are accepted behind the lock.
fake.reset()
fake.abort_on_interrupt = False
broker, grant = new_broker()
results = {}
t_a = spawn(results, "a", lambda: send(broker, grant, "play", {"spotifyId": A, "duration": 180}))
assert fake.play_entered.wait(3), "Play A reached its slow start"
t_b = spawn(results, "b", lambda: send(broker, grant, "play", {"spotifyId": B, "duration": 180}))
time.sleep(0.2)
t_p = spawn(results, "p", lambda: send(broker, grant, "pause"))
for thread in (t_a, t_b, t_p):
    thread.join(HOLD_S + 3)
assert results["b"].get("superseded") and results["b"].get("lifecycle") == "superseded", results["b"]
assert browser_work_for(B) == [], f"stale Play B did browser work: {browser_work_for(B)}"
assert results["p"].get("ok"), results["p"]
assert [r for r, _ in fake.interrupts] == ["superseded", "paused"], fake.interrupts

# 4. A -> B supersession: B's accepted intent interrupts A before B waits for serialization,
# then B's ordinary generation/Load ownership proceeds.
fake.reset()
broker, grant = new_broker()
results = {}
t_a = spawn(results, "a", lambda: send(broker, grant, "play", {"spotifyId": A, "duration": 180}))
assert fake.play_entered.wait(3)
accepted = time.monotonic()
t_b = spawn(results, "b", lambda: send(broker, grant, "play", {"spotifyId": B, "duration": 180}))
t_a.join(HOLD_S + 3)
t_b.join(HOLD_S + 3)
assert fake.interrupts and fake.interrupts[0][0] == "superseded"
assert fake.interrupts[0][1] - accepted < 1.0, "interrupt is not trapped behind the transport lock"
assert results["a"].get("superseded")
assert results["b"].get("ok"), results["b"]
loads = [c for c in fake.calls if c[0] == "load"]
assert [c[1] for c in loads] == [A, B] and fake.generation == 2

# 5. Switching away (Stop) during a slow start: Stop preempts within the interrupt bound rather
# than after the start window, then the authoritative Stop runs normally.
fake.reset()
broker, grant = new_broker()
results = {}
t_a = spawn(results, "a", lambda: send(broker, grant, "play", {"spotifyId": A, "duration": 180}))
assert fake.play_entered.wait(3)
accepted = time.monotonic()
t_s = spawn(results, "s", lambda: send(broker, grant, "stop"))
t_a.join(HOLD_S + 3)
t_s.join(HOLD_S + 3)
assert fake.interrupts and fake.interrupts[0][0] == "stopped"
assert fake.interrupts[0][1] - accepted < 1.0
a_done = max(c[2] for c in fake.calls if c[0] == "play")
assert a_done - accepted < HOLD_S, "old start did not hold the lock for its remaining window"
assert results["s"].get("ok") and any(c[0] == "stop" for c in fake.calls)

# Authorization: an observer's Pause can neither interrupt nor fence the owner's start.
fake.reset()
broker, owner = new_broker()
observer = broker.connect({"mode": "localhost", "parentOrigin": "http://127.0.0.1:8765",
                           "documentId": "doc-2", "libraryScopeId": "origin:http://127.0.0.1:8765"}, context)
results = {}
t_a = spawn(results, "a", lambda: send(broker, owner, "play", {"spotifyId": A, "duration": 180}))
assert fake.play_entered.wait(3)
spawn(results, "o", lambda: send(broker, observer, "pause")).join(HOLD_S + 3)
t_a.join(HOLD_S + 3)
assert fake.interrupts == [], f"observer interrupted the owner: {fake.interrupts}"
assert results["o"].get("ok") is False and results["o"].get("observer"), results["o"]
assert results["a"].get("ok"), results["a"]

# First-launch window: Play A is inside ensure_engine() with no owner yet. The helper interrupt
# is best-effort here (helper not up), so the broker fence alone must stop A after startup.
def playback_work():
    return [c for c in fake.calls if c[0] in {"load", "play", "volume"}]


for label, cancel in (("stop", "stop"), ("pause", "pause"), ("play-b", "play")):
    fake.reset()
    fake.hold_next_play = False
    fake.abort_on_interrupt = False
    fake.hold_startup = True
    broker, grant = new_broker()
    observer = broker.connect({"mode": "localhost", "parentOrigin": "http://127.0.0.1:8765",
                               "documentId": f"obs-{label}", "libraryScopeId": "origin:http://127.0.0.1:8765"}, context)
    results = {}
    t_a = spawn(results, "a", lambda: send(broker, grant, "play", {"spotifyId": A, "duration": 180}))
    assert fake.startup_entered.wait(3), label
    assert broker._owner_client_id == "", "Play A has not acquired ownership during startup"
    # An observer never gains cancellation authority in the ownerless window.
    t_o = spawn(results, "o", lambda: send(broker, observer, "stop" if cancel != "play" else "pause"))
    time.sleep(0.2)
    assert fake.interrupts == [], f"{label}: observer interrupted the pending first Play"
    payload = {"spotifyId": B, "duration": 180} if cancel == "play" else {}
    t_c = spawn(results, "c", lambda: send(broker, grant, cancel, payload))
    time.sleep(0.2)
    expected = {"stop": "stopped", "pause": "paused", "play": "superseded"}[cancel]
    assert [r for r, _ in fake.interrupts] == [expected], f"{label}: {fake.interrupts}"
    fake.release_startup.set()
    for thread in (t_a, t_o, t_c):
        thread.join(HOLD_S + 3)
    assert results["a"].get("superseded") and results["a"].get("lifecycle") == "superseded", (label, results["a"])
    assert browser_work_for(A) == [] and not [c for c in fake.calls if c[0] == "volume" and c[1] == A], \
        f"{label}: stale first Play did post-startup work: {playback_work()}"
    if cancel == "play":
        assert results["c"].get("ok") and results["c"].get("isOwner"), results["c"]
        assert [c[1] for c in fake.calls if c[0] == "load"] == [B]
        assert fake.generation == broker._track_generation and broker._owner_client_id == grant["clientId"]
    else:
        assert playback_work() == [], f"{label}: {playback_work()}"
        assert broker._owner_client_id == "", f"{label}: stale Play acquired ownership"

# 6. Interrupt endpoint unavailable: dead and hung helpers stay bounded and harmless.
manager = browser._manager
saved = (manager._port, manager._token, manager._process_running)
try:
    manager._token = "x" * 32
    manager._process_running = lambda: True
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        manager._port = probe.getsockname()[1]
    started = time.monotonic()
    dead = real_interrupt("paused")
    assert dead.get("ok") is False and time.monotonic() - started < 1.0, dead
    hung = socket.socket()
    hung.bind(("127.0.0.1", 0))
    hung.listen(1)
    manager._port = hung.getsockname()[1]
    started = time.monotonic()
    stalled = real_interrupt("stopped")
    assert stalled.get("ok") is False, stalled
    assert time.monotonic() - started < rpc.INTERRUPT_TIMEOUT_S + 1.0
    hung.close()
    assert real_interrupt("load").get("ok") is False, "only fixed interrupt reasons are accepted"
finally:
    manager._port, manager._token, manager._process_running = saved

# The broker path stays harmless when the interrupt itself fails.
fake.reset()
broken = mod.SpotifyClientBroker()
grant = broken.connect({"mode": "localhost", "parentOrigin": "http://127.0.0.1:8765",
                        "documentId": "doc-3", "libraryScopeId": "origin:http://127.0.0.1:8765"}, context)
mod.engine.interrupt = lambda reason: (_ for _ in ()).throw(RuntimeError("helper gone"))
results = {}
t_a = spawn(results, "a", lambda: send(broken, grant, "play", {"spotifyId": A, "duration": 180}))
assert fake.play_entered.wait(3)
t_s = spawn(results, "s", lambda: send(broken, grant, "stop"))
t_a.join(HOLD_S + 3)
t_s.join(HOLD_S + 3)
assert not t_a.is_alive() and not t_s.is_alive(), "no deadlock when the interrupt fails"
assert results["s"].get("ok"), results["s"]

print("AUDIOFLIX_SPOTIFY_PREEMPTION_SMOKE_OK (pre-lock interrupt, stale queued fence, A->B, stop, observer, first-launch fence, dead/hung endpoint)")
