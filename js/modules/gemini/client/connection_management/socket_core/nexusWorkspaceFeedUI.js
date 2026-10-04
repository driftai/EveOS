/**
 * nexusWorkspaceFeedUI.js
 *
 * Mirrors Nexus-originated user turns into the already-open Gemini Link transcript.
 * This module is display-only: it never sends a message back to Gemini or Nexus.
 */

console.log("nexusWorkspaceFeedUI.js loading...");

(function () {
    const renderedRequestIds = new Set();
    let installed = false;

    function chatContainer() {
        const chatLog = document.getElementById('chatLog');
        return chatLog ? (chatLog.querySelector('.chat-messages-container') || chatLog) : null;
    }

    function createFallbackUserMessage(text) {
        const message = document.createElement('div');
        message.className = 'chat-message user-message message-container nexus-workspace-user-message';

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        message.appendChild(content);

        const timestamp = document.createElement('div');
        timestamp.className = 'message-timestamp';
        timestamp.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        message.appendChild(timestamp);
        return message;
    }

    function renderNexusUserMessage(data) {
        const text = String(data?.text || '').trim();
        if (!text) return;

        const requestId = String(data?.requestId || '').trim();
        if (requestId && renderedRequestIds.has(requestId)) return;

        let message = null;
        const creator = window.MessagingLog?.MessageUiCreator;
        if (creator) {
            try {
                message = creator.createMessageContainer('');
                message.classList.add('user-message', 'nexus-workspace-user-message');
                message.appendChild(creator.createMessageContent(text));
                message.appendChild(creator.createTimestamp());
                creator.appendMessageToLog(message);
            } catch (error) {
                console.warn('[Gemini Link] Could not render Nexus user turn with MessageUiCreator:', error);
                message = null;
            }
        }

        if (!message) {
            const target = chatContainer();
            if (!target) return;
            message = createFallbackUserMessage(text);
            target.appendChild(message);
            target.scrollTop = target.scrollHeight;
        }

        message.dataset.nexusWorkspaceRequestId = requestId;
        message.dataset.messageOrigin = 'nexus-browser';
        if (requestId) renderedRequestIds.add(requestId);
    }

    function install() {
        if (installed || typeof window.handleSocketMessage !== 'function') return false;
        const previousHandleSocketMessage = window.handleSocketMessage;
        window.handleSocketMessage = async function handleSocketMessageWithNexusFeed(event) {
            try {
                const data = JSON.parse(event?.data || '{}');
                if (data?.type === 'nexus_workspace_user_message') {
                    renderNexusUserMessage(data);
                    return;
                }
            } catch (error) {
                // Preserve the normal router's malformed-message handling.
            }

            return previousHandleSocketMessage(event);
        };
        installed = true;
        return true;
    }

    window.EveGeminiNexusWorkspaceFeedUI = {
        renderUserMessage: renderNexusUserMessage,
        install
    };

    if (!install()) {
        window.addEventListener('eve:gemini-socket-ready', install, { once: true });
    }
})();

console.log("nexusWorkspaceFeedUI.js loaded.");
