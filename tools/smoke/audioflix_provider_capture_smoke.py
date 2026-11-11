"""Focused provider-capture authorization, isolation, endpoint and gain contracts."""

import base64
import importlib
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
module = importlib.import_module("server_modules.audioflix_provider_capture")
original_player, original_pcm, original_stop = module._player_for, module.play_pcm, module.stop_stream
original_health = module.stream_health
renderer_health = {"ok": True}
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
    # The fake _player_for/play_pcm do not populate the real native registry.
    # Model the status health check for this fake, including physical failure.
    module.stream_health = lambda device, lane, sid: {
        "ok": renderer_health["ok"] and device == "sd:7"
        and lane == "provider-capture" and sid in module._SESSIONS
    }
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
    # A stopped sharing tab may leave a managed-only native PCM lease.
    # Reclaim only after a quiet period and only for the identical endpoint.
    original_now = module._now
    clock = [1000.0]
    module._now = lambda: clock[0]
    try:
        existing = module.start({"deviceId": "sd:7", "source": "managed-spotify"})
        clock[0] += 14
        try:
            module.start({"deviceId": "sd:7", "source": "managed-spotify"})
            raise AssertionError("active grace-period capture was stolen")
        except RuntimeError as exc:
            assert "already owns" in str(exc)
        clock[0] += 2
        try:
            module.start({"deviceId": "sd:8", "source": "managed-spotify"})
            raise AssertionError("different endpoint reclaimed the provider lane")
        except RuntimeError as exc:
            assert "already owns" in str(exc)
        try:
            module.start({"deviceId": "sd:7", "source": "provider-tab"})
            raise AssertionError("unrelated provider stole managed lane")
        except RuntimeError as exc:
            assert "already owns" in str(exc)
        recovered = module.start({"deviceId": "sd:7", "source": "managed-spotify"})
        assert recovered["sessionId"] != existing["sessionId"]
        assert calls["stop"][-1]["itemId"] == existing["sessionId"]
        try:
            module.status({"sessionId": existing["sessionId"], "captureToken": existing["captureToken"]})
            raise AssertionError("old session token survived recovery")
        except RuntimeError as exc:
            assert "invalid or expired" in str(exc)
        module.chunk({"sessionId": recovered["sessionId"], "captureToken": recovered["captureToken"],
                      "audio": audio, "channels": 1})
        clock[0] += 8
        try:
            module.start({"deviceId": "sd:7", "source": "managed-spotify"})
            raise AssertionError("recent PCM was interrupted by retry")
        except RuntimeError as exc:
            assert "already owns" in str(exc)
        module.stop({"sessionId": recovered["sessionId"], "captureToken": recovered["captureToken"]})
    finally:
        module._now = original_now
    # The real status path must still fail closed and retire a dead renderer.
    dead = module.start({"deviceId": "sd:7", "source": "provider-tab"})
    renderer_health["ok"] = False
    try:
        module.status({"sessionId": dead["sessionId"], "captureToken": dead["captureToken"]})
        raise AssertionError("dead native renderer was reported healthy")
    except RuntimeError as exc:
        assert "native renderer became unavailable" in str(exc)
    assert dead["sessionId"] not in module._SESSIONS
    assert calls["stop"][-1]["itemId"] == dead["sessionId"]
    try:
        module.status({"sessionId": dead["sessionId"], "captureToken": dead["captureToken"]})
        raise AssertionError("dead native renderer session was not invalidated")
    except RuntimeError as exc:
        assert "invalid or expired" in str(exc)
    print("AUDIOFLIX_PROVIDER_CAPTURE_SERVER_OK auth=true exclusive=true endpoint=strict gain=true cleanup=true health=true fail_closed=true")
finally:
    module._SESSIONS.clear()
    module._player_for, module.play_pcm, module.stop_stream = original_player, original_pcm, original_stop
    module.stream_health = original_health
