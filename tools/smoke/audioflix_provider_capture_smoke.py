"""Focused provider-capture authorization, isolation, endpoint and gain contracts."""

import base64
import importlib
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
module = importlib.import_module("server_modules.audioflix_provider_capture")
original_player, original_pcm, original_stop = module._player_for, module.play_pcm, module.stop_stream
calls = {"player": [], "pcm": [], "stop": []}


class Stream:
    active = True


class Player:
    stream = Stream()


try:
    module._SESSIONS.clear()
    module._player_for = lambda device, rate, channels, lane: calls["player"].append((device, rate, channels, lane)) or Player()

    def play_pcm(payload):
        calls["pcm"].append(payload)
        return {"ok": True, "deviceId": payload["deviceId"], "queued": 4}

    module.play_pcm = play_pcm
    module.stop_stream = lambda payload: calls["stop"].append(payload) or {"ok": True}
    session = module.start({"deviceId": "sd:7", "sampleRate": 48000, "channels": 1, "source": "test"})
    assert session["ok"] and session["rendererRunning"] and session["deviceId"] == "sd:7"
    assert calls["player"] == [("sd:7", 48000, 1, "provider-capture")]
    try:
        module.start({"deviceId": "sd:7"})
        raise AssertionError("concurrent capture was accepted")
    except RuntimeError as exc:
        assert "already owns" in str(exc)
    try:
        module.chunk({"sessionId": session["sessionId"], "captureToken": "wrong", "audio": "AA=="})
        raise AssertionError("bad token was accepted")
    except RuntimeError as exc:
        assert "invalid or expired" in str(exc)
    audio = base64.b64encode(b"\x01\x00\x02\x00\x03\x00\x04\x00").decode("ascii")
    result = module.chunk({
        "sessionId": session["sessionId"], "captureToken": session["captureToken"],
        "audio": audio, "channels": 1, "gain": 0.5,
    })
    assert result["ok"] and result["deviceId"] == "sd:7" and result["nonzero"]
    sent = calls["pcm"][-1]
    assert sent["lane"] == "provider-capture" and sent["strictDevice"] is True
    assert sent["streamId"] == session["sessionId"] and sent["gain"] == 0.5
    status = module.status({"sessionId": session["sessionId"], "captureToken": session["captureToken"]})
    assert status["chunks"] == 1 and status["samples"] == 4 and status["nonzeroChunks"] == 1
    stopped = module.stop({"sessionId": session["sessionId"], "captureToken": session["captureToken"]})
    assert stopped["stopped"] and calls["stop"][-1]["itemId"] == session["sessionId"]
    try:
        module.start({"deviceId": "default"})
        raise AssertionError("non-exact endpoint was accepted")
    except RuntimeError as exc:
        assert "exact native output" in str(exc)
    print("AUDIOFLIX_PROVIDER_CAPTURE_SERVER_OK auth=true exclusive=true endpoint=strict gain=true cleanup=true")
finally:
    module._SESSIONS.clear()
    module._player_for, module.play_pcm, module.stop_stream = original_player, original_pcm, original_stop
