"""Focused credential-boundary smoke for managed-to-direct Spotify session handoff."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules.audioflix_spotify_session_handoff import acquire


class FakeManager:
    class Lock:
        def __enter__(self): return self
        def __exit__(self, *_): return False
    _lock = Lock()
    def __init__(self, result, healthy=True): self.result, self.healthy = result, healthy
    def _helper_status(self): return {"ok": True} if self.healthy else None
    def _request(self, method, route, body, timeout):
        assert (method, route, body, timeout) == ("POST", "/auth-handoff", {}, 4)
        return self.result


good = acquire(FakeManager({"ok": True, "authState": "signed-in", "cookies": [{"name": "sp_dc", "value": "x"}]}))
assert good["ok"] is True and len(good["cookies"]) == 1
assert acquire(FakeManager({}, healthy=False))["ok"] is False
assert acquire(FakeManager({"ok": False, "reason": "signed out"}))["ok"] is False
print("audioflix Spotify session handoff smoke passed")
