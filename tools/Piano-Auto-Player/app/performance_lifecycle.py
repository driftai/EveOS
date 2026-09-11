from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .performance_notes import span_stroke, target_note_spans
from .piano_layout import PianoStroke, display_strokes


@dataclass(frozen=True)
class LifecycleAction:
    at_ms: float
    kind: str
    event_index: int
    owner: str
    stroke: PianoStroke
    physical_id: str
    velocity: int
    display_token: str


def has_note_lifecycle(events: list[dict[str, Any]]) -> bool:
    return any(isinstance(event.get("note_spans"), list) and event.get("note_spans") for event in events)


def build_lifecycle_actions(events: list[dict[str, Any]], layout: str, start_zero_index: int = 0) -> list[LifecycleAction]:
    actions: list[LifecycleAction] = []
    for zero_index in range(max(0, start_zero_index), len(events)):
        event = events[zero_index]
        spans = target_note_spans(event, layout)
        if not spans:
            continue
        strokes = [span_stroke(span) for span in spans]
        display = display_strokes(strokes) or str(event.get("key") or "")
        event_at = float(event.get("at_ms") or 0.0)
        for span_index, span in enumerate(spans):
            stroke = span_stroke(span)
            owner = f"{zero_index}:{span_index}:{span['source_midi']}"
            start = event_at + float(span["offset_ms"])
            end = start + float(span["duration_ms"])
            common = dict(event_index=zero_index + 1, owner=owner, stroke=stroke,
                          physical_id=str(span["physical_id"]), velocity=int(span.get("velocity") or 0),
                          display_token=display)
            actions.append(LifecycleAction(start, "down", **common))
            actions.append(LifecycleAction(end, "up", **common))
    return sorted(actions, key=lambda action: (action.at_ms, 0 if action.kind == "up" else 1, action.event_index))


class LifecycleKeyState:
    def __init__(self, keyboard, options) -> None:
        self.keyboard = keyboard
        self.options = options
        self.active: dict[str, tuple[str, PianoStroke]] = {}

    def apply_batch(self, actions: list[LifecycleAction]) -> None:
        releases = [action for action in actions if action.kind == "up"]
        presses = [action for action in actions if action.kind == "down"]
        release_strokes: list[PianoStroke] = []
        for action in releases:
            current = self.active.get(action.physical_id)
            if current and current[0] == action.owner:
                release_strokes.append(current[1])
                del self.active[action.physical_id]
        self._release(release_strokes)

        winners: dict[str, LifecycleAction] = {}
        for action in presses:
            prior = winners.get(action.physical_id)
            if prior is None or (action.velocity, action.event_index) > (prior.velocity, prior.event_index):
                winners[action.physical_id] = action

        displaced: list[PianoStroke] = []
        for physical_id in winners:
            current = self.active.pop(physical_id, None)
            if current:
                displaced.append(current[1])
        self._release(displaced)

        to_press = [action.stroke for action in winners.values()]
        if to_press and self.keyboard is not None:
            self.keyboard.press_strokes(to_press, self.options.modifier_lead_ms,
                                       self.options.modifier_tail_ms, self.options.chord_spread_ms)
        for physical_id, action in winners.items():
            self.active[physical_id] = (action.owner, action.stroke)

    def release_all(self) -> None:
        strokes = [entry[1] for entry in self.active.values()]
        self.active.clear()
        self._release(strokes)

    def _release(self, strokes: list[PianoStroke]) -> None:
        if strokes and self.keyboard is not None:
            self.keyboard.release_strokes(strokes)


def run_lifecycle_performance(controller, events, song_name, options) -> None:
    keyboard = None
    key_state = None
    try:
        total = len(events)
        zero_index = controller._start_zero_index(total, options.start_event)
        keyboard = controller._prepare(song_name, total, options, zero_index + 1)
        if controller._stop.is_set():
            return
        key_state = LifecycleKeyState(keyboard, options)
        speed = controller._speed(options)

        while zero_index < total:
            actions = build_lifecycle_actions(events, options.piano_layout, zero_index)
            if not actions:
                break
            base_at_ms = float(events[zero_index]["at_ms"])
            clock = time.monotonic()
            paused_total = 0.0
            cursor = 0

            while cursor < len(actions):
                requested = controller._consume_seek(total)
                if requested is not None:
                    key_state.release_all()
                    zero_index = requested
                    controller.state.update(current_index=zero_index + 1, current_token="", message=f"Seeked to event {zero_index + 1}")
                    break
                if controller._should_stop():
                    key_state.release_all()
                    zero_index = total
                    break

                action = actions[cursor]
                target = clock + ((action.at_ms - base_at_ms) / 1000.0 / speed)
                paused_total = _wait_until(controller, target, paused_total, key_state, options)
                if controller._has_seek_request() or controller._should_stop():
                    continue
                # The asynchronous guard owns pause/resume, but it is not the
                # final authority for generated input. Re-check the real target
                # immediately before consuming this batch so a transient focus
                # switch cannot leak lifecycle key-downs to another window.
                if not controller._target_is_ready(options):
                    key_state.release_all()
                    paused_total += controller._wait_if_paused()
                    continue

                due: list[LifecycleAction] = []
                stamp = action.at_ms
                while cursor < len(actions) and abs(actions[cursor].at_ms - stamp) <= 0.5:
                    due.append(actions[cursor])
                    cursor += 1
                if not controller._target_is_ready(options):
                    key_state.release_all()
                    # Rewind the batch so it is retried after focus returns.
                    cursor -= len(due)
                    paused_total += controller._wait_if_paused()
                    continue
                downs = [row for row in due if row.kind == "down"]
                if downs:
                    latest = max(downs, key=lambda row: row.event_index)
                    controller.state.update(current_index=latest.event_index, current_token=latest.display_token)
                key_state.apply_batch(due)
            else:
                zero_index = total
                continue
            if zero_index >= total:
                break
            continue

        controller._finish(total)
    except Exception as exc:
        controller.state.update(status="error", message=str(exc), current_token="")
    finally:
        if key_state is not None:
            try:
                key_state.release_all()
            except Exception:
                pass
        if keyboard is not None and hasattr(keyboard, "close"):
            keyboard.close()
        controller._reset_flags()


def _wait_until(controller, base_target: float, paused_total: float, key_state: LifecycleKeyState, options) -> float:
    while True:
        if controller._should_stop() or controller._has_seek_request():
            return paused_total
        if not controller._target_is_ready(options):
            key_state.release_all()
            paused_total += controller._wait_if_paused()
            continue
        if controller._pause.is_set():
            key_state.release_all()
            paused_total += controller._wait_if_paused()
            continue
        remaining = base_target + paused_total - time.monotonic()
        if remaining <= 0:
            return paused_total
        time.sleep(min(0.003, remaining))
