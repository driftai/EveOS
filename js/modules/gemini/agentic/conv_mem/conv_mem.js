// js/modules/gemini/agentic/Conversation_Memory_Agentic/Conversation_Memory_Agentic.js
// Loads and connects all conversation memory related functionality

console.log("js/modules/gemini/agentic/Conversation_Memory_Agentic/Conversation_Memory_Agentic.js started loading");

// Initialize the ConversationMemoryAgentic namespace
window.ConversationMemoryAgentic = window.ConversationMemoryAgentic || {};

// Define the base path for conversation memory modules
const CONVERSATION_MEMORY_BASE_PATH = (window.GEMINI_APP_ROOT || '') + 'js/modules/gemini/agentic/conv_mem';

// List of conversation memory related scripts to load
const conversationMemoryScripts = [
    // Core state management
    `${CONVERSATION_MEMORY_BASE_PATH}/chat_history_state/chatHistoryState.js?v=eddf7a3276ce`,
    `${CONVERSATION_MEMORY_BASE_PATH}/chat_history_management/historyStateResetter.js?v=5f3c8ac82a7b`,

    // Memory and context control
    `${CONVERSATION_MEMORY_BASE_PATH}/context_memory_toggle_handler/contextMemoryToggleHandler.js?v=fbe9b809e6db`,

    // History sending operations
    `${CONVERSATION_MEMORY_BASE_PATH}/chat_history_sending_operations/chatHistorySender.js?v=6deeeb1043b0`,
    `${CONVERSATION_MEMORY_BASE_PATH}/loaded_history_context_sending/loadedHistoryContextSender.js?v=f4115dfef1e2`,
    `${CONVERSATION_MEMORY_BASE_PATH}/initial_context_sending/initialContextSender.js?v=65b8f2517ebb`,
    `${CONVERSATION_MEMORY_BASE_PATH}/current_chat_context_sending/currentChatContextSender.js?v=f3e1dc0324a7`
];

// Load all conversation memory related scripts
function loadConversationMemoryScripts() {
    const fragment = document.createDocumentFragment();
    conversationMemoryScripts.forEach(scriptPath => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.defer = true;
        fragment.appendChild(script);
    });
    document.head.appendChild(fragment);
}

// Initialize the conversation memory module
function initializeConversationMemoryModule() {
    // Initialize any required state or event listeners here
    console.log("Initializing Conversation Memory Agentic module...");

    // Set up initial state
    Object.assign(window.ConversationMemoryAgentic, {
        resetHistoryState: null,    // Will be defined by historyStateResetter.js
        sendChatHistory: null,      // Will be defined by chatHistorySender.js
        sendInitialContext: null,   // Will be defined by initialContextSender.js
        sendCurrentChatAsContext: null, // Will be defined by currentChatContextSender.js
        historyLoaded: false,       // Will be managed by chatHistoryState.js
        historyMessages: new Set(), // Will be managed by chatHistoryState.js
        historyMessageOrder: [],    // Will be managed by chatHistoryState.js
        contextMemoryEnabled: true, // Default value, will be managed by contextMemoryToggleHandler.js
        ...window.ConversationMemoryAgentic
    });

    // Set up event listener for WebSocket connection to send initial context
    window.addEventListener('websocketConnected', () => {
        console.log("WebSocket connected, checking if initial context needs to be sent");
        // Check if chat was restored and context memory is enabled
        const chatRestored = localStorage.getItem('chatRestored') === 'true';
        if (chatRestored && window.ConversationMemoryAgentic.isContextMemoryEnabled()) {
            console.log("Chat was restored and context memory is enabled, scheduling initial context send");
            window.ConversationMemoryAgentic.scheduleInitialContextSending(true);
        }
    });

    console.log("Conversation Memory Agentic module initialized");
}

// Establish defaults/listeners before loading implementations, without a timer that can
// later erase functions or history populated by those implementations.
initializeConversationMemoryModule();
loadConversationMemoryScripts();

console.log("js/modules/gemini/agentic/Conversation_Memory_Agentic/Conversation_Memory_Agentic.js finished loading and initial execution");
