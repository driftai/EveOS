from __future__ import annotations

import threading
import time
from enum import Enum, auto
from typing import Callable

from .window_focus import foreground_window


class TargetFocusState(Enum):
    DISARMED = auto()
    ARMED = auto()
    PAUSED_FOR_FOCUS = auto()


class TargetFocusGuard:
    """Watch the selected foreground HWND and pause/resume a playback session."""

    def __init__(self, target_hwnd: int, on_lost: Callable[[], None], on_regained: Callable[[], None],
                 interval_ms: float = 25.0, transient_ms: float = 75.0,
                 log: Callable[[str], None] | None = None) -> None:
        self.target_hwnd = int(target_hwnd or 0)
        self.on_lost = on_lost
        self.on_regained = on_regained
        self.interval = max(0.01, float(interval_ms) / 1000.0)
        self.transient = max(0.02, float(transient_ms) / 1000.0)
        self.log = log or (lambda _message: None)
        self.state = TargetFocusState.DISARMED
        self._stop = threading.Event()
        self._paused = False
        self._lost_since = 0.0
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()

    def set_target(self, hwnd: int) -> None:
        with self._lock:
            self.target_hwnd = int(hwnd or 0)

    def arm(self) -> None:
        with self._lock:
            if self.state is not TargetFocusState.DISARMED:
                return
            if not self.target_hwnd:
                raise ValueError("Cannot arm target-focus guard without a target HWND.")
            self._stop.clear()
            self._paused = False
            self._lost_since = 0.0
            self.state = TargetFocusState.ARMED
            self._thread = threading.Thread(target=self._loop, daemon=True, name="piano-target-focus")
            self._thread.start()
        self.log(f"[FOCUS_GUARD] ARMED target=0x{self.target_hwnd:08X} interval={int(self.interval*1000)}ms")

    def disarm(self) -> None:
        with self._lock:
            if self.state is TargetFocusState.DISARMED:
                return
            self._stop.set()
            thread = self._thread
            self._thread = None
            self._paused = False
            self._lost_since = 0.0
            self.state = TargetFocusState.DISARMED
        if thread and thread.is_alive():
            thread.join(timeout=0.5)
        self.log("[FOCUS_GUARD] DISARMED")

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            target = self.target_hwnd
            if not target:
                continue
            active = foreground_window()
            now = time.monotonic()
            if active == 0:
                if not self._lost_since:
                    self._lost_since = now
                continue
            if active != target:
                if not self._lost_since:
                    self._lost_since = now
                if not self._paused and now - self._lost_since >= self.transient:
                    self._paused = True
                    self.state = TargetFocusState.PAUSED_FOR_FOCUS
                    self.log(f"[FOCUS_GUARD] TARGET_LOST active=0x{active:08X} -> PAUSE + RELEASE HOLDS")
                    self.on_lost()
                continue

            self._lost_since = 0.0
            if self._paused:
                self._paused = False
                self.state = TargetFocusState.ARMED
                self.log(f"[FOCUS_GUARD] TARGET_REGAINED active=0x{target:08X} -> RESUME")
                self.on_regained()
