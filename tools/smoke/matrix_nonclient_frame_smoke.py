#!/usr/bin/env python3
"""Pure contract smoke for detached Matrix immersive non-client frame suppression."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import matrix_taskbar_control as control  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


class FakeWindowApi:
    def IsWindow(self, hwnd):
        return bool(hwnd)


def main():
    unrelated = 0x10000000
    original = unrelated | control.WS_CAPTION | control.WS_THICKFRAME
    style = {"value": original}
    border = {"value": 0x00112233}
    style_writes = []
    border_writes = []

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

    with patch.object(control, "_window_frame_api", return_value=FakeWindowApi()), \
            patch.object(control, "_read_window_style", side_effect=read_style), \
            patch.object(control, "_write_window_style", side_effect=write_style), \
            patch.object(control, "_read_dwm_border_color", side_effect=read_border), \
            patch.object(control, "_write_dwm_border_color", side_effect=write_border):
        state = control._suppress_immersive_resize_frame(321)
        assert_true(
            style["value"] & control.IMMERSIVE_FRAME_STYLE_MASK == 0,
            f"non-client frame bits survived suppression: 0x{style['value']:08x}",
        )
        assert_true(
            style["value"] & unrelated,
            "frame suppression damaged an unrelated Chromium style bit",
        )
        assert_true(
            border["value"] == control.DWMWA_COLOR_NONE,
            f"DWM border was not suppressed: 0x{border['value']:08x}",
        )
        assert_true(
            state.get("frameStyleBits") == original & control.IMMERSIVE_FRAME_STYLE_MASK,
            f"saved frame state mismatch: {state}",
        )

        assert_true(control._restore_immersive_resize_frame(state),
                    "frame restoration unexpectedly returned false")
        assert_true(
            style["value"] == original,
            f"native frame did not restore exactly: 0x{style['value']:08x}",
        )
        assert_true(
            border["value"] == 0x00112233,
            f"DWM border color did not restore: 0x{border['value']:08x}",
        )

    assert_true(len(style_writes) == 2, f"unexpected style writes: {style_writes}")
    assert_true(border_writes == [control.DWMWA_COLOR_NONE, 0x00112233],
                f"unexpected DWM border writes: {border_writes}")
    print("MATRIX_NONCLIENT_FRAME_SMOKE_OK")


if __name__ == "__main__":
    main()
