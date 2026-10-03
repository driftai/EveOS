// Native output selection and activation are deliberately separate. Choosing a Windows endpoint
// configures the optional route; only the explicit Use Native Route action may suppress normal
// browser/system playback. This keeps file:// and localhost audible without VB-CABLE/Voicemeeter.
window.EveAudioflixNativeRouteState = window.EveAudioflixNativeRouteState || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixNativeRouteState;
    if (ns.ready) return;

    ns.create = function create(deps) {
        const { state, update, maybeWarm, isBridgeOffline } = deps;

        function browserRouteMode(current) {
            return current.preferredSinkId ? 'browser-selective' : 'browser';
        }

        function selectNativeOutput(deviceId, label) {
            const current = state();
            const selected = !!deviceId;
            const enabled = selected && current.nativeBridgeEnabled === true;
            const result = update({
                nativeBridgeEnabled: enabled,
                nativeOutputId: String(deviceId || ''),
                nativeOutputLabel: String(label || '').trim(),
                nativeSuppressBrowserPlayback: enabled && current.nativeSuppressBrowserPlayback === true,
                nativeRouteDefaultV2Applied: true,
                routeMode: enabled ? 'native-bridge' : browserRouteMode(current)
            }, 'audioflix-native-output');
            if (enabled) maybeWarm();
            return result;
        }

        function selectNativeInput(deviceId, label) {
            return update({
                nativeInputId: String(deviceId || ''),
                nativeInputLabel: String(label || '').trim()
            }, 'audioflix-native-input');
        }

        function setNativeBridgeEnabled(enabled) {
            const current = state();
            const active = enabled === true && !!current.nativeOutputId;
            const result = update({
                nativeBridgeEnabled: active,
                nativeSuppressBrowserPlayback: active,
                nativeRouteDefaultV2Applied: true,
                routeMode: active ? 'native-bridge' : browserRouteMode(current)
            }, 'audioflix-native-bridge-toggle');
            if (active) maybeWarm();
            return result;
        }

        function shouldSuppressBrowserPlayback() {
            if (isBridgeOffline()) return false;
            const current = state();
            return current.nativeBridgeEnabled === true
                && current.nativeSuppressBrowserPlayback === true
                && !!current.nativeOutputId;
        }

        return { selectNativeOutput, selectNativeInput, setNativeBridgeEnabled, shouldSuppressBrowserPlayback };
    };

    ns.ready = true;
})();
