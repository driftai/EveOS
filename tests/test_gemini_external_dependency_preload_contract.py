import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative_path):
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_external_dependencies_are_single_flight_and_prepared_before_layout():
    initializer = read("js/modules/gemini/html_loaders/html_initialization_loaders.js")
    ext_dep = read("js/modules/gemini/html_loaders/ext_dep/ext_dep.js")

    prepare_index = initializer.index("await window.prepareExternalDependenciesLoaderScripts()")
    layout_index = initializer.index("await window.initializeLayoutUIHtmlComponents()")
    assert prepare_index < layout_index

    assert "let localStylesheetLoaderPromise = null" in ext_dep
    assert "let externalScriptsLoaderPromise = null" in ext_dep
    assert "let externalDependenciesPreparationPromise = null" in ext_dep
    assert "function loadDependencyLoaderScriptOnce" in ext_dep
    assert "if (currentPromise) return currentPromise;" in ext_dep
    assert "window.ExternalDependenciesLoadersReady = prepareExternalDependenciesLoaderScripts()" in ext_dep


def test_external_links_and_runtimes_are_idempotent_and_native_dialog_aware():
    loader = read(
        "js/modules/gemini/html_loaders/ext_dep/ext_scripts/externalStylesheetsAndScriptsUILoader.js"
    )

    assert "function appendExternalLinkOnce" in loader
    assert "if (hasExternalLink(resource.href, resource.rel)) return false;" in loader
    assert "function loadExternalScriptOnce" in loader
    assert "materialDesignLiteRuntimePromise" in loader
    assert "dialogPolyfillRuntimePromise" in loader
    assert "function prepareExternalStylesheetsAndIcons()" in loader
    assert "function prepareMaterialDesignLiteRuntime()" in loader
    assert "function prepareDialogPolyfillRuntime()" in loader

    assert "function hasNativeDialogSupport()" in loader
    assert "typeof prototype.showModal === 'function'" in loader
    assert "typeof prototype.close === 'function'" in loader
    assert "if (!hasNativeDialogSupport())" in loader
    assert "if (hasNativeDialogSupport())" in loader
    assert "return Promise.resolve('native-dialog');" in loader


def test_late_external_phase_reuses_prepared_resources_without_bulk_mdl_upgrade():
    initializer = read("js/modules/gemini/html_loaders/html_initialization_loaders.js")
    loader = read(
        "js/modules/gemini/html_loaders/ext_dep/ext_scripts/externalStylesheetsAndScriptsUILoader.js"
    )

    late_loader = loader.index("async function loadExternalStylesheetsAndScripts()")
    late_source = loader[late_loader:]
    assert "prepareExternalStylesheetsAndIcons();" in late_source
    assert "await prepareMaterialDesignLiteRuntime();" in late_source
    assert "await prepareDialogPolyfillRuntime();" in late_source

    external_index = initializer.index("await window.initializeExternalScripts()")
    finish_index = initializer.index("html_initialization_loaders.js: initializeAllHtmlComponents finished.")
    late_phase = initializer[external_index:finish_index]
    assert "componentHandler.upgradeDom()" not in late_phase
    assert "await new Promise(resolve => setTimeout(resolve, 200))" not in late_phase
    assert "Skipping redundant provider-wide MDL upgrade" in late_phase


def test_mdl_wrapper_upgrades_only_its_inserted_workspace_subtree():
    wrapper = read("js/modules/gemini/html_loaders/layout/mdl_wrap/mdlLayoutWrapperUILoader.js")

    assert "gemini-provider-runtime-host" in wrapper
    assert "const wrapper = container.lastElementChild" in wrapper
    assert "geminiMdlUpgradeTargets(wrapper)" in wrapper
    assert "componentHandler.upgradeElements(targets)" in wrapper
    assert "componentHandler.upgradeElements(document.body)" not in wrapper
    assert "componentHandler.upgradeDom()" not in wrapper


def test_workspace_boot_skips_redundant_audio_worklet_html_loader_phase():
    initializer = read("js/modules/gemini/html_loaders/html_initialization_loaders.js")
    pcm_loader = ROOT / (
        "js/modules/gemini/html_loaders/audio_worklet/pcm_proc/pcmProcessorScriptUILoader.js"
    )
    worklet_initializer = read(
        "js/modules/gemini/agentic/audio_proc/context_mgmt/initialization_modules/audioWorkletInitializer.js"
    )

    assert "audio_worklet/audio_worklet.js" not in initializer
    assert "loadAudioWorkletComponentsHTMLLoaders" not in initializer
    assert "loadPcmProcessorScript" not in initializer
    assert "Skipping redundant Audio Worklet HTML loader phase" in initializer

    assert not pcm_loader.exists()
    assert "audioWorklet.addModule" in worklet_initializer
    assert "window.AudioWorkletCode.getProcessorCode" in worklet_initializer


def test_external_dependency_cache_chain_reaches_manifest():
    ext_dep = read("js/modules/gemini/html_loaders/ext_dep/ext_dep.js")
    layout = read("js/modules/gemini/html_loaders/layout/layout.js")
    initializer = read("js/modules/gemini/html_loaders/html_initialization_loaders.js")
    display = read("js/modules/gemini/client/page_initialization/page_initialization_core/displayLoader.js")
    page_loader = read("js/modules/gemini/client/page_initialization/page_initialization_core/pageInitializerLoader.js")
    master = read("js/modules/gemini/Script_Loader/Script_Loader.js")
    manifest = read("js/config/manifest/scripts.parts/13-gemini.js")

    # Pin the external-dependency implementation and its direct loader edges.
    assert re.search(r"externalStylesheetsAndScriptsUILoader\.js\?v=[a-f0-9]{12}", ext_dep)
    assert re.search(r"mdlLayoutWrapperUILoader\.js\?v=[a-f0-9]{12}", layout)
    assert re.search(r"ext_dep/ext_dep\.js\?v=[a-f0-9]{12}", initializer)
    assert re.search(r"layout/layout\.js\?v=[a-f0-9]{12}", initializer)

    # The remaining files are shared cache-chain parents. Their revisions legitimately
    # advance when later Gemini work changes siblings such as Comm/Chat without touching
    # the external-dependency implementation guarded above.
    assert re.search(r"html_initialization_loaders\.js\?v=[^'\"`]+", display)
    assert re.search(r"displayLoader\.js\?v=[^'\"`]+", page_loader)
    assert re.search(r"pageInitializerLoader\.js\?v=[^'\"`]+", master)
    assert re.search(r"Script_Loader/Script_Loader\.js\?v=[^'\"]+", manifest)
