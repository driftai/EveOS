"""Proportional affected-test selection for EveOS qualification."""


def build_affected_plan(files, base, gate, npm):
    selected, classes = [], set()
    lowered = [path.lower() for path in files]
    paths = '\n'.join(lowered)
    selected.append(gate('guardrails', npm('run', '--silent', 'test:guardrails'),
                         ('build-output',), category='build-dependent'))
    audioflix = [path for path in lowered if 'audioflix' in path or 'piano-auto-player/' in path]
    piano = [path for path in audioflix if any(token in path for token in (
        'audioflix.piano', 'audioflix_piano', 'piano-auto-player/'))]
    provider_capture = [path for path in audioflix if any(token in path for token in (
        'audioflix.provider.capture', 'audioflix_provider_capture'))]
    spotify_edge = [path for path in audioflix if any(token in path for token in (
        'spotify.edge', 'spotify_edge', 'spotify-embed-edge'))]
    spotify_other = [path for path in audioflix if 'spotify' in path and path not in spotify_edge]
    shared_playback = [path for path in audioflix if any(token in path for token in (
        'audioflix.audio.', 'audioflix.audio.js', 'audioflix.queue.', 'audioflix.transport',
        'audioflix.internal-player', 'audioflix.ui.actions'))]
    classified = set(piano + provider_capture + spotify_edge + spotify_other + shared_playback)
    unknown = [path for path in audioflix if path not in classified
               and not path.startswith('tests/') and not path.startswith('tools/smoke/')]
    if piano:
        selected.append(gate('audioflix-piano', npm('run', '--silent', 'smoke:audioflix-piano'),
                             ('audioflix-runtime',), ('guardrails',), 'integration'))
        classes.add('audioflix-piano')
    if provider_capture:
        selected.append(gate('audioflix-provider-capture', npm('run', '--silent', 'smoke:audioflix-provider-capture'),
                             ('audioflix-runtime', 'playwright'), ('guardrails',), 'browser-owned'))
        classes.add('audioflix-provider-capture')
    if spotify_edge:
        selected.append(gate('audioflix-playback-policy', npm('run', '--silent', 'smoke:audioflix-playback-policy'),
                             ('audioflix-runtime', 'playwright'), ('guardrails',), 'browser-owned'))
        classes.add('audioflix-spotify-edge')
    if spotify_other:
        selected.extend([
            gate('audioflix-playback-policy', npm('run', '--silent', 'smoke:audioflix-playback-policy'),
                 ('audioflix-runtime', 'playwright'), ('guardrails',), 'browser-owned'),
            gate('audioflix-spotify-managed', npm('run', '--silent', 'smoke:audioflix-spotify-managed'),
                 ('audioflix-runtime', 'playwright'), ('guardrails',), 'browser-owned')])
        classes.add('audioflix-spotify')
    if shared_playback or unknown:
        selected.append(gate('audioflix-playback', npm('run', '--silent', 'smoke:audioflix-playback'),
                             ('audioflix-runtime', 'playwright'), ('guardrails',), 'browser-owned'))
        classes.add('audioflix-shared-playback')
    if 'tools/nexus-browser/' in paths or '/nexus/' in paths or 'machine_spaces' in paths:
        selected.append(gate('ai-control', npm('run', '--silent', 'test:ai-control'),
                             ('nexus-runtime', 'playwright', 'ports'), ('guardrails',), 'integration'))
        classes.add('nexus')
    shared_server = any((path.startswith('server_modules/') and not path.startswith('server_modules/audioflix_'))
                        or path.startswith('server/') or path.startswith('js/modules/core/')
                        or 'state-sync' in path for path in lowered)
    if shared_server:
        selected.append(gate('deep', npm('run', '--silent', 'test:deep'),
                             ('services', 'ports', 'playwright'), ('guardrails',), 'integration'))
        classes.add('shared-runtime')
    if not classes:
        selected.append(gate('fast', npm('run', '--silent', 'test:smoke'),
                             ('build-output',), ('guardrails',), 'integration'))
        classes.add('fast-fallback')
    unique, seen = [], set()
    for item in selected:
        key = tuple(item['argv'])
        if key not in seen:
            seen.add(key); unique.append(item)
    return unique, {'base': base, 'changedFiles': files, 'affectedClasses': sorted(classes)}


def validate_affected_selection(gate, npm):
    cases = [
        (['tools/Piano-Auto-Player/web/piano_pcm_capture.js',
          'js/modules/features/audioflix/audioflix.piano.pcm.js'],
         ['guardrails', 'audioflix-piano'], ['audioflix-piano']),
        (['js/modules/features/audioflix/audioflix.spotify.edge.js',
          'server_modules/audioflix_spotify_edge_session.py'],
         ['guardrails', 'audioflix-playback-policy'], ['audioflix-spotify-edge']),
        (['js/modules/features/audioflix/audioflix.queue.completion.js'],
         ['guardrails', 'audioflix-playback'], ['audioflix-shared-playback'])]
    for files, labels, classes in cases:
        plan, metadata = build_affected_plan(files, 'test', gate, npm)
        assert [item['label'] for item in plan] == labels
        assert metadata['affectedClasses'] == classes
