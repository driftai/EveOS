"""Forward fixed extension-folder actions to the verified host-local runtime."""
import http.client
import json


def open_extension_folder(package: str = "watchfusion") -> dict:
    from . import watchfusion_control
    if package not in {"official", "watchfusion"}:
        return {"ok": False, "message": "Unknown extension package."}
    if not watchfusion_control._health():
        return {"ok": False, "message": "Start WatchFusion on this PC first."}
    connection = http.client.HTTPConnection("127.0.0.1", watchfusion_control.WATCHFUSION_PORT, timeout=15)
    try:
        connection.request("POST", f"/api/setup/open-extension-folder?package={package}", headers={"Connection": "close"})
        response = connection.getresponse()
        result = json.loads(response.read(65536).decode("utf-8"))
        if response.status != 200 or not isinstance(result, dict):
            return {"ok": False, "message": result.get("error", "Folder could not be opened.") if isinstance(result, dict) else "Invalid runtime response."}
        return result
    except (OSError, ValueError, UnicodeError, http.client.HTTPException) as error:
        return {"ok": False, "message": f"Could not open extension folder: {error}"}
    finally:
        connection.close()
