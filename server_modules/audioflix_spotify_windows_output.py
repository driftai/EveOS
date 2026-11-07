"""Windows per-app (never system-default) output for EveOS-owned Electron Direct.

The Windows Media Internal AudioPolicyConfig interface is undocumented. We isolate its use
behind one optional, pinned Python adapter and read back every write. No registry edits,
OS default switching, capture, driver, or other Electron executable is touched explicitly.
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass

_SD_ID = re.compile(r"^sd:(\d+)$")


def _norm(name: str) -> str:
    return " ".join(str(name).casefold().split())


def resolve_output(sd_id: str, portaudio, endpoints) -> object:
    """Map a verified PortAudio output to exactly one Windows render endpoint.

    PortAudio MME can truncate friendly names at 31 characters; a sufficiently long,
    unique prefix is accepted. Never use an 'sd:N' number directly as a Windows ID.
    """
    match = _SD_ID.fullmatch(str(sd_id))
    if not match:
        raise ValueError("Expected an exact PortAudio output ID (sd:N).")
    index = int(match.group(1))
    info = portaudio.query_devices(index)
    if int(info.get("max_output_channels") or 0) < 1:
        raise ValueError("Selected PortAudio device has no output channels.")
    requested = _norm(info.get("name") or "")
    if len(requested) < 20:
        raise ValueError("PortAudio output name is too short to map safely to Windows.")
    all_endpoints = list(endpoints)
    exact = [d for d in all_endpoints if _norm(d.name) == requested]
    matches = exact or ([d for d in all_endpoints if _norm(d.name).startswith(requested)]
                        if len(requested) >= 26 else [])
    if len(matches) != 1:
        raise ValueError("Output mapping is missing or ambiguous; choose a unique Windows endpoint.")
    return matches[0]


class NativeWindowsBackend:
    """Adapter isolated from the controller for deterministic mock testing on Linux."""
    def __init__(self):
        if sys.platform != "win32":
            raise RuntimeError("Windows app-output routing is supported only on Windows.")
        try:
            import sounddevice as sd
            import winappaudiorouter as war
            from winappaudiorouter.com import com_initialized
            from winappaudiorouter.policy_config import PolicyConfigFactory
            from winappaudiorouter.device_ids import pack_render_device_id, unpack_device_id
            from pycaw.constants import EDataFlow, ERole
        except ImportError as exc:
            # Do not hide the precise failed import in a running EveOS server process.
            # No credentials or endpoint IDs are included in this diagnostic.
            missing = getattr(exc, "name", None) or "unknown"
            detail = str(exc).replace("\r", " ").replace("\n", " ")[:240]
            raise RuntimeError(f"Windows routing import failed [{type(exc).__name__}; module={missing}]: {detail}") from exc
        from importlib.metadata import version
        if version("winappaudiorouter") != "1.1.1":
            raise RuntimeError("Windows routing adapter requires pin winappaudiorouter==1.1.1.")
        self.sd, self.war = sd, war
        self.com_initialized, self.PolicyConfigFactory = com_initialized, PolicyConfigFactory
        self.pack_render_device_id, self.unpack_device_id = pack_render_device_id, unpack_device_id
        self.flow, self.role = EDataFlow.eRender.value, ERole.eMultimedia.value

    def resolve(self, sd_id: str) -> object:
        return resolve_output(sd_id, self.sd, self.war.list_output_devices())

    def get(self, pid: int) -> str | None:
        with self.com_initialized():
            with self.PolicyConfigFactory() as factory:
                raw = factory.get_persisted_default_endpoint(pid, self.flow, self.role)
                return self.unpack_device_id(raw)

    def set(self, pid: int, endpoint: str | None) -> None:
        # Set both relevant roles. The caller discovers candidates after playback
        # starts because recent Windows builds reject non-audio process IDs.
        from pycaw.constants import ERole
        with self.com_initialized():
            with self.PolicyConfigFactory() as factory:
                for role in (ERole.eConsole.value, ERole.eMultimedia.value):
                    factory.set_persisted_default_endpoint(
                        pid, self.flow, role, self.pack_render_device_id(endpoint))

    @staticmethod
    def process_ids(root_pid: int) -> list[int]:
        """Return only the live EveOS-owned Electron process tree."""
        import psutil
        root = psutil.Process(root_pid)
        return [root.pid, *(child.pid for child in root.children(recursive=True))]

    def volume(self, root_pid: int, gain: float, target: str | None = None) -> int:
        from pycaw.pycaw import AudioUtilities
        from pycaw.utils import AudioSession
        from pycaw.api.audiopolicy import IAudioSessionControl2
        import psutil
        # Pycaw.GetAllSessions() ONLY queries the *default* playback endpoint.
        # The direct app has been routed to a NON-default endpoint; enumerate there.
        root = psutil.Process(root_pid)
        ids = {root.pid, *(c.pid for c in root.children(recursive=True))}
        target = target or self.get(root_pid)
        if not target:
            raise RuntimeError("Windows has no confirmed app-output route.")
        count = 0
        with self.com_initialized():
            mmdevice = AudioUtilities.GetDeviceEnumerator().GetDevice(target)
            wrapped = AudioUtilities.CreateDevice(mmdevice)
            if wrapped is None:
                raise RuntimeError("Windows routed endpoint could not be opened.")
            sessions = wrapped.AudioSessionManager.GetSessionEnumerator()
            for idx in range(sessions.GetCount()):
                ctl = sessions.GetSession(idx)
                if ctl is None:
                    continue
                session = AudioSession(ctl.QueryInterface(IAudioSessionControl2))
                if session.ProcessId not in ids:
                    continue
                session.SimpleAudioVolume.SetMasterVolume(gain, None)
                count += 1
        return count


@dataclass
class RouteReceipt:
    ok: bool
    status: str
    device_id: str = ""
    reason: str = ""


class OwnedWindowsRoute:
    """A route bound to one live, server-owned Electron PID.

    Restore only if the current assignment remains the one we installed. A user's
    manual change after routing is authoritative and will never be overwritten.
    """
    def __init__(self, backend=None):
        self.backend = backend if backend is not None else NativeWindowsBackend()
        self.pid = 0
        self.target: str | None = None
        self.previous: dict[int, str | None] = {}
        self.assigned_pids: set[int] = set()
        self.changed = False

    def _candidate_pids(self, root_pid: int) -> list[int]:
        discover = getattr(self.backend, "process_ids", None)
        candidates = discover(root_pid) if callable(discover) else [root_pid]
        return list(dict.fromkeys(int(pid) for pid in candidates if int(pid) > 0))

    def _assign_one(self, pid: int, target: str) -> tuple[bool, str]:
        """Assign one candidate only after its original route can be read safely."""
        try:
            original = self.backend.get(pid)
        except Exception as exc:
            return False, f"pid {pid} preflight: {exc}"
        changed = original != target
        try:
            if changed:
                self.backend.set(pid, target)
            if self.backend.get(pid) != target:
                raise RuntimeError("Windows did not confirm the assignment")
        except Exception as exc:
            if changed:
                try:
                    self.backend.set(pid, original)
                except Exception:
                    pass
            return False, f"pid {pid} assignment: {exc}"
        self.previous.setdefault(pid, original)
        self.assigned_pids.add(pid)
        self.changed = self.changed or changed
        return True, ""

    def apply(self, pid: int, sd_id: str) -> dict:
        if not isinstance(pid, int) or pid <= 0:
            raise ValueError("An exact owned Electron PID is required.")
        if self.pid and self.pid != pid:
            raise RuntimeError("This route is already owned by another process.")
        target = self.backend.resolve(sd_id)
        self.target = target.id
        failures = []
        successful = []
        for candidate in self._candidate_pids(pid):
            ok, reason = self._assign_one(candidate, target.id)
            if ok:
                successful.append(candidate)
            elif reason:
                failures.append(reason)
        if not successful:
            detail = failures[0] if failures else "no live Electron process candidates"
            raise RuntimeError(f"Windows did not confirm any Electron app-output assignment ({detail}).")
        self.pid = pid
        return {"ok": True, "status": "assigned", "deviceId": sd_id,
                "windowsDevice": target.name, "changed": self.changed,
                "assignedPids": sorted(self.assigned_pids)}

    def volume(self, gain: float) -> dict:
        if not self.pid or not self.target or not self.assigned_pids:
            raise RuntimeError("Windows output route is not owned/verified.")
        value = max(0.0, min(1.0, float(gain)))
        try:
            count = self.backend.volume(self.pid, value, self.target)
        except TypeError:  # compatibility with deterministic fake backends
            count = self.backend.volume(self.pid, value)
        return {"ok": True, "status": "applied" if count else "pending-session", "sessions": count,
                "gain": value}

    def restore(self) -> dict:
        if not self.pid:
            return {"ok": True, "status": "not-owned"}
        try:
            if not self.changed:
                return {"ok": True, "status": "preexisting-route-kept"}
            restored, preserved = [], []
            for candidate, original in self.previous.items():
                try:
                    current = self.backend.get(candidate)
                except Exception:
                    continue  # exited children have no live route to restore
                if current != self.target:
                    preserved.append(candidate)
                    continue
                self.backend.set(candidate, original)
                if self.backend.get(candidate) != original:
                    raise RuntimeError(f"Windows did not confirm route restoration for pid {candidate}.")
                restored.append(candidate)
            status = "restored" if restored else "manual-override-preserved"
            return {"ok": True, "status": status, "restoredPids": restored,
                    "preservedPids": preserved}
        finally:
            self.pid = 0
            self.target = None
            self.previous.clear()
            self.assigned_pids.clear()
            self.changed = False
