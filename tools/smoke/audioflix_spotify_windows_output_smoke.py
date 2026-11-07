"""Deterministic, non-Windows tests for the strict app-output ownership boundary."""
from dataclasses import dataclass
from pathlib import Path
import sys
from server_modules.audioflix_spotify_windows_output import NativeWindowsBackend, OwnedWindowsRoute, resolve_output
from server_modules.audioflix_spotify_direct import SpotifyDirectManager

@dataclass
class Endpoint:
    id: str
    name: str

class PortAudio:
    def query_devices(self, index):
        assert index == 7
        return {"name": "CABLE Input (VB-Audio Virtual C", "max_output_channels": 2}

class FakeBackend:
    def __init__(self):
        self.assignment = None
        self.changed = []
        self.gains = []
    def resolve(self, sd_id):
        return resolve_output(sd_id, PortAudio(), [Endpoint("{A}", "CABLE Input (VB-Audio Virtual Cable)")])
    def get(self, pid):
        assert pid == 127
        return self.assignment
    def set(self, pid, endpoint):
        assert pid == 127
        self.assignment = endpoint
        self.changed.append(endpoint)
    def volume(self, pid, gain):
        assert pid == 127
        self.gains.append(gain)
        return 1

class ProcessTreeBackend(FakeBackend):
    def __init__(self):
        super().__init__()
        self.assignments = {128: None}
    def process_ids(self, root_pid):
        assert root_pid == 127
        return [127, 128]
    def get(self, pid):
        if pid == 127:
            raise ValueError("main process has no audio policy identity")
        return self.assignments[pid]
    def set(self, pid, endpoint):
        assert pid == 128
        self.assignments[pid] = endpoint
    def volume(self, pid, gain, target=None):
        assert pid == 127 and target == "{A}"
        return 1

class CommandRoute:
    def __init__(self):
        self.pid = 0
        self.assigned_pids = set()
        self.applies = []
    def apply(self, pid, device_id):
        self.pid = pid
        self.assigned_pids.add(pid)
        self.applies.append((pid, device_id))
        return {"ok": True, "assignedPids": [pid]}
    def volume(self, gain):
        return {"ok": True, "sessions": 1, "gain": gain}

def run():
    requirements = Path("requirements.txt").read_text(encoding="utf-8")
    assert "winappaudiorouter==1.1.1" in requirements
    if sys.platform == "win32":
        backend = NativeWindowsBackend()  # exercise the real managed-runtime import contract
        assert backend.sd and backend.war and backend.PolicyConfigFactory
    b = FakeBackend()
    owner = OwnedWindowsRoute(b)
    assert owner.apply(127, "sd:7")["ok"]
    assert b.assignment == "{A}"
    assert owner.volume(.45)["sessions"] == 1
    assert b.gains == [.45]
    assert owner.restore()["status"] == "restored"
    assert b.assignment is None
    assert b.changed == ["{A}", None]
    b2 = FakeBackend()
    owner2 = OwnedWindowsRoute(b2)
    owner2.apply(127, "sd:7")
    b2.assignment = "manual-override"
    assert owner2.restore()["status"] == "manual-override-preserved"
    assert b2.assignment == "manual-override"
    for invalid in ("sd:0", "default", "sd:-1"):
        try:
            resolve_output(invalid, PortAudio(), [Endpoint("{A}", "CABLE Input (VB-Audio Virtual Cable)")])
        except (AssertionError, ValueError):
            continue  # either rejected identity or fake PortAudio rejected the index
        raise AssertionError(f"Accepted invalid/mismatched endpoint: {invalid}")
    b3 = FakeBackend()
    b3.assignment = "{A}"  # pre-existing user Windows Mixer selection
    owner3 = OwnedWindowsRoute(b3)
    assert owner3.apply(127, "sd:7")["changed"] is False
    assert owner3.restore()["status"] == "preexisting-route-kept"
    assert b3.changed == [], "must not clear the user's pre-existing assignment"
    tree = ProcessTreeBackend()
    tree_owner = OwnedWindowsRoute(tree)
    tree_receipt = tree_owner.apply(127, "sd:7")
    assert tree_receipt["assignedPids"] == [128]
    assert tree_owner.volume(.5)["sessions"] == 1
    assert tree_owner.restore()["restoredPids"] == [128]
    manager = SpotifyDirectManager()
    route, actions = CommandRoute(), []
    manager.ensure = lambda *_args: {"ok": True, "running": True}
    manager._process = type("Process", (), {"pid": 127, "poll": lambda self: None})()
    manager._device_id, manager._output_mode, manager._windows_route = "sd:7", "windows", route
    def send(action, *_args, **_kwargs):
        actions.append(action)
        return {"ok": True, "state": {"status": "playing", "paused": False,
            "currentTime": 1 if "resume" in actions else 0}}
    manager._send = send
    result = manager.command({"action": "play", "payload": {
        "deviceId": "sd:7", "outputMode": "windows", "gain": .7}}, 8765)
    assert result["ok"] is True
    assert actions == ["play", "route-ready", "status", "resume", "route-ready", "status"], actions
    assert route.applies == [(127, "sd:7"), (127, "sd:7")]
    # The Electron resume action remutes its source. Every retry must first
    # reverify Windows ownership, then explicitly unmute before checking volume.
    muted, trace = True, []
    resumed_route = CommandRoute()
    manager._windows_route = resumed_route
    def guarded_send(action, *_args, **_kwargs):
        nonlocal muted
        trace.append(action)
        if action in ("play", "resume"):
            muted = True
        elif action == "route-ready":
            assert resumed_route.applies, "Never unmute before verifying a route"
            muted = False
        return {"ok": True, "state": {"status": "playing", "paused": False,
            "currentTime": 1 if "resume" in trace else 0}}
    def guarded_volume(gain):
        return {"ok": True, "sessions": 0 if muted else 1, "gain": gain}
    resumed_route.volume = guarded_volume
    manager._send = guarded_send
    guarded = manager.command({"action": "play", "payload": {
        "deviceId": "sd:7", "outputMode": "windows", "gain": .7}}, 8765)
    assert guarded["ok"] and not muted
    assert trace == ["play", "route-ready", "status", "resume", "route-ready", "status"], trace
    try:
        resolve_output("sd:7", PortAudio(), [Endpoint("{A}", "CABLE Input (VB-Audio Virtual Cable)"),
                                                    Endpoint("{B}", "CABLE Input (VB-Audio Virtual Cable)" )])
        raise AssertionError("Ambiguous endpoint did not fail closed")
    except ValueError:
        pass
    print("audioflix Spotify Windows output ownership smoke passed")

if __name__ == "__main__":
    run()
