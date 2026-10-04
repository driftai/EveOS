#!/usr/bin/env python3
"""Pure contract smoke for detached Matrix immersive frame/client alignment."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import matrix_immersive_frame as frame  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


class FakeWindowApi:
    def IsWindow(self, hwnd):
        return bool(hwnd)


def main():
    # Reproduce the exact class of failure seen in the live screenshot: the client
    # stops 7 px before the monitor edge even though the browser window reaches it.
    target = frame.target_outer_rect(
        (-7, 0, 1919, 1199),
        (0, 0, 1912, 1199),
        (0, 0, 1919, 1199),
    )
    assert_true(target == (-7, 0, 1926, 1199),
                f"7px client rail was not compensated: {target}")

    unrelated = 0x10000000
    original = unrelated | frame.WS_CAPTION | frame.WS_THICKFRAME
    style = {"value": original}
    border = {"value": 0x00112233}
    style_writes = []
    border_writes = []
    align_calls = []

    def read_style(_api, _hwnd):
        return style["value"]

    def write_style(_api, _hwnd, value):
        style["value"] = int(value)
        style_writes.append(int(value))

    def read_border(_hwnd):
        return border["value"]

    def write_border(_hwnd, value):
        border["value"] = int(value)
        border_writes.append(int(value))
        return True

    def align_client(_api, hwnd):
        align_calls.append(hwnd)
        return {
            "clientAligned": True,
            "windowRect": (-7, 0, 1926, 1199),
            "clientRect": (0, 0, 1919, 1199),
            "monitorRect": (0, 0, 1919, 1199),
        }

    with patch.object(frame, "_api", return_value=FakeWindowApi()), \
            patch.object(frame, "_read_style", side_effect=read_style), \
            patch.object(frame, "_write_style", side_effect=write_style), \
            patch.object(frame, "_read_border", side_effect=read_border), \
            patch.object(frame, "_write_border", side_effect=write_border), \
            patch.object(frame, "_align_client", side_effect=align_client):
        state = frame.capture_and_suppress(321)
        assert_true(
            style["value"] & frame.IMMERSIVE_FRAME_STYLE_MASK == 0,
            f"non-client frame bits survived suppression: 0x{style['value']:08x}",
        )
        assert_true(style["value"] & unrelated,
                    "frame suppression damaged an unrelated Chromium style bit")
        assert_true(border["value"] == frame.DWMWA_COLOR_NONE,
                    f"DWM border was not suppressed: 0x{border['value']:08x}")
        assert_true(state.get("clientAligned") is True,
                    f"client alignment state missing: {state}")

        # Chromium may re-apply its frame after the fullscreenchange callback. The
        # immersive guard must strip it again rather than trusting the first write.
        style["value"] = original
        border["value"] = 0x00112233
        frame.reassert(state)
        assert_true(style["value"] & frame.IMMERSIVE_FRAME_STYLE_MASK == 0,
                    "Chromium frame reclaim survived guard reassertion")
        assert_true(border["value"] == frame.DWMWA_COLOR_NONE,
                    "Chromium DWM border reclaim survived guard reassertion")

        assert_true(frame.restore(state), "frame restoration unexpectedly returned false")
        assert_true(style["value"] == original,
                    f"native frame did not restore exactly: 0x{style['value']:08x}")
        assert_true(border["value"] == 0x00112233,
                    f"DWM border color did not restore: 0x{border['value']:08x}")

    assert_true(len(style_writes) == 3, f"unexpected style writes: {style_writes}")
    assert_true(border_writes == [
        frame.DWMWA_COLOR_NONE,
        frame.DWMWA_COLOR_NONE,
        0x00112233,
    ], f"unexpected DWM border writes: {border_writes}")
    assert_true(align_calls == [321, 321], f"client alignment was not reasserted: {align_calls}")
    print("MATRIX_NONCLIENT_FRAME_SMOKE_OK")


if __name__ == "__main__":
    main()
