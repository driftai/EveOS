"""Bookmark Intel integration, UI contract, and lifecycle smoke."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import bookmark_intel_control, eveos_control_helper, eveos_ports


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError("ASSERT FAILED: " + message)


def assert_static_contract() -> None:
    tool = ROOT / "tools" / "Bookmark-Intel"
    check((tool / "server.py").is_file(), "Bookmark-Intel server.py exists")
    check((tool / "ui.html").is_file(), "Bookmark-Intel ui.html exists")
    check((tool / "EVEOS.bat").is_file(), "Bookmark-Intel EVEOS.bat exists")

    ports_json = json.loads((ROOT / "config" / "eveos-ports.json").read_text(encoding="utf-8"))
    ports = ports_json.get("ports", {})
    check("BOOKMARK_INTEL_PORT" in ports, "config/eveos-ports.json registers BOOKMARK_INTEL_PORT")
    check(ports["BOOKMARK_INTEL_PORT"]["port"] == 9077, "BOOKMARK_INTEL_PORT is 9077")
    check(eveos_ports.service_port("BOOKMARK_INTEL_PORT") == 9077, "eveos_ports resolves BOOKMARK_INTEL_PORT to 9077")

    panel_js = (ROOT / "js" / "modules" / "core" / "eveos-console-panel.js").read_text(encoding="utf-8")
    check("bookmarkIntel" in panel_js, "eveos-console-panel.js registers bookmarkIntel service spec")
    check("BOOKMARK_INTEL_PORT" in panel_js, "eveos-console-panel.js references BOOKMARK_INTEL_PORT")

    scraper_tpl = (ROOT / "js" / "modules" / "features" / "scraper" / "ui" / "templates" / "scraper-panel-template.js").read_text(encoding="utf-8")
    check('data-source="bookmark-intel"' in scraper_tpl, "scraper template has Bookmark Intel button in Knowledge Bases")
    check("bookmarkIntelManagement" in scraper_tpl, "scraper template has bookmarkIntelManagement container")
    check("bookmark-intel-scraper-panel-container" in scraper_tpl, "scraper template has bookmark-intel-scraper-panel-container")

    tm_ui = (ROOT / "js" / "modules" / "features" / "scraper" / "ui" / "tab-manager" / "components" / "tm-ui.js").read_text(encoding="utf-8")
    check("'bookmark-intel'" in tm_ui, "tm-ui.js validates bookmark-intel source")
    check("bookmarkIntelManagement" in tm_ui, "tm-ui.js updates bookmarkIntelManagement display")
    check("BookmarkIntelManager" in tm_ui, "tm-ui.js delegates rendering to BookmarkIntelManager")

    manager_js = ROOT / "js" / "modules" / "features" / "scraper" / "ui" / "bookmark-intel" / "bookmark-intel-manager.js"
    check(manager_js.is_file(), "bookmark-intel-manager.js exists")
    manager_text = manager_js.read_text(encoding="utf-8")
    check("window.BookmarkIntelManager" in manager_text, "bookmark-intel-manager.js defines BookmarkIntelManager")
    check("BOOKMARK_INTEL_PORT" in manager_text, "bookmark-intel-manager.js references BOOKMARK_INTEL_PORT")
    check("/api/bookmark-intel/status" in manager_text, "bookmark-intel-manager.js queries /api/bookmark-intel/status")
    manifest = json.loads((ROOT / "tools" / "qualification" / "eveos_qualification_manifest.v3.json").read_text(encoding="utf-8"))
    gate = next(g for g in manifest["gates"] if g["id"] == "bookmark-intel")
    check(set(gate["resources"]) >= {"playwright", "ports", "services"}, "lifecycle gate locks ports and services")


def assert_health_observation_contract() -> None:
    # No second health request may invalidate a successful startup observation.
    health = {"ok": True, "service": "bookmark-intel", "appVersion": "0.10.0"}
    with mock.patch.object(bookmark_intel_control, "_health_payload", side_effect=AssertionError("double health probe")):
        with mock.patch.object(bookmark_intel_control, "_listener_pids", return_value=[1234]):
            with mock.patch.object(bookmark_intel_control, "_read_desired_state", return_value=False):
                result = bookmark_intel_control._status(verified_health=health)
    check(result["running"] is True, "verified health remains authoritative for startup reply")
    check(result["appVersion"] == "0.10.0", "verified version preserved")

def assert_lifecycle() -> None:
    initial = bookmark_intel_control.get_status()
    check(initial["controllerAvailable"] is True, "controller is available")
    check(initial["port"] == 9077, "controller port is 9077")
    check(initial["installed"] is True, "installed is reported as True")

    started = bookmark_intel_control.start_server(persist=False)
    try:
        check(started.get("ok") is True, f"start_server succeeded: {started.get('message')}")
        check(started.get("running") is True, "start_server reports running=True")

        running_status = bookmark_intel_control.get_status()
        check(running_status["running"] is True, "get_status reports running=True")
        check(len(running_status.get("pids", [])) > 0, "get_status reports listener PID")
        check(running_status.get("appVersion") == "0.10.0", "health probe verified appVersion")
    finally:
        stopped = bookmark_intel_control.stop_server(persist=False)
        check(stopped.get("ok") is True, f"stop_server succeeded: {stopped.get('message')}")
        check(stopped.get("running") is False, "stop_server reports running=False")

    final_status = bookmark_intel_control.get_status()
    check(final_status["running"] is False, "final get_status reports running=False")


def main() -> None:
    assert_static_contract()
    assert_health_observation_contract()
    assert_lifecycle()
    print("BOOKMARK_INTEL_INTEGRATION_SMOKE_OK")


if __name__ == "__main__":
    main()
