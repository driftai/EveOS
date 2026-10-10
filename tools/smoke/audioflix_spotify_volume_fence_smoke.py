"""Offline marked-volume fence through the actual broker/RPC/manager and a fake helper."""
from __future__ import annotations

import copy
import json
import pathlib
import sys
import traceback
from collections import Counter
from contextlib import contextmanager
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server_modules import audioflix_spotify_broker as broker_mod  # noqa: E402
from server_modules import audioflix_spotify_browser as browser  # noqa: E402
from server_modules import audioflix_spotify_browser_rpc as rpc  # noqa: E402

URI = "1111111111111111111111"
CONTEXT = {"serverOrigin": "http://127.0.0.1:8765"}
MARKERS = ("ownerEpoch", "engineEpoch", "trackGeneration")
RESOURCES = []


class FakeHelper:
    def __init__(self):
        self.calls = []
        self.transport_present = True
        self.state = {"spotifyId": "", "generation": 0, "status": "paused", "paused": True}

    def request(self, method, route, body=None, timeout=0):
        del timeout
        self.calls.append((method, route, copy.deepcopy(body)))
        if route == "/status":
            result = {"ok": True, "state": "ready", "authState": "signed-in"}
            if self.transport_present:
                result["transport"] = dict(self.state)
            return result
        assert method == "POST"
        if route == "/volume":
            return {"ok": True, "volume": body["volume"]}
        assert route == "/transport", route
        action = body["action"]
        if action == "load":
            self.state.update(spotifyId=body["spotifyId"], generation=body["generation"], status="loaded")
        elif action in {"play", "resume"}:
            self.state.update(status="playing", paused=False)
        elif action == "stop":
            self.state.update(status="stopped", paused=True)
        else:
            assert action == "status", action
        return {"ok": True, "state": dict(self.state)}

    def mutations(self):
        return sum(route == "/volume" for _, route, _ in self.calls)


class Fixture:
    def __init__(self):
        self.helper = FakeHelper()
        self.manager = browser.SpotifyBrowserManager()
        self.manager._process = type("SyntheticProcess", (), {"poll": lambda self: None})()
        self.manager._port, self.manager._token = 31337, "synthetic-private-token"
        self.manager._session_id, self.manager._started_at = "synthetic-private-session", 1000
        self.manager.environment_status = lambda force=False: {}
        self.manager._request = self.helper.request
        self.broker = broker_mod.SpotifyClientBroker()
        self.seq = 0
        self.volume_commands = []
        self.grant = self.connect("owner")

    def connect(self, doc):
        return self.broker.connect({"mode": "localhost", "parentOrigin": CONTEXT["serverOrigin"],
                                   "documentId": doc, "libraryScopeId": "offline-volume-fence"}, CONTEXT)

    def send(self, action, args=None, grant=None, command_id=None):
        self.seq += 1
        grant = grant or self.grant
        before = self.helper.mutations()
        result = self.broker.command({"clientToken": grant["clientToken"], "command": {
            "connectionId": grant["connectionId"], "action": action, "payload": args or {},
            "commandId": command_id or f"fence-{self.seq}", "clientCommandSeq": self.seq,
        }}, CONTEXT)
        if action == "volume":
            self.volume_commands.append({"ok": bool(result.get("ok")),
                "superseded": bool(result.get("superseded")), "helperMutations": self.helper.mutations() - before})
        return result

    def play(self):
        result = self.send("play", {"spotifyId": URI, "effectiveVolume": 0.5})
        assert result["ok"] and result["isOwner"], result
        return result

    def volume(self, state, command_id=None):
        return self.send("volume", {"spotifyId": URI, "effectiveVolume": 0.17,
                                   **{key: state[key] for key in MARKERS}}, command_id=command_id)

    def rejects(self, state, owner_before=None):
        before = self.helper.mutations()
        result = self.volume(state)
        assert not result.get("ok") and result.get("superseded") and result.get("resyncRequired"), result
        assert self.helper.mutations() == before, "stale volume mutated the helper"
        if owner_before is not None:
            assert self.broker._owner_client_id == owner_before, "stale volume acquired ownership"
        return result


@contextmanager
def fixture():
    f = Fixture()
    with patch.object(browser, "_manager", f.manager), patch.object(
            rpc, "ensure_engine", lambda page_url: rpc._with_epoch(f.manager.status())):
        try:
            yield f
        finally:
            RESOURCES.append({"helperRequests": dict(Counter(f"{method} {route}" for method, route, _ in f.helper.calls)),
                              "volumeCommands": f.volume_commands})


def same_uri():
    with fixture() as f:
        old = f.play(); current = f.play()
        assert current["trackGeneration"] > old["trackGeneration"]
        f.rejects(old, f.grant["clientId"])


def observed_restart():
    with fixture() as f:
        old = f.play(); f.manager._started_at += 1
        current = f.send("status")
        assert current["engineEpoch"] > old["engineEpoch"] and not current["isOwner"]
        f.rejects(old, "")


def owner_round_trip():
    with fixture() as f:
        old = f.play(); other = f.connect("other")
        f.send("take-control", grant=other); f.send("take-control")
        f.rejects(old, f.grant["clientId"])


def stopped():
    with fixture() as f:
        old = f.play(); f.send("stop")
        f.rejects(old, "")


def current_markers():
    with fixture() as f:
        current = f.play(); before = f.helper.mutations()
        result = f.volume(current)
        assert result["ok"] and result["isOwner"] and f.helper.mutations() == before + 1


def legacy():
    with fixture() as f:
        f.play(); f.send("stop"); before = f.helper.mutations()
        result = f.send("volume", {"spotifyId": URI, "effectiveVolume": 0.17})
        assert result["ok"] and result["isOwner"] and f.helper.mutations() == before + 1


def malformed():
    with fixture() as f:
        current = f.play()
        valid = {key: current[key] for key in MARKERS}
        cases = [{"ownerEpoch": current["ownerEpoch"]}]
        cases += [{**valid, "trackGeneration": value} for value in (None, True, -1, 1.5, "1")]
        for markers in cases:
            before = f.helper.mutations()
            result = f.send("volume", {"spotifyId": URI, "effectiveVolume": 0.17, **markers})
            assert not result.get("ok") and result.get("resyncRequired"), (markers, result)
            assert f.helper.mutations() == before


def unobserved_restart():
    with fixture() as f:
        old = f.play(); f.manager._started_at += 1
        f.rejects(old, "")


def dispatch_restart():
    with fixture() as f:
        old = f.play()
        actual_volume = rpc.set_effective_volume
        def restart_then_volume(*args, **kwargs):
            f.manager._started_at += 1
            return actual_volume(*args, **kwargs)
        with patch.object(rpc, "set_effective_volume", restart_then_volume):
            f.rejects(old)


def receipt():
    with fixture() as f:
        old = f.play(); f.play(); before = f.helper.mutations()
        first = f.volume(old, "stale-repeat")
        second = f.volume(old, "stale-repeat")
        assert not first["ok"] and first == second and f.helper.mutations() == before


def helper_generation_before_validation():
    with fixture() as f:
        old = f.play(); f.helper.state["generation"] += 1
        f.rejects(old, f.grant["clientId"])
        assert f.broker._track_generation == f.helper.state["generation"], "fresh helper generation was not adopted"
        assert f.volume(f.send("status"))["ok"], "current helper generation must still accept volume"


def helper_generation_before_dispatch():
    with fixture() as f:
        old = f.play()
        actual_volume = rpc.set_effective_volume
        def advance_then_volume(*args, **kwargs):
            f.helper.state["generation"] += 1
            return actual_volume(*args, **kwargs)
        with patch.object(rpc, "set_effective_volume", advance_then_volume):
            f.rejects(old, f.grant["clientId"])


def missing_generation_before_validation():
    with fixture() as f:
        current = f.play(); f.helper.transport_present = False
        f.rejects(current, f.grant["clientId"])
        before = f.helper.mutations()
        result = f.send("volume", {"spotifyId": URI, "effectiveVolume": 0.17})
        assert result["ok"] and f.helper.mutations() == before + 1, "unmarked missing-snapshot compatibility changed"


def missing_generation_before_dispatch():
    with fixture() as f:
        current = f.play()
        actual_volume = rpc.set_effective_volume
        def omit_then_volume(*args, **kwargs):
            f.helper.transport_present = False
            return actual_volume(*args, **kwargs)
        with patch.object(rpc, "set_effective_volume", omit_then_volume):
            f.rejects(current, f.grant["clientId"])


def run():
    checks = {"same-uri-new-generation": same_uri, "observed-helper-restart": observed_restart,
              "ownership-round-trip": owner_round_trip, "stop-no-reclaim": stopped,
              "current-markers": current_markers, "legacy-unmarked": legacy,
              "partial-malformed": malformed, "unobserved-helper-restart": unobserved_restart,
              "validation-dispatch-restart": dispatch_restart, "idempotent-rejection": receipt,
              "helper-generation-before-validation": helper_generation_before_validation,
              "helper-generation-before-dispatch": helper_generation_before_dispatch,
              "missing-generation-before-validation": missing_generation_before_validation,
              "missing-generation-before-dispatch": missing_generation_before_dispatch}
    failures = []
    for name, check in checks.items():
        resource_start = len(RESOURCES)
        try:
            check()
        except Exception:
            failures.append({"id": name, "traceback": traceback.format_exc()})
        for resource in RESOURCES[resource_start:]:
            resource["id"] = name
    phase = "BASELINE" if "--baseline" in sys.argv else "CANDIDATE"
    if "--generation-baseline" in sys.argv:
        phase = "GENERATION-BASELINE"
    artifact = ROOT / f"data/runtime/smoke-results/LAST-AUDIOFLIX-SPOTIFY-VOLUME-FENCE-{phase}.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps({"offline": True, "realBrokerRpcManager": True, "fakeHelper": True,
                                   "passed": len(checks) - len(failures), "total": len(checks),
                                   "failures": failures, "resources": RESOURCES}, indent=2), encoding="utf-8")
    for failure in failures:
        print("VOLUME_FENCE_FAIL " + failure["id"], file=sys.stderr)
        print("\n".join(failure["traceback"].splitlines()[-12:]), file=sys.stderr)
    if failures:
        return 1
    print(f"AUDIOFLIX_SPOTIFY_VOLUME_FENCE_SMOKE_OK tests={len(checks)}/{len(checks)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
