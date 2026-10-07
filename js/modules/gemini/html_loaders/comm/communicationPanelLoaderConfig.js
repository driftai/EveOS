/**
 * Configuration for Communication Panel UI HTML loaders.
 */

const COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/html_loaders/comm';

const communicationPanelUILoaderAggregatorScripts = [
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/mm_comm_load/multimodal_communication_html_loaders.js?v=68e812174965`,
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/input_ui/text_input_ui_html_loaders.js?v=765f87db1155`,
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/sys_msg/system_message_toggle_ui_html_loaders.js?v=40aaa77cc476`,
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/model_ops/model_operations_ui_html_loaders.js?v=2fe94e751c31`,
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/past_chats/past_chats_ui_html_loaders.js?v=f035f7c17670`,
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/send_hist/send_chat_history_html_loader.js?v=80e42d1fcd76`,
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/clear_chat/clear_chat_ui_html_loaders.js?v=f2dd8e223b69`,
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/clear_sys/clear_system_log_ui_html_loaders.js?v=62515aa67898`
];

const communicationPanelUILoaderScripts = [
    `${COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH}/btn_group/buttonGroupContainerUILoader.js?v=8d18af378001`
];

window.communicationPanelLoaderConfig = {
    basePath: COMMUNICATION_PANEL_UI_HTML_LOADERS_BASE_PATH,
    aggregatorScripts: communicationPanelUILoaderAggregatorScripts,
    loaderScripts: communicationPanelUILoaderScripts
};
