from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"expected source block missing in {path}: {old!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace(
    "server_modules/piano_player_control.py",
    'from . import eveos_console_prefs\n\n\nPIANO_PORT = int(os.environ.get("PIANO_PLAYER_PORT") or 8771)',
    'from . import eveos_console_prefs, eveos_ports\n\n\nPIANO_PORT = eveos_ports.service_port("PIANO_PLAYER_PORT")',
)

replace(
    "server_modules/world_book_control.py",
    'from . import gemini_control\n\n\nWORLD_BOOK_PORT = int(os.environ.get("WORLD_BOOK_PORT") or 8766)',
    'from . import eveos_ports, gemini_control\n\n\nWORLD_BOOK_PORT = eveos_ports.service_port("WORLD_BOOK_PORT")',
)

replace(
    "server_modules/eveos_web_control.py",
    'from pathlib import Path\n\n\nEVEOS_WEB_PORT = int(os.environ.get("EVEOS_WEB_PORT") or 8765)',
    'from pathlib import Path\n\nfrom . import eveos_ports\n\n\nEVEOS_WEB_PORT = eveos_ports.service_port("EVEOS_WEB_PORT")',
)

replace(
    "server_modules/gemini_control.py",
    'from . import gemini_credentials\n\n\n# Read from the environment so tools/batch/eveos-ports.bat remains the single source of truth.\n# Defaults preserve the established pair for direct module use and test isolation.\ndef _port_from_env(name: str, default: int) -> int:\n    try:\n        return int(os.environ.get(name) or default)\n    except (TypeError, ValueError):\n        return default\n\n\nWEBSOCKET_PORT = _port_from_env("GEMINI_WS_PORT", 9085)\nSTATUS_PORT = _port_from_env("GEMINI_STATUS_PORT", 9086)',
    'from . import eveos_ports, gemini_credentials\n\n\nWEBSOCKET_PORT = eveos_ports.service_port("GEMINI_WS_PORT")\nSTATUS_PORT = eveos_ports.service_port("GEMINI_STATUS_PORT")',
)

replace(
    "server_modules/eveos_control_helper.py",
    "from . import eveos_console_prefs\nfrom . import eveos_web_control",
    "from . import eveos_console_prefs\nfrom . import eveos_ports\nfrom . import eveos_web_control",
)
replace(
    "server_modules/eveos_control_helper.py",
    "DEFAULT_PORT = 9082",
    'DEFAULT_PORT = eveos_ports.service_port("GEMINI_CONTROL_PORT")',
)

audit_path = Path("tools/audit/eveos-port-registry-audit.js")
audit = audit_path.read_text(encoding="utf-8")
anchor = (
    "const pythonBootstrap = read('server_modules/__init__.py');\n"
    "check(pythonBootstrap.includes('bootstrap_environment()'), 'Python server modules do not bootstrap the canonical registry');\n\n"
)
if anchor not in audit:
    raise SystemExit("port audit insertion anchor missing")
addition = r'''const managedPythonPortConsumers = [
    ['server_modules/eveos_web_control.py', 'EVEOS_WEB_PORT'],
    ['server_modules/eveos_control_helper.py', 'GEMINI_CONTROL_PORT'],
    ['server_modules/gemini_control.py', 'GEMINI_WS_PORT'],
    ['server_modules/gemini_control.py', 'GEMINI_STATUS_PORT'],
    ['server_modules/world_book_control.py', 'WORLD_BOOK_PORT'],
    ['server_modules/piano_player_control.py', 'PIANO_PLAYER_PORT'],
    ['server_modules/watchfusion_control.py', 'WATCHFUSION_PORT']
];
for (const [relative, key] of managedPythonPortConsumers) {
    const text = read(relative);
    const registered = Number(ports[key]?.port);
    check(text.includes(`eveos_ports.service_port("${key}")`) || text.includes(`eveos_ports.service_port('${key}')`),
        `${relative} does not resolve ${key} through eveos_ports.service_port()`);
    check(!new RegExp(`\\b${registered}\\b`).test(text),
        `${relative} still embeds registered port ${registered} instead of the registry key ${key}`);
    check(!new RegExp(`os\\.environ\\.get\\(["']${key}["']\\)[^\\n]*\\bor\\s*\\d+`).test(text),
        `${relative} reintroduced an environment-or-literal fallback for ${key}`);
    check(!new RegExp(`_port_from_env\\(["']${key}["']\\s*,\\s*\\d+`).test(text),
        `${relative} reintroduced a helper literal fallback for ${key}`);
}

const controlHelper = read('server_modules/eveos_control_helper.py');
check(!/DEFAULT_PORT\s*=\s*\d+/.test(controlHelper),
    'EveOS control-plane entrypoint reintroduced a literal default port');

'''
audit_path.write_text(audit.replace(anchor, anchor + addition, 1), encoding="utf-8")
