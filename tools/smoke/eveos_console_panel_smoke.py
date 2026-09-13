"""Local Services settings: console preferences, ports, live state, and Local Control lifetime.

Consoles became headed by default, but that only made processes visible -- it did not say which
port a service took, and it gave no way to silence one chatty backend without hiding everything.
This covers the panel that answers both plus the individual-tool Stop lifetime preference.

Four things here are easy to get subtly wrong:

1. Preferences must NOT live in eveos-web-service.json. That file is rewritten wholesale on every
   start/stop (desiredRunning/port/updatedAt only), so a preference stored beside it is erased the
   first time the service is toggled -- the setting appears to work, then quietly forgets.

2. Console precedence is env > per-service > default. Get it backwards and EVEOS_HEADLESS stops
   being an override, or a per-service choice silently loses to the global default.

3. The Local Control lifetime preference must survive console writes and default to auto-close,
   so individual tool Stop exits 9082 unless the user explicitly opts out.

4. The panel is a thin renderer over one payload. If endpoint keys and the JS reading them drift
   apart, the section can render a misleading stale or all-stopped view.

Runs offline: preferences are redirected to a temp file, lifecycle status calls are stubbed.
"""

import json
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import eveos_console_prefs as P  # noqa: E402
from server_modules import eveos_control_helper as H  # noqa: E402
from server_modules import eveos_web_control as W  # noqa: E402


def check(condition, message):
    if not condition:
        raise AssertionError("ASSERT FAILED: " + message)


def check_backend(store):
    # ---- the store is its own file, not the one rewritten on every start/stop ----
    check(store.name != "eveos-web-service.json",
          "local-service preferences are kept apart from the wholesale-rewritten service state file")

    # ---- default is headed, and individual tool Stop closes Local Control by default ----
    check(P.read_all() == {
        "default": False,
        "services": {},
        "keepLocalControlAfterToolStop": False,
    }, "a missing preferences file uses headed consoles and closes Local Control after tool Stop by default")
    check(P.headless_for("web") is False, "a service with no entry follows the headed default")

    # ---- a per-service override silences one service without hiding the rest ----
    P.set_console("gemini", True)
    check(P.headless_for("gemini") is True, "the per-service override takes effect")
    check(P.headless_for("web") is False, "and does not leak onto other services")

    # ---- the coordinator lifetime preference persists alongside console choices ----
    P.set_keep_local_control_after_tool_stop(True)
    check(P.read_all()["keepLocalControlAfterToolStop"] is True,
          "the keep-Local-Control opt-out persists")
    P.set_console("default", True)
    check(P.read_all()["keepLocalControlAfterToolStop"] is True,
          "console writes preserve the coordinator lifetime preference")

    # ---- ...and survives a lifecycle write, which is why this has a separate file ----
    W._write_desired_state(True)
    W._write_desired_state(False)
    check(P.headless_for("gemini") is True,
          "the preference survives start/stop rewrites of the web service state")
    check(P.read_all()["keepLocalControlAfterToolStop"] is True,
          "the coordinator lifetime preference also survives web lifecycle rewrites")

    # ---- the default applies to services with no entry of their own ----
    check(P.headless_for("web") is True, "the default reaches services without an override")
    P.set_console("web", False)
    check(P.headless_for("web") is False, "an override still beats the default")

    # ---- env beats everything, so a one-off quiet run needs no file edit ----
    os.environ["EVEOS_HEADLESS"] = "1"
    check(P.headless_for("web") is True, "EVEOS_HEADLESS overrides a per-service 'headed'")
    os.environ["EVEOS_HEADLESS"] = "0"
    check(P.headless_for("gemini") is False, "EVEOS_HEADLESS=0 overrides a per-service 'headless'")
    os.environ.pop("EVEOS_HEADLESS", None)

    # ---- web_control must delegate, or the panel and the spawner disagree ----
    check(W.headless_mode("gemini") is P.headless_for("gemini"),
          "the process spawner reads the same console preference the panel writes")

    # ---- clearing returns a service to the default without erasing lifecycle preferences ----
    P.clear("web")
    check(P.headless_for("web") is True, "a cleared service follows the default again")
    check(P.read_all()["keepLocalControlAfterToolStop"] is True,
          "clearing a console override preserves the coordinator lifetime preference")

    # ---- an unknown service is refused rather than silently stored ----
    try:
        P.set_console("not-a-service", True)
        raise AssertionError("ASSERT FAILED: an unknown service name is rejected")
    except ValueError:
        pass

    P.set_keep_local_control_after_tool_stop(False)
    P.set_console("default", False)
    P.clear("gemini")


def check_overview():
    original = (H.eveos_web_control.get_status, H.gemini_control.get_status,
                H.world_book_control.get_status)
    try:
        H.eveos_web_control.get_status = lambda *a, **k: {"running": True, "port": 8765}
        H.gemini_control.get_status = lambda: {"running": False, "websocketPort": 9085,
                                               "statusPort": 9086}
        # A status call that blows up must not take the whole panel with it: one broken service
        # should read as one broken row, not an empty section implying nothing is running.
        H.world_book_control.get_status = lambda: (_ for _ in ()).throw(RuntimeError("boom"))

        payload = H._console_overview()
        by_key = {service["key"]: service for service in payload["services"]}

        check(payload["ok"] is True, "the overview reports success")
        check(payload["keepLocalControlAfterToolStop"] is False,
              "the overview exposes the coordinator auto-close default")
        check(set(by_key) == set(P.KNOWN_SERVICES),
              f"every spawnable service is listed (got {sorted(by_key)})")
        check(by_key["web"]["running"] is True and by_key["web"]["ports"] == [8765],
              "a running service reports its port")
        check(by_key["gemini"]["ports"] == [9085, 9086],
              "Gemini reports BOTH its ports, so a port collision is visible from settings")
        check(by_key["worldBook"]["running"] is False
              and "boom" in by_key["worldBook"]["message"],
              "a service whose status call fails is reported, not dropped from the list")
        check(all(isinstance(service["headless"], bool) for service in payload["services"]),
              "each row carries the console preference the switch renders from")

        os.environ["EVEOS_HEADLESS"] = "1"
        check(H._console_overview()["envForced"] is True,
              "the panel can tell the user their console switches are overridden by the environment")
        os.environ.pop("EVEOS_HEADLESS", None)

        # ---- a preference switch must not pay for a lifecycle sweep it cannot change ----
        probed = []
        H.eveos_web_control.get_status = lambda *a, **k: probed.append("web") or {"running": True,
                                                                         "port": 8765}
        preferences = H._console_preferences()
        check(not probed, "setting a preference probes no service; it starts nothing")
        check(preferences["preferencesOnly"] is True,
              "the cheap reply says so, or the panel would overwrite its rows with empty state")
        check(preferences["keepLocalControlAfterToolStop"] is False,
              "the cheap reply includes the coordinator lifetime preference")
        check(set(s["key"] for s in preferences["services"]) == set(P.KNOWN_SERVICES),
              "every service still gets its console preference back")
        check(all("running" not in s and "ports" not in s for s in preferences["services"]),
              "the cheap reply carries no lifecycle state, so stale values cannot be rendered")
    finally:
        (H.eveos_web_control.get_status, H.gemini_control.get_status,
         H.world_book_control.get_status) = original


def check_panel_contract():
    """The JS reads this payload. Exercising it for real needs a browser and a live plane."""
    panel = (ROOT / "js" / "modules" / "core" / "eveos-console-panel.js").read_text(encoding="utf-8")
    settings = (ROOT / "js" / "modules" / "modals" / "modal-settings.js").read_text(encoding="utf-8")
    template = (ROOT / "js" / "modules" / "modals" / "templates" / "tpl-settings.js").read_text(
        encoding="utf-8")
    html = (ROOT / "EveOS.html").read_text(encoding="utf-8")

    check("eveos-console-panel.js?v=" in html, "the panel is loaded with a cache-busting tag")
    check('data-settings-section="local-services"' in template,
          "Settings has a Local Services section for the panel to fill")
    check("eveosConsolePanel" in template, "the section carries the mount point the panel targets")
    check("EveOSConsolePanel?.refresh?.()" in settings,
          "opening Settings refreshes live state, so a service started since last time is not stale")

    check("/api/control-plane/consoles" in panel, "the panel reads the overview endpoint")
    for key in ("services", "envForced", "overridden", "controlPlanePort",
                "keepLocalControlAfterToolStop"):
        check(key in panel, f"the panel reads the '{key}' the endpoint sends")
    check("Close Local Control after individual tool Stop" in panel,
          "Local Services exposes the opt-in coordinator auto-close toggle with the requested label")
    check("Global Stop always exits it" in panel,
          "the UI makes clear the preference never weakens Global Stop")
    check("method: 'POST'" in panel, "a switch writes the preference back")
    check(re.search(r"render\(lastPayload\)", panel),
          "a failed write re-renders from stored state, so a switch cannot show an unsaved value")
    check("preferencesOnly" in panel and "mergePreferences" in panel,
          "the cheap POST reply is merged into the rows on screen rather than replacing them,"
          " or every toggle would blank out running state and ports")
    check("button.disabled = !web?.running" in panel,
          "the live view is offered only when there is a server to view")
    refresh = panel[panel.index("async function refresh()"):]
    refresh = refresh[:refresh.index("\n    }")]
    check("host.textContent = ''" in refresh,
          "a refresh clears the placeholder first, so a timed-out request cannot leave the section"
          " looking as though it rendered")
    check(refresh.count("await request()") >= 2,
          "a refresh retries once, so a plane that has only just come up is not reported as absent")
    check("textContent" in panel and "innerHTML" not in panel,
          "rows are built as text, so a service message cannot inject markup into Settings")


def main():
    with tempfile.TemporaryDirectory() as directory:
        store = Path(directory) / "eveos-consoles.json"
        original_path, original_pref = P._path, W._preference_path
        try:
            # Never touch the user's real preferences from a test run.
            P._path = lambda: store
            W._preference_path = lambda: Path(directory) / "eveos-web-service.json"
            check_backend(store)
            check_overview()
        finally:
            P._path, W._preference_path = original_path, original_pref

        saved = json.loads(store.read_text(encoding="utf-8")) if store.is_file() else {}
        check(saved.get("default") is False, "the store round-trips through disk, not just memory")
        check(saved.get("keepLocalControlAfterToolStop") is False,
              "the coordinator auto-close preference round-trips through disk")

    check_panel_contract()

    print("console panel OK - preferences persist apart, lifecycle policy is visible, payload matches UI")
    print("EVEOS_CONSOLE_PANEL_SMOKE_OK")


if __name__ == "__main__":
    main()
