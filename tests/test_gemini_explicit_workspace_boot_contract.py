from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def read(relative_path):
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_gemini_heavy_workspace_boot_requires_explicit_load():
    init = read("js/modules/gemini/gemini-init.js")
    ai_home = read("js/modules/gemini/search_monitor/searchMonitorAiHome.js")
    ai_home_markup = read("js/modules/gemini/search_monitor/searchMonitorAiHome.markup.js")

    assert "requestGeminiBoot('gemini-provider-explicit-load')" in init
    assert "requestGeminiBoot('gemini-provider-open')" not in init
    assert "let geminiWorkspaceLoaded = false;" in ai_home
    assert "if (active && gemini?.open && geminiWorkspaceLoaded) onGeminiOpen?.();" in ai_home
    assert "Load the Gemini workspace" in ai_home_markup

    view_start = init.index("function updateMonitorViewState")
    view_end = init.index("function bindMonitorViewControls", view_start)
    view_block = init[view_start:view_end]
    assert "setWorkspaceActive" in view_block
    assert "requestGeminiBoot" not in view_block


def test_workspace_ready_does_not_repeat_full_subtree_expansion():
    init = read("js/modules/gemini/gemini-init.js")

    readiness_start = init.index("function syncFullUiReadiness")
    readiness_end = init.index("function ensureExpandedWorkspace", readiness_start)
    readiness_block = init[readiness_start:readiness_end]
    assert "geminiFullReady" in readiness_block
    assert "ensureExpandedWorkspace" not in readiness_block

    ready_start = init.index("window.addEventListener('eve:gemini-workspace-ready'")
    ready_end = init.index("function injectGeminiUI", ready_start)
    ready_block = init[ready_start:ready_end]
    assert "syncFullUiReadiness(container);" in ready_block
    assert "stopFullUiPolling(container);" in ready_block
    assert "ensureExpandedWorkspace" not in ready_block


def test_freeze_era_deferred_headroom_heuristic_stays_retired():
    init = read("js/modules/gemini/gemini-init.js")

    for forbidden in [
        "GEMINI_DEFERRED_HEADROOM_MS",
        "GEMINI_DEFERRED_HEADROOM_RENEW_MS",
        "reserveDeferredLoaderHeadroom",
        "keepDeferredLoaderHeadroomWhileActive",
        "__GEMINI_DEFERRED_HEADROOM_UNTIL",
    ]:
        assert forbidden not in init


def test_explicit_workspace_boot_cache_key_is_current():
    manifest = read("js/config/manifest/scripts.parts/13-gemini.js")
    assert re.search(r"gemini-init\.js\?v=[a-f0-9]{12}", manifest)
