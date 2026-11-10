"""No-browser, no-process regression tests for exact Spotify Edge stale ownership."""
import unittest
from pathlib import Path

from server_modules.audioflix_spotify_edge_stale import retire_stale_host, _exact_profile_argument
from server_modules.audioflix_spotify_edge_window import _is_system_auxiliary_window

PROFILE = Path('C:/Users/test/AppData/Local/EveOS/SpotifyEmbedEdgeBetaProfile')
EDGE = 'C:/Microsoft/Edge Beta/Application/msedge.exe'

class FakeProcess:
    def __init__(self, pid, born, fixture):
        self.pid, self._born, self.f = pid, born, fixture
    def create_time(self): return self.f.birth_override.get(self.pid, self._born)
    def name(self): return self.f.name_override.get(self.pid, 'msedge.exe')
    def exe(self): return self.f.exe_override.get(self.pid, EDGE)
    def cmdline(self): return self.f.args_override.get(self.pid, ['msedge.exe', '--user-data-dir=' + str(PROFILE)])
    def terminate(self):
        self.f.actions.append(('terminate', self.pid))
        if self.f.terminate_exits: self.f.processes.pop(self.pid, None)

class Fixture:
    def __init__(self, *, owned=1, other=0):
        self.processes = {41: 10.0, 42: 11.0}
        self.windows = {'owned': owned, 'other': other}
        self.active = False
        self.audio_error = None
        self.close_ok = True
        self.close_removes_processes = False
        self.terminate_exits = True
        self.close_mutation = None
        self.actions = []
        self.birth_override, self.exe_override = {}, {}
        self.name_override, self.args_override = {}, {}
    def finder(self, _profile):
        self.actions.append(('find', len(self.processes)))
        return dict(self.processes)
    def windows_probe(self, owned):
        self.actions.append(('probe', len(owned)))
        return dict(self.windows)
    def audio_probe(self, owned):
        self.actions.append(('audio', len(owned)))
        if self.audio_error: raise RuntimeError(self.audio_error)
        return self.active
    def close(self, owned):
        self.actions.append(('close', tuple(sorted(owned))))
        if not self.close_ok: return 0
        self.windows['owned'] = 0
        if self.close_mutation: self.close_mutation(self)
        if self.close_removes_processes: self.processes.clear()
        return 1
    def process(self, pid):
        return FakeProcess(pid, self.processes[pid], self)
    def wait(self, procs, timeout):
        self.actions.append(('wait', len(procs)))
        return [], []
    def run(self, **overrides):
        args = dict(expected_executable=EDGE, process_factory=self.process,
            wait_procs=self.wait, close_windows=self.close,
            window_probe=self.windows_probe, audio_probe=self.audio_probe,
            sleep=lambda _: None)
        args.update(overrides)
        return retire_stale_host(PROFILE, self.finder, **args)

class StaleSpotifyHostTests(unittest.TestCase):
    def test_graceful_close_does_not_terminate_processes(self):
        f = Fixture(); f.close_removes_processes = True
        self.assertEqual(f.run(), {'closedWindows': 1, 'retiredPids': []})
        self.assertFalse(any(a[0]=='terminate' for a in f.actions))
    def test_remaining_exact_processes_retired_after_close(self):
        f = Fixture()
        self.assertEqual(f.run(), {'closedWindows': 1, 'retiredPids': [41,42]})
        self.assertEqual([a for a in f.actions if a[0]=='terminate'], [('terminate',41),('terminate',42)])
        self.assertLess(f.actions.index(('close',(41,42))),f.actions.index(('terminate',41)))
    def test_wrong_profile_is_never_touched(self):
        f = Fixture()
        with self.assertRaisesRegex(RuntimeError,'non-EveOS'):
            retire_stale_host(Path('C:/Temp/SpotifyEmbedEdgeBetaProfile'),f.finder,expected_executable=EDGE)
        self.assertEqual(f.actions,[])
    def test_missing_executable_fails_before_probe(self):
        f = Fixture()
        with self.assertRaisesRegex(RuntimeError,'executable'): f.run(expected_executable='')
        self.assertEqual(f.actions,[])
    def test_no_marked_window_fails_closed(self):
        f = Fixture(owned=0)
        with self.assertRaisesRegex(RuntimeError,'one exact EveOS'): f.run()
        self.assertFalse(any(a[0] in ('close','terminate') for a in f.actions))
    def test_multiple_marked_windows_fails_closed(self):
        f = Fixture(owned=2)
        with self.assertRaisesRegex(RuntimeError,'one exact EveOS'): f.run()
    def test_other_window_using_profile_protected(self):
        f = Fixture(other=1)
        with self.assertRaisesRegex(RuntimeError,'one exact EveOS'): f.run()
        self.assertFalse(any(a[0] in ('close','terminate') for a in f.actions))
    def test_active_audio_is_protected_even_if_backend_stopped(self):
        f = Fixture(); f.active=True
        with self.assertRaisesRegex(RuntimeError,'active or unverified audio'): f.run()
        self.assertFalse(any(a[0] in ('close','terminate') for a in f.actions))
    def test_audio_telemetry_failure_is_not_silence(self):
        f = Fixture(); f.audio_error='unavailable endpoint'
        with self.assertRaisesRegex(RuntimeError,'Could not prove'): f.run()
        self.assertFalse(any(a[0] in ('close','terminate') for a in f.actions))
    def test_pid_change_before_close_refused(self):
        f = Fixture(); original=f.finder; calls=[0]
        def find(profile):
            calls[0]+=1
            if calls[0]==2: f.processes[41]=90.0
            return original(profile)
        f.finder=find
        with self.assertRaisesRegex(RuntimeError,'set changed'): f.run()
        self.assertFalse(any(a[0] in ('close','terminate') for a in f.actions))
    def test_failed_window_close_never_terminates(self):
        f = Fixture();f.close_ok=False
        with self.assertRaisesRegex(RuntimeError,'window closure'): f.run()
        self.assertFalse(any(a[0]=='terminate' for a in f.actions))
    def test_new_process_after_close_refused(self):
        f = Fixture();f.close_mutation=lambda f: f.processes.update({101:33.0})
        with self.assertRaisesRegex(RuntimeError,'changed while closing'): f.run()
        self.assertFalse(any(a[0]=='terminate' for a in f.actions))
    def test_audio_resumes_after_window_close_refused(self):
        f = Fixture();f.close_mutation=lambda f: setattr(f,'active',True)
        with self.assertRaisesRegex(RuntimeError,'active or unverified audio'): f.run()
        self.assertFalse(any(a[0]=='terminate' for a in f.actions))
    def test_pid_reuse_before_termination_refused(self):
        f = Fixture();f.birth_override[41]=99.0
        with self.assertRaisesRegex(RuntimeError,'identity changed'): f.run()
        self.assertFalse(any(a[0]=='terminate' for a in f.actions))
    def test_wrong_executable_refused(self):
        f = Fixture();f.exe_override[41]='C:/Other/msedge.exe'
        with self.assertRaisesRegex(RuntimeError,'exact Edge Beta executable'): f.run()
        self.assertFalse(any(a[0]=='terminate' for a in f.actions))
    def test_wrong_profile_cmdline_refused(self):
        f = Fixture();f.args_override[41]=['msedge.exe','--user-data-dir=C:/Elsewhere']
        with self.assertRaisesRegex(RuntimeError,'dedicated profile argument'): f.run()
        self.assertFalse(any(a[0]=='terminate' for a in f.actions))
    def test_persistent_process_is_not_force_killed(self):
        f = Fixture(); f.terminate_exits=False
        with self.assertRaisesRegex(RuntimeError,'did not exit gracefully'): f.run()
        self.assertEqual([a for a in f.actions if a[0]=='terminate'], [('terminate',41),('terminate',42)])
        self.assertFalse(any(a[0]=='kill' for a in f.actions))
    def test_empty_profile_no_side_effect(self):
        f = Fixture(); f.processes={}
        self.assertEqual(f.run(),{'closedWindows':0,'retiredPids':[]})
        self.assertFalse(any(a[0] in ('close','terminate') for a in f.actions))
    def test_profile_args_match_only_exact(self):
        self.assertTrue(_exact_profile_argument(['msedge.exe','--user-data-dir',str(PROFILE)], PROFILE))
        self.assertTrue(_exact_profile_argument(['--user-data-dir='+str(PROFILE)], PROFILE))
        self.assertFalse(_exact_profile_argument(['--user-data-dir='+str(PROFILE)+'-other'], PROFILE))
    def test_hidden_owned_ime_helpers_are_not_profile_windows(self):
        self.assertTrue(_is_system_auxiliary_window('Default IME', 'IME', False, 91))
        self.assertTrue(_is_system_auxiliary_window('MSCTFIME UI', 'MSCTFIME UI', False, 91))
        self.assertFalse(_is_system_auxiliary_window('Default IME', 'IME', True, 91))
        self.assertFalse(_is_system_auxiliary_window('Default IME', 'Chrome_WidgetWin_1', False, 91))
        self.assertFalse(_is_system_auxiliary_window('Default IME', 'IME', False, 0))
        self.assertFalse(_is_system_auxiliary_window('Another window', 'Chrome_WidgetWin_1', False, 91))
    def test_managed_engine_guard_precedes_reclamation(self):
        src=Path(__file__).resolve().parents[1].joinpath('server_modules/audioflix_spotify_edge.py').read_text()
        self.assertLess(src.index("managed_browser.status().get('browserRunning')"),
                        src.index('reclaimed = retire_stale_host('))

    def test_manager_recovers_only_before_explicit_play_launch(self):
        import tempfile
        from types import ModuleType
        from unittest.mock import patch
        import sys
        import server_modules.audioflix_spotify_edge as edge
        import server_modules.audioflix_spotify_edge_stale as stale
        with tempfile.TemporaryDirectory() as base:
            profile=Path(base)/'EveOS'/'SpotifyEmbedEdgeBetaProfile'
            processes={41:10.0}
            launched=[]
            manager=edge.EdgeSpotifyManager(process_finder=lambda _:dict(processes),
                                            launch=lambda args,**kw:launched.append(args))
            manager._record=lambda *a,**kw:None
            manager._run_route=lambda *a,**kw:None
            manager.status=lambda:{'running':manager._running}
            provider=ModuleType('server_modules.audioflix_spotify_browser')
            provider.status=lambda:{'browserRunning':False}
            def retire(*args,**kw):
                self.assertEqual(kw['expected_executable'],EDGE)
                processes.clear()
                return {'closedWindows':1,'retiredPids':[41]}
            with patch.dict(sys.modules,{'server_modules.audioflix_spotify_browser':provider}), \
                 patch.object(edge,'_profile',return_value=profile), \
                 patch.object(edge,'_edge_executable',return_value=EDGE), \
                 patch.object(stale,'retire_stale_host',side_effect=retire):
                reply=manager.play({'spotifyUri':'spotify:track:'+'A'*22,'deviceId':'sd:7'},8765)
            self.assertTrue(reply['running'])
            self.assertEqual(len(launched),1)
            self.assertIn('--user-data-dir='+str(profile),launched[0])

    def test_manager_refuses_stale_retirement_when_managed_engine_active(self):
        import tempfile
        from types import ModuleType
        from unittest.mock import patch
        import sys
        import server_modules.audioflix_spotify_edge as edge
        import server_modules.audioflix_spotify_edge_stale as stale
        with tempfile.TemporaryDirectory() as base:
            profile=Path(base)/'EveOS'/'SpotifyEmbedEdgeBetaProfile'
            launched=[]
            manager=edge.EdgeSpotifyManager(process_finder=lambda _:{41:10.0},
                                            launch=lambda args,**kw:launched.append(args))
            provider=ModuleType('server_modules.audioflix_spotify_browser')
            provider.status=lambda:{'browserRunning':True}
            with patch.dict(sys.modules,{'server_modules.audioflix_spotify_browser':provider}), \
                 patch.object(edge,'_profile',return_value=profile), \
                 patch.object(edge,'_edge_executable',return_value=EDGE), \
                 patch.object(stale,'retire_stale_host',side_effect=AssertionError('must not recover')):
                with self.assertRaisesRegex(RuntimeError,'Stop Spotify Engine'):
                    manager.play({'spotifyUri':'spotify:track:'+'A'*22,'deviceId':'sd:7'},8765)
            self.assertEqual(launched,[])

if __name__=='__main__': unittest.main()
