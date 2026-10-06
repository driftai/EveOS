from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative_path):
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_svg_monitor_is_scoped_coalesced_and_owned_by_workspace():
    monitor = read(
        "js/modules/gemini/client/page_initialization/svg_fixing/svg_fixing_core/svgDomMonitor.js"
    )
    logic = read(
        "js/modules/gemini/client/page_initialization/svg_fixing/svg_fixing_core/svgFixLogic.js"
    )
    coordinator = read(
        "js/modules/gemini/client/page_initialization/svg_fixing/svg_fixing_core/svgFixerCoordinator.js"
    )
    lifecycle = read(
        "js/modules/gemini/client/page_initialization/page_initialization_core/svgLifecycle.js"
    )

    assert "gemini-provider-runtime-host" in monitor
    assert "state.observer.observe(root" in monitor
    assert "observe(document.documentElement" not in monitor
    assert "pendingFixTimer" in monitor
    assert "fixSvgViewBoxIssues(state.root)" in monitor
    assert "stopSvgViewBoxMonitor" in monitor

    assert "const scope = root" in logic
    assert "scope.querySelectorAll('svg')" in logic
    assert "document.querySelectorAll" not in logic

    assert "fixSvgViewBoxIssues(root)" in coordinator
    assert "stopSvgViewBoxMonitor" in coordinator

    assert "startMonitoring" in lifecycle
    assert "stopMonitoring" in lifecycle
    assert "setInterval" not in lifecycle
    assert "live monitoring deferred until workspace ready" in lifecycle


def test_svg_maintenance_arms_after_ready_without_reordering_connectivity():
    coordinator = read(
        "js/modules/gemini/client/page_initialization/page_initialization_core/initializationCoordinator.js"
    )

    html_ready = coordinator.index("await Core.DisplayLoader.loadHtmlComponents();")
    connectivity = coordinator.index("await Core.ConnectivityStartup.init();")
    ready_dispatch = coordinator.index(
        "window.dispatchEvent(new CustomEvent('eve:gemini-workspace-ready'"
    )
    maintenance = coordinator.index("const armSvgMaintenance")

    assert html_ready < connectivity < ready_dispatch < maintenance

    before_ready = coordinator[html_ready:ready_dispatch]
    assert "Core.SvgLifecycle.runFixes();" not in before_ready
    assert "Core.SvgLifecycle.startMonitoring();" not in before_ready

    after_ready = coordinator[ready_dispatch:]
    assert "Core.SvgLifecycle.runFixes();" in after_ready
    assert "Core.SvgLifecycle.startMonitoring();" in after_ready
    assert "requestIdleCallback" in after_ready

    # Do not restore the donor's freeze-era settle/headroom delay heuristic.
    assert "GEMINI_POST_READY_SETTLE_MS" not in coordinator
    assert "1200" not in coordinator


def test_scoped_svg_fix_cache_chain_is_busted():
    svg_loader = read(
        "js/modules/gemini/client/page_initialization/svg_fixing/svgFixerLoader.js"
    )
    page_loader = read(
        "js/modules/gemini/client/page_initialization/page_initialization_core/pageInitializerLoader.js"
    )
    master = read("js/modules/gemini/Script_Loader/Script_Loader.js")
    manifest = read("js/config/manifest/scripts.parts/13-gemini.js")

    assert "svgFixLogic.js?v=20261006.1" in svg_loader
    assert "svgDomMonitor.js?v=20261006.1" in svg_loader
    assert "svgFixerCoordinator.js?v=20261006.1" in svg_loader
    assert "svgLifecycle.js?v=20261006.1" in page_loader
    assert "initializationCoordinator.js?v=20261006.1" in page_loader
    assert "svgFixerLoader.js?v=20261006.1" in master
    assert "pageInitializerLoader.js?v=20261006.1" in master
    assert "Script_Loader/Script_Loader.js?v=20261006.1" in manifest
