const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..', '..');

function loadScript(context, relativePath) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    vm.runInContext(source, context, { filename: relativePath });
}

async function main() {
    const statuses = [];
    const messages = [];
    const context = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        WebSocket: { OPEN: 1 },
        window: {},
        document: {
            getElementById() {
                return null;
            }
        },
        localStorage: {
            values: new Map([['geminiServerDesiredState', 'running']]),
            getItem(key) {
                return this.values.has(key) ? this.values.get(key) : null;
            },
            setItem(key, value) {
                this.values.set(key, String(value));
            },
            removeItem(key) {
                this.values.delete(key);
            }
        },
        CustomEvent: class CustomEvent {
            constructor(type, options = {}) {
                this.type = type;
                this.detail = options.detail;
            }
        },
        updateConnectionStatus(status, message) {
            statuses.push({ status, message });
        },
        displayMessage(message) {
            messages.push(String(message));
        },
    };
    context.window = context;
    context.window.dispatchEvent = function (event) {
        messages.push(`event:${event.type}`);
    };
    context.window.SocketGlobalState = {
        APPLICATION_PONG_MESSAGE: 'pong',
        credentialRequired: false,
        apiPolicyBlocked: false,
        apiKeyInvalid: false,
        credentialStatusMessage: '',
        geminiApiReady: true,
        autoReconnectEnabled: true,
        serverOfflinePauseActive: false,
        reconnectTimeout: setTimeout(() => {}, 5000),
        continuousReconnectInterval: setTimeout(() => {}, 5000),
        resetState() {
            this.credentialRequired = false;
            this.apiPolicyBlocked = false;
            this.apiKeyInvalid = false;
            this.credentialStatusMessage = '';
            this.geminiApiReady = false;
        },
    };
    context.window.SocketConnectionCore = { EventHandlers: {} };
    context.window.SocketConnectionCore.startAutoReconnect = function () {
        context.window.SocketGlobalState.autoReconnectStarted = true;
    };
    vm.createContext(context);

    loadScript(context, 'js/modules/gemini/client/connection_management/socket_core/geminiApiFailure.js');
    loadScript(context, 'js/modules/gemini/client/connection_management/socket_core/socketMessageRouter.js');
    loadScript(context, 'js/modules/gemini/client/connection_management/socket_core/scc/eh/closeEventHandler.js');
    loadScript(context, 'js/modules/gemini/server_control/geminiCredentialWorkflow.js');

    await context.window.handleSocketMessage({
        data: JSON.stringify({
            text: 'Error connecting to Gemini API: API error (received 1007 (invalid frame payload data) api key not valid. please pass a valid api key.)',
            is_system_message: true,
            is_error: true,
        })
    });

    const state = context.window.SocketGlobalState;
    if (!state.credentialRequired || !state.apiKeyInvalid || state.apiPolicyBlocked) {
        throw new Error(`Invalid API key was not classified correctly: ${JSON.stringify(state)}`);
    }
    if (state.autoReconnectEnabled || !state.serverOfflinePauseActive) {
        throw new Error(`Reconnect was not paused for invalid API key: ${JSON.stringify(state)}`);
    }
    if (state.reconnectTimeout || state.continuousReconnectInterval) {
        throw new Error('Reconnect timers were not cleared for invalid API key.');
    }
    if (!statuses.some((entry) => entry.status === 'error' && entry.message === 'API Key Invalid')) {
        throw new Error(`API Key Invalid status was not shown: ${JSON.stringify(statuses)}`);
    }
    if (!messages.some((message) => /rejected the saved API key as invalid/i.test(message))) {
        throw new Error(`Helpful invalid-key message was not displayed: ${JSON.stringify(messages)}`);
    }

    context.window.SocketConnectionCore.EventHandlers.handleClose({ code: 1007, reason: 'invalid key' });
    const lastStatus = statuses[statuses.length - 1] || {};
    if (lastStatus.message !== 'API Key Invalid') {
        throw new Error(`Close handler did not preserve invalid-key status: ${JSON.stringify(statuses)}`);
    }

    let syncedKey = '';
    context.window.GeminiServerControl = {
        async syncCredentials(options) {
            syncedKey = String(options?.apiKey || '');
            return { ok: true, configured: !!syncedKey };
        },
        reconcileClientConnection() {
            context.window.SocketGlobalState.reconciled = true;
        }
    };
    await context.window.GeminiCredentialWorkflow.saveCredentials('FAKE_TEST_KEY_DO_NOT_USE');
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (syncedKey !== 'FAKE_TEST_KEY_DO_NOT_USE') {
        throw new Error('Credential workflow did not forward the new key to the credential bridge.');
    }
    if (context.localStorage.getItem('geminiConnectionEnabled') !== 'true'
        || context.localStorage.getItem('geminiServerDesiredState') !== 'running') {
        throw new Error('Credential save did not restore desired running/reconnect preferences.');
    }
    const cleared = context.window.SocketGlobalState;
    if (cleared.credentialRequired || cleared.apiPolicyBlocked || cleared.apiKeyInvalid || !cleared.autoReconnectEnabled || cleared.serverOfflinePauseActive) {
        throw new Error(`Credential save did not clear the invalid-key gate: ${JSON.stringify(cleared)}`);
    }
    if (!cleared.reconciled || !cleared.autoReconnectStarted) {
        throw new Error(`Credential save did not request a fresh reconnect: ${JSON.stringify(cleared)}`);
    }

    const currentSocket = {};
    const staleSocket = {};
    context.window.webSocket = currentSocket;
    await context.window.handleSocketMessage({
        target: staleSocket,
        data: JSON.stringify({
            text: 'Error connecting to Gemini API: api key not valid. please pass a valid api key.',
            is_system_message: true,
            is_error: true,
        })
    });
    if (context.window.SocketGlobalState.apiKeyInvalid || context.window.SocketGlobalState.credentialRequired) {
        throw new Error('Stale socket invalid-key message re-poisoned the fresh credential state.');
    }

    Object.assign(context.window.SocketGlobalState, {
        credentialRequired: false,
        apiPolicyBlocked: false,
        apiKeyInvalid: false,
        credentialStatusMessage: '',
        geminiApiReady: false,
        autoReconnectEnabled: true,
        serverOfflinePauseActive: false,
        reconnectTimeout: setTimeout(() => {}, 5000),
        continuousReconnectInterval: setTimeout(() => {}, 5000)
    });
    await context.window.handleSocketMessage({
        data: JSON.stringify({
            text: 'API error: the provided API key has an IP address restriction. The originating IP address of the call (203.0.113.25) violates this restriction.',
            is_system_message: true,
            is_error: true,
        })
    });
    if (!state.credentialRequired || !state.apiPolicyBlocked || state.apiKeyInvalid
        || state.credentialStatusMessage !== 'API Key IP Mismatch') {
        throw new Error(`IP restriction was not classified precisely: ${JSON.stringify(state)}`);
    }
    if (!messages.some((message) => /203\.0\.113\.25.*ip allowlist/i.test(message))) {
        throw new Error(`IP restriction guidance was not displayed: ${JSON.stringify(messages)}`);
    }

    Object.assign(context.window.SocketGlobalState, {
        credentialRequired: false,
        apiPolicyBlocked: false,
        apiKeyInvalid: false,
        credentialStatusMessage: '',
        geminiApiReady: false,
        autoReconnectEnabled: true,
        serverOfflinePauseActive: false
    });
    await context.window.handleSocketMessage({
        data: JSON.stringify({
            text: 'API error (received 1008 policy violation): temporary service disruptions are affecting Gemini.',
            is_system_message: true,
            is_error: true,
        })
    });
    if (state.credentialRequired || state.apiPolicyBlocked || state.apiKeyInvalid
        || !state.autoReconnectEnabled || state.serverOfflinePauseActive) {
        throw new Error(`Temporary 1008 incorrectly poisoned credential state: ${JSON.stringify(state)}`);
    }

    console.log('GEMINI_INVALID_API_KEY_GATE_SMOKE_OK');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
