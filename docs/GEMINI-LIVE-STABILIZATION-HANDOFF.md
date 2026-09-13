# Gemini Live stabilization: bounded local findings

This is **not a completed Live/audio qualification**. Start from the commit containing
this document; do not replay the original remote research or reinstall anything.

## Source state and verified fixes

Started clean at `1265945c6f47db8f1c38a89f75013d1adac2f3db`, fast-forwarded to Eve's
`12241bda41fcc13dac9d6d88151b7dc0059b6d11`. Generated asset references were refreshed.

- Eve's copy-before-transfer fix is preserved. `gemini_audio_resend_smoke.js` uses
  real transferable `structuredClone` detachment: samples survive caching/resend,
  sequence IDs advance only on success, successful transfer does not duplicate-send,
  copy fallback works, failed delivery uses fallback playback, and cache trims to 16.
- A fixed 500ms aggregator refresh still captured stale namespaces. Live getters now
  preserve the aggregate identity while resolving late/replaced child namespaces.
- Self-talk's real namespace is `AiSelfTalkAgentic`, not the outer loader's empty
  `AISelfTalkAgentic` placeholder. The aggregator now resolves the implementation.
- Conversation Memory's delayed initializer overwrote loaded methods/history with
  defaults. Defaults now initialize synchronously before child loading and preserve
  the existing object/state.
- Screen capture advertised four null accessors. They now refer to the existing
  capture pipeline's window state, with boolean/frame type checks. They do **not**
  start capture or bypass browser permission.

The new deterministic initialization test failed before the fixes. A strengthened
real-browser test also exposed the self-talk/screen gaps, then passed after repair.

## Actual pipeline and architecture boundary

`Script_Loader/Script_Loader.js` loads client connection/setup/response modules,
six agentic loaders, context relay and UI, then the aggregators. Child loading is
asynchronous. Connection uses `socket_core/scc/socketLifecycle.js`,
`autoSetupHandler.js`, and `socketMessageRouter.js`. The Python backend builds
`create_gemini_config`, starts the Live session and reads `response_parser.py`.

Audio returns through `socketAudioLogic.js` -> `ingestCoordinator.js`.
**Interim chunks go to `InterimIngestHandler`, not the worklet resend path.** Final
audio may use sequential/worklet/fallback playback; Audioflix can own a native route.
Therefore the seed worklet correction alone is not proof of corrected live speech.
No buffer thresholds or output routing were changed in this pass.

Two substantial missing contracts require Eve's source/design pass:

1. `api_configuration/gemini_config.py:create_gemini_config` declares no tools;
   `response_processing/stream_handling/response_parser.py:_receive_responses`
   skips metadata-only messages without handling `tool_call`; the websocket message
   router has no FunctionResponse round trip. Searching the backend found no
   `function_calls`, `function_declarations`, or `send_tool_response` implementation.
   The browser groups below are controls, **not registered model-callable tools**.
2. The response parser has no `server_content.interrupted` handling and the browser
   socket router has no corresponding interruption event. Design cancellation across
   pending ingestion, interim sources, worklet, fallback and native audio together;
   merely calling a stop function can leave already-queued async ingestion alive.

Do not automatically expose every browser function to Gemini. Eve should define an
allowlisted schema/permission contract, matching id/name responses, controlled
errors, cancellation and stale-session rules before local end-to-end qualification.

## Browser inventory (not Live tool validation)

All six groups now resolve callable functions in the rendered browser. Existing
legacy null aliases remain in some namespaces; they are not validated APIs.

| Group | Callable exports observed | Live declaration / execution / response |
| --- | --- | --- |
| TimePerception | formatTime, initializeTimePerceptionFeature, isTimePerceptionEnabled, parseTimestamp | Not implemented |
| ConversationMemory | getHistoryMessageOrder, getHistoryMessagesSet, initializeContextMemoryToggle, isContextMemoryEnabled, isHistoryLoaded, resetHistoryState, scheduleInitialContextSending, sendChatHistory, sendCurrentChatAsContext, sendLoadedHistoryAsContext, setContextMemoryEnabled, setHistoryLoaded | Not implemented |
| AISelfTalk | getAISelfTalkState, initializeAiSelfTalk, initiateSelftalk, loadAiSelfTalkSettingsDialog, resetConsecutiveSelfTalks | Not implemented |
| AudioProcessingControls | createContainerAudioContext, ensureAudioContextReady, getInterimAudioState, initializeAudioContext, initializeAudioContextOnUserGesture, initializeAudioProcessingPreferences, initializeAudioSettingsDialog, initializeAutoAudioPlayToggle, initializeInterimAudioToggle, initializeSequentialAudioPlayToggle, initializeVoiceAnnouncementsToggle, initializeVoiceSelection, isCreateObjectURLAvailable, isIOSDevice, isSecureContext, playAudioWithFallbackMethod, playAudioWithHTML5Fallback, safeDisplayMessage, setInterimAudioState | Not implemented |
| SessionControls | initializeSessionControlsSettings | Not implemented |
| ScreenCaptureInterval | getCurrentFrame, getScreenSharingState, setCurrentFrame, setScreenSharingState | Not implemented |

Context Relay is `features/modular-state-sync/modular-state-sync.api.context*.js`
plus the loaded Gemini Live Link UI, labeled **EveOS Context Relay**. Context
smokes pass. Browser checks covered relay toggle persistence, audio/self-talk
dialogs, credential-save routing with a mock vault, and session dialog geometry
at 520x700 and 1600x1000. No UI redesign was justified by those passing checks.
This is not a full fullscreen, listening, or visual/audio quality qualification.

## Evidence and remaining gates

- Focused search-monitor/audio/context suites passed before changes and after the
  first initialization changes. Deep profile passed (Node DEP0190 warning remains).
- New initialization and transfer-resend smokes passed.
- Strengthened `gemini_agentic_controls_browser_smoke.js` passed: six callable
  groups, rendered control interactions and viewport bounds, no page errors.
- Final uncached repository gate is required before landing this change; consult
  the accompanying commit/report for its result.
- Local backend identified itself as `eveos-gemini-live` on configured 9085/9086
  and reported **one active session**. It was not restarted or displaced. Existing
  encrypted credentials were checked only for presence; no keys were exposed.
- Real Live turns, acoustic quality, arrival/underflow metrics, interruption,
  resumption and tool continuation remain **NOT QUALIFIED**, not PASS.

Next: Eve supplies the allowlisted tool/interruption design and bounded source
changes; then local proof uses an explicitly controlled Live session and measures
the actual interim/native playback route. Preserve selected model/reasoning.

Official contract checked 2026-09-13:
[Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
and [Live tools](https://ai.google.dev/gemini-api/docs/live-api/tools).
Output is PCM16LE 24kHz; input is natively 16kHz with declared-rate resampling
supported. Gemini 3.1 Flash Live uses sequential tool calling, not NON_BLOCKING.
The application must explicitly return tool responses. These provider contracts
do not establish that this application's missing bridge works.
