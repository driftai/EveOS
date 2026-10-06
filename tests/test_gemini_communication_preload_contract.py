from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def read(relative_path):
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_communication_and_chat_graphs_prepare_before_layout_in_order():
    source = read("js/modules/gemini/html_loaders/html_initialization_loaders.js")

    comm_prepare = source.index("await window.prepareCommunicationPanelModules()")
    chat_prepare = source.index("await window.prepareChatLogDisplayScripts()")
    agentic_prepare = source.index("await window.prepareAgenticUILoaderScripts()")
    layout_init = source.index("await window.initializeLayoutUIHtmlComponents()")

    assert comm_prepare < chat_prepare < agentic_prepare < layout_init
    assert "Communication Panel script graph prepared before Layout initialization." in source
    assert "Chat Log Display script graph prepared before Layout initialization." in source
    assert "script.async = false" in source

    bootstrap = [
        "comm/comm.js?v=20261006.3",
        "comm/communicationPanelLoaderConfig.js?v=20261006.3",
        "comm/communicationPanelScriptLoader.js?v=20261006.3",
        "comm/communicationPanelComponentInitializer.js?v=20261006.3",
        "chat_disp/chat_disp.js?v=20261006.3",
    ]
    positions = [source.index(item) for item in bootstrap]
    assert positions == sorted(positions)


def test_communication_bootstrap_is_single_flight_and_post_layout_is_dom_only():
    comm = read("js/modules/gemini/html_loaders/comm/comm.js")
    loader = read("js/modules/gemini/html_loaders/comm/communicationPanelScriptLoader.js")
    initializer = read("js/modules/gemini/html_loaders/comm/communicationPanelComponentInitializer.js")

    assert "const communicationScriptPromises" in comm
    assert "function loadCommunicationScriptOnce" in comm
    assert "let communicationPreparationPromise = null" in comm
    assert "window.prepareCommunicationPanelModules = prepareCommunicationPanelModules" in comm
    assert "await window.communicationPanelScriptLoader.prepare();" in comm

    assert "let communicationPreparePromise = null" in loader
    assert "prepare: prepareCommunicationPanelScripts" in loader
    for hook in [
        "prepareMultimodalCommunicationScripts",
        "prepareTextInputUIScripts",
        "prepareSystemMessageToggleUIScripts",
        "prepareModelOperationsUIScripts",
        "preparePastChatsUIScripts",
        "prepareSendChatHistoryScripts",
        "prepareClearChatUIScripts",
        "prepareClearSystemLogUIScripts",
    ]:
        assert f"'{hook}'" in loader

    assert "await window.communicationPanelScriptLoader.prepare();" in initializer
    assert "document.createElement('script')" not in initializer
    assert ".loadAggregators()" not in initializer
    assert ".loadComponents()" not in initializer


def test_all_communication_groups_export_preload_hooks():
    hook_paths = {
        "prepareMultimodalCommunicationScripts": "js/modules/gemini/html_loaders/comm/mm_comm_load/multimodal_communication_html_loaders.js",
        "prepareTextInputUIScripts": "js/modules/gemini/html_loaders/comm/input_ui/text_input_ui_html_loaders.js",
        "prepareSystemMessageToggleUIScripts": "js/modules/gemini/html_loaders/comm/sys_msg/system_message_toggle_ui_html_loaders.js",
        "prepareModelOperationsUIScripts": "js/modules/gemini/html_loaders/comm/model_ops/model_operations_ui_html_loaders.js",
        "preparePastChatsUIScripts": "js/modules/gemini/html_loaders/comm/past_chats/past_chats_ui_html_loaders.js",
        "prepareSendChatHistoryScripts": "js/modules/gemini/html_loaders/comm/send_hist/send_chat_history_html_loader.js",
        "prepareClearChatUIScripts": "js/modules/gemini/html_loaders/comm/clear_chat/clear_chat_ui_html_loaders.js",
        "prepareClearSystemLogUIScripts": "js/modules/gemini/html_loaders/comm/clear_sys/clear_system_log_ui_html_loaders.js",
    }

    for hook, path in hook_paths.items():
        source = read(path)
        assert f"window.{hook} = {hook}" in source
        assert "GeminiCommunicationBootstrap?.loadScriptOnce" in source

    multimodal = read("js/modules/gemini/html_loaders/comm/mm_comm_load/multimodal_communication_html_loaders.js")
    screen_share = read("js/modules/gemini/html_loaders/comm/mm_comm_load/scr_share/screen_share_mm_html_loaders.js")
    voice_input = read("js/modules/gemini/html_loaders/comm/mm_comm_load/voice_input/voice_input_mm_html_loader.js")

    assert "window.prepareScreenShareMMUIScripts()" in multimodal
    assert "window.prepareVoiceInputMMUIScripts()" in multimodal
    assert "window.prepareScreenShareMMUIScripts = prepareScreenShareMMUIScripts" in screen_share
    assert "window.prepareVoiceInputMMUIScripts = prepareVoiceInputMMUIScripts" in voice_input


def test_chat_display_preparation_is_idempotent_and_reused_by_initializer():
    chat = read("js/modules/gemini/html_loaders/chat_disp/chat_disp.js")

    assert "const chatLogDisplayScriptPromises = new Map()" in chat
    assert "let chatLogDisplayPreparationPromise = null" in chat
    assert "function loadChatLogDisplayScriptOnce" in chat
    assert "function prepareChatLogDisplayScripts()" in chat
    assert "window.prepareChatLogDisplayScripts = prepareChatLogDisplayScripts" in chat
    assert "await prepareChatLogDisplayScripts();" in chat
    assert "script.async = false" in chat


def test_communication_preload_cache_chain_reaches_manifest():
    config = read("js/modules/gemini/html_loaders/comm/communicationPanelLoaderConfig.js")
    display = read("js/modules/gemini/client/page_initialization/page_initialization_core/displayLoader.js")
    page_loader = read("js/modules/gemini/client/page_initialization/page_initialization_core/pageInitializerLoader.js")
    master = read("js/modules/gemini/Script_Loader/Script_Loader.js")
    manifest = read("js/config/manifest/scripts.parts/13-gemini.js")

    assert config.count("?v=20261006.3") >= 8
    assert "html_initialization_loaders.js?v=20261006.3" in display
    assert "displayLoader.js?v=20261006.3" in page_loader
    assert re.search(r"pageInitializerLoader\.js\?v=20261006\.3", master)
    assert re.search(r"Script_Loader/Script_Loader\.js\?v=20261006\.3", manifest)
