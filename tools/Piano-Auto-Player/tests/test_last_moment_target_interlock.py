from __future__ import annotations

import threading
from unittest.mock import Mock, patch

from app.performance_lifecycle import LifecycleAction, run_lifecycle_performance
from app.playback import PlaybackController, PlaybackOptions
from app.state import RuntimeState


def _options() -> PlaybackOptions:
    return PlaybackOptions(
        target_hwnd=0x1000,
        target_window="MockTarget",
        auto_focus=False,
        pause_on_focus_loss=True,
        countdown_seconds=0.0,
        dry_run=False,
    )


def test_last_moment_interlock_rechecks_foreground_even_with_focus_guard() -> None:
    controller = PlaybackController(RuntimeState())
    controller._target_hwnd = 0x1000
    controller._focus_guard = Mock()
    controller._focus_paused.clear()

    with patch("app.playback.is_foreground", return_value=False):
        assert controller._target_is_ready(_options()) is False

    assert controller._focus_paused.is_set()


def test_last_moment_interlock_allows_matching_target() -> None:
    controller = PlaybackController(RuntimeState())
    controller._target_hwnd = 0x1000
    controller._focus_guard = Mock()
    controller._focus_paused.clear()

    with patch("app.playback.is_foreground", return_value=True):
        assert controller._target_is_ready(_options()) is True

    assert controller._focus_paused.is_set() is False


class _RecordingKeyboard:
    def __init__(self) -> None:
        self.pressed: list[object] = []
        self.released: list[object] = []

    def press_strokes(self, strokes, *_args) -> None:
        self.pressed.extend(strokes)

    def release_strokes(self, strokes) -> None:
        self.released.extend(strokes)

    def close(self) -> None:
        pass


class _LifecycleController:
    def __init__(self, keyboard: _RecordingKeyboard) -> None:
        self.keyboard = keyboard
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._focus_paused = threading.Event()
        self.state = Mock()
        self.ready_checks = 0
        self.finished = False

    @staticmethod
    def _start_zero_index(_total: int, _requested: int) -> int:
        return 0

    def _prepare(self, *_args):
        return self.keyboard

    @staticmethod
    def _speed(_options) -> float:
        return 1.0

    @staticmethod
    def _consume_seek(_total: int):
        return None

    @staticmethod
    def _has_seek_request() -> bool:
        return False

    def _should_stop(self) -> bool:
        return self._stop.is_set()

    def _target_is_ready(self, _options) -> bool:
        self.ready_checks += 1
        # Simulate focus moving away in the tiny window after the scheduled wait
        # but immediately before the lifecycle batch would emit its key-down.
        self._stop.set()
        return False

    @staticmethod
    def _wait_if_paused() -> float:
        return 0.0

    def _finish(self, _total: int) -> None:
        self.finished = True

    def _reset_flags(self) -> None:
        pass


def test_lifecycle_path_rechecks_focus_before_emitting_key_down() -> None:
    keyboard = _RecordingKeyboard()
    controller = _LifecycleController(keyboard)
    stroke = Mock()
    action = LifecycleAction(
        at_ms=0.0,
        kind="down",
        event_index=1,
        owner="0:0:60",
        stroke=stroke,
        physical_id="key-a",
        velocity=100,
        display_token="a",
    )
    events = [{"at_ms": 0.0, "note_spans": [{"source_midi": 60}]}]

    with patch("app.performance_lifecycle.build_lifecycle_actions", return_value=[action]), \
         patch("app.performance_lifecycle._wait_until", return_value=0.0):
        run_lifecycle_performance(controller, events, "Interlock regression", _options())

    assert controller.ready_checks >= 1
    assert keyboard.pressed == [], "Lifecycle playback must not emit a key-down after target focus is lost."
