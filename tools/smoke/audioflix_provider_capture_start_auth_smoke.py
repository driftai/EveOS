"""Provider minting requires localhost same-origin JSON + non-simple header."""
from __future__ import annotations
import importlib
import pathlib
import sys
from types import SimpleNamespace, ModuleType

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
try:
    from server_modules import audioflix_bridge as bridge
except ImportError as err:
    # Incomplete isolated review ZIPs omit existing audio dependencies. Full
    # repository runs use the normal imports; stubs are only for this static gate.
    raise AssertionError(f"Full EveOS server dependencies required: {err}")

class Handler:
    def __init__(self, *, origin='http://127.0.0.1:8765', host='127.0.0.1:8765',
                 media='application/json', intent='v1', site='same-origin', client='127.0.0.1'):
        self.client_address=(client, 1234)
        self.server=SimpleNamespace(server_address=('127.0.0.1',8765))
        self.headers={
            'Origin':origin, 'Host':host, 'Content-Type':media,
            'X-EveOS-Provider-Capture':intent, 'Sec-Fetch-Site':site,
        }

assert bridge._can_start_provider_capture(Handler())
assert bridge._can_start_provider_capture(Handler(origin='http://localhost:8765',host='localhost:8765'))
for name, overrides in [
    ('opaque',dict(origin='null')), ('file',dict(origin='file://')),
    ('missing',dict(origin='')), ('foreign-local',dict(origin='http://localhost:3333')),
    ('cross-host',dict(origin='http://localhost:8765')),
    ('hostname',dict(origin='http://example.com:8765')),
    ('extension',dict(origin='chrome-extension://abc')),
    ('bad-host',dict(host='example.com:8765')),
    ('bad-type',dict(media='text/plain')),
    ('bad-intent',dict(intent='')), ('cross-site',dict(site='cross-site')),
    ('non-local-client',dict(client='10.0.0.1')),
]:
    assert not bridge._can_start_provider_capture(Handler(**overrides)), name
print('AUDIOFLIX_PROVIDER_CAPTURE_START_AUTH_OK same_origin=true foreign_and_opaque_denied=true content_type_and_intent=true')
