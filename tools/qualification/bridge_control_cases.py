"""Exact-origin and route-boundary regressions; uses the control smoke's mock runtime."""
from types import SimpleNamespace
from server_modules import eveos_control_requests as requests


def qualify_bridge_start(port, request_json):
    origin = requests.bridge_origin()
    assert origin == "chrome-extension://doioapjnmiknkdigmdoapoahlhcaikag"
    headers = {"Origin": origin, "Host": f"127.0.0.1:{port}"}
    handler = SimpleNamespace(client_address=("127.0.0.1", 1), headers=headers,
                              server=SimpleNamespace(server_address=("127.0.0.1", port)))
    starts = ("/api/nexus-browser/start", "/api/watchfusion/start")
    for route in starts:
        assert requests.can_start_bridge_service(handler, route)
    assert requests.can_start_nexus(handler, starts[0])
    assert not requests.can_start_nexus(handler, starts[1]), "Legacy Nexus-only guard remains scoped"
    for key in ("X-EveOS-Share", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"):
        headers[key] = "untrusted"
        for route in starts:
            assert not requests.can_start_bridge_service(handler, route)
        del headers[key]
    headers["Host"] = "example.com"
    for route in starts:
        assert not requests.can_start_bridge_service(handler, route)
    headers["Host"] = f"127.0.0.1:{port}"
    handler.client_address = ("192.0.2.1", 1)
    for route in starts:
        assert not requests.can_start_bridge_service(handler, route)
        code, payload = request_json(port, "POST", route, origin)
        assert code == 200 and payload["running"] is True
    for route in ("nexus-browser/stop", "nexus-browser/setup", "nexus-browser/extension",
                  "watchfusion/stop", "watchfusion/setup", "watchfusion/extension",
                  "gemini-server/start", "eveos-server/start", "eveos-server/stop"):
        code, _ = request_json(port, "POST", "/api/" + route, origin)
        assert code == 403, f"Bridge must not gain authority over {route}"
    for untrusted in ("chrome-extension://" + "a" * 32, "https://example.com"):
        for route in starts:
            code, _ = request_json(port, "POST", route, untrusted)
            assert code == 403
