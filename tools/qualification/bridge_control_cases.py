"""Exact-origin and route-boundary regressions; uses the control smoke's mock runtime."""
from types import SimpleNamespace
from server_modules import eveos_control_requests as requests


def qualify_bridge_start(port, request_json):
    origin = requests.bridge_origin()
    assert origin == "chrome-extension://doioapjnmiknkdigmdoapoahlhcaikag"
    headers = {"Origin": origin, "Host": f"127.0.0.1:{port}"}
    handler = SimpleNamespace(client_address=("127.0.0.1", 1), headers=headers,
                              server=SimpleNamespace(server_address=("127.0.0.1", port)))
    assert requests.can_start_nexus(handler, "/api/nexus-browser/start")
    for key in ("X-EveOS-Share", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"):
        headers[key] = "untrusted"
        assert not requests.can_start_nexus(handler, "/api/nexus-browser/start")
        del headers[key]
    headers["Host"] = "example.com"
    assert not requests.can_start_nexus(handler, "/api/nexus-browser/start")
    headers["Host"] = f"127.0.0.1:{port}"
    handler.client_address = ("192.0.2.1", 1)
    assert not requests.can_start_nexus(handler, "/api/nexus-browser/start")
    code, payload = request_json(port, "POST", "/api/nexus-browser/start", origin)
    assert code == 200 and payload["running"] is True
    for route in ("nexus-browser/stop", "nexus-browser/setup", "nexus-browser/extension",
                  "gemini-server/start", "watchfusion/start", "eveos-server/stop"):
        code, _ = request_json(port, "POST", "/api/" + route, origin)
        assert code == 403, f"Bridge must not gain authority over {route}"
    for untrusted in ("chrome-extension://" + "a" * 32, "https://example.com"):
        code, _ = request_json(port, "POST", "/api/nexus-browser/start", untrusted)
        assert code == 403
