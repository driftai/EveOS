/**
 * Orchestrates initialization of the already-prepared Communication Panel components.
 * Script loading is completed before Layout construction by comm.js.
 */

const communicationHandlerChecks = [
    () => window.CommunicationPanel?.MultimodalCommunicationPanel?.VoiceInputMMCommunicationPanel?.VoiceInputButtonHandlers?.initializeVoiceInputButtonHandlers,
    () => window.CommunicationPanel?.SystemMessageToggleCommunicationPanel?.initializeSystemMessageToggleHandler,
    () => window.CommunicationPanel?.ReinitiateModelCommunicationPanel?.initializeModelInitializer,
    () => window.CommunicationPanel?.StartNewChatCommunicationPanel?.initializeNewChatHandler,
    () => window.CommunicationPanel?.TogglePastChatsCommunicationPanel?.PastChatsUI?.initializePastChatsVisibilityToggler,
    () => window.CommunicationPanel?.ClearChatCommunicationPanel?.initializeClearChatHandler,
    () => window.CommunicationPanel?.ClearSystemLogCommunicationPanel?.initializeClearSystemLogHandler
];
const lateCommunicationBindings = communicationHandlerChecks.slice(1);

async function waitForCommunicationHandlers(timeoutMs = 12000) {
    const startedAt = Date.now();
    while (communicationHandlerChecks.some(check => typeof check() !== 'function')) {
        if (Date.now() - startedAt >= timeoutMs) {
            console.warn('Communication Panel handlers did not all become ready before UI initialization.');
            return false;
        }
        await new Promise(resolve => window.setTimeout(resolve, 40));
    }
    return true;
}

async function initializeCommunicationPanelComponents() {
    console.log('communicationPanelComponentInitializer.js: initializeCommunicationPanelComponents started.');

    try {
        if (!window.communicationPanelScriptLoader?.prepare) {
            throw new Error('communicationPanelScriptLoader.prepare not found');
        }

        await window.communicationPanelScriptLoader.prepare();
        console.log('communicationPanelComponentInitializer.js: Preloaded Communication Panel scripts confirmed.');

        if (typeof window.loadButtonGroupContainer === 'function') {
            await window.loadButtonGroupContainer();
            console.log('Button Group Container loaded.');
        } else {
            console.error('loadButtonGroupContainer function not found after preparation.');
        }

        if (typeof window.initializeMultimodalCommunicationHtmlComponents === 'function') {
            await window.initializeMultimodalCommunicationHtmlComponents();
            console.log('Multimodal Communication Panel HTML Components initialized.');
        } else {
            console.error('initializeMultimodalCommunicationHtmlComponents function not found after preparation.');
        }

        if (typeof window.initializeTextInputUIHtmlComponents === 'function') {
            await window.initializeTextInputUIHtmlComponents();
            console.log('Text Input UI HTML Components initialized.');
        } else {
            console.error('initializeTextInputUIHtmlComponents function not found after preparation.');
        }

        if (typeof window.initializeSystemMessageToggleUIHtmlComponents === 'function') {
            await window.initializeSystemMessageToggleUIHtmlComponents();
            console.log('System Message Toggle UI HTML Components initialized.');
        } else {
            console.error('initializeSystemMessageToggleUIHtmlComponents function not found after preparation.');
        }

        if (typeof window.initializeModelOperationsUIHtmlComponents === 'function') {
            await window.initializeModelOperationsUIHtmlComponents();
            console.log('Model Operations UI HTML Components initialized.');
        } else {
            console.error('initializeModelOperationsUIHtmlComponents function not found after preparation.');
        }

        if (typeof window.initializePastChatsUIHtmlComponents === 'function') {
            await window.initializePastChatsUIHtmlComponents();
            console.log('Past Chats UI HTML Components initialized.');
        } else {
            console.error('initializePastChatsUIHtmlComponents function not found after preparation.');
        }

        if (typeof window.initializeSendChatHistoryUIHtmlComponents === 'function') {
            await window.initializeSendChatHistoryUIHtmlComponents();
            console.log('Send Chat History UI HTML Components initialized.');
        } else {
            console.error('initializeSendChatHistoryUIHtmlComponents function not found after preparation.');
        }

        if (typeof window.initializeClearChatUIHtmlComponents === 'function') {
            await window.initializeClearChatUIHtmlComponents();
            console.log('Clear Chat UI HTML Components initialized.');
        } else {
            console.error('initializeClearChatUIHtmlComponents function not found after preparation.');
        }

        if (typeof window.initializeClearSystemLogUIHtmlComponents === 'function') {
            await window.initializeClearSystemLogUIHtmlComponents();
            console.log('Clear System Log UI HTML Components initialized.');
        } else {
            console.error('initializeClearSystemLogUIHtmlComponents function not found after preparation.');
        }

        if (await waitForCommunicationHandlers(30000)) {
            lateCommunicationBindings.forEach(function (check) {
                const initialize = check();
                if (typeof initialize === 'function') initialize();
            });
        }
    } catch (error) {
        console.error('Error in initializeCommunicationPanelComponents:', error);
        throw error;
    }

    console.log('communicationPanelComponentInitializer.js: initializeCommunicationPanelComponents finished.');
}

window.initializeCommunicationPanelComponents = initializeCommunicationPanelComponents;
