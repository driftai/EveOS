"""Explicit, exact-owner native continuation for all-Spotify Official Embed queues.

Never opens another provider, never resumes a paused/stopped owner, and never touches
ordinary Edge windows. Browser queue edits and explicit transport commands disarm.
"""
from __future__ import annotations

import re
import secrets
import threading
import time
from server_modules.audioflix_spotify_edge import URI

MAX_ENTRIES = 96
MAX_AGE_SECONDS = 8 * 3600


def _public(self):
    lease = getattr(self, '_edge_queue_lease', None)
    if not lease:
        return {'state': 'disarmed'}
    return {**{k: lease[k] for k in ('leaseId', 'runId', 'index', 'itemId', 'revision', 'state')},
            'failures': [dict(entry) for entry in lease.get('failures', [])]}


def public(self):
    with self._lock:
        return _public(self)


def disarm(self):
    with self._lock:
        old = getattr(self, '_edge_queue_lease', None)
        self._edge_queue_lease = None
        if old:
            self._record('edge-queue-disarmed', revision=old['revision'])
        return {'ok': True, 'queueLease': {'state': 'disarmed'}}


def arm(self, data):
    with self._lock:
        entries = data.get('entries')
        if (not self._running or self._status in ('close-required', 'stopped', 'route-error')
                or not isinstance(entries, list) or not (2 <= len(entries) <= MAX_ENTRIES)):
            return {'ok': False, 'reason': 'No eligible exact-owner Spotify queue.'}
        try:
            index = int(data.get('index'))
            run_id = int(data.get('runId'))
            revision = int(data.get('expectedRevision'))
        except (TypeError, ValueError):
            return {'ok': False, 'reason': 'Invalid queue run identity.'}
        if (not 0 <= index < len(entries) or run_id < 1
                or revision != self._media_revision or self._manual_pause_revision == revision):
            return {'ok': False, 'reason': 'Queue is not aligned to the native owner.'}
        canonical = []
        for entry in entries:
            if not isinstance(entry, dict):
                return {'ok': False, 'reason': 'Invalid Spotify queue entry.'}
            uri, item_id = entry.get('spotifyUri'), entry.get('itemId')
            if not isinstance(uri, str) or not URI.fullmatch(uri):
                return {'ok': False, 'reason': 'Queue requires official Spotify tracks only.'}
            if not isinstance(item_id, str) or not (1 <= len(item_id) <= 128):
                return {'ok': False, 'reason': 'Invalid queue item identifier.'}
            try:
                gain = float(entry.get('gain'))
            except (TypeError, ValueError):
                return {'ok': False, 'reason': 'Invalid queue volume.'}
            if not 0 <= gain <= 1:
                return {'ok': False, 'reason': 'Invalid queue gain.'}
            canonical.append({'spotifyUri': uri, 'itemId': item_id, 'gain': gain})
        if canonical[index]['spotifyUri'] != self._uri:
            return {'ok': False, 'reason': 'Selected queue item does not match native media.'}
        existing = getattr(self, '_edge_queue_lease', None)
        if existing and existing['revision'] == revision and existing['runId'] == run_id:
            if existing['entries'] == canonical and existing['index'] == index:
                return {'ok': True, 'queueLease': _public(self)}
        self._edge_queue_lease = {
            'leaseId': secrets.token_hex(16), 'runId': run_id, 'index': index,
            'entries': canonical, 'itemId': canonical[index]['itemId'], 'revision': revision,
            'generation': self._generation, 'claimedRevision': -1,
            'loop': data.get('loop') is True, 'state': 'active', 'began': time.monotonic(),
            'failures': [], 'consecutiveFailures': 0
        }
        self._record('edge-queue-armed', count=len(entries), revision=revision)
        return {'ok': True, 'queueLease': _public(self)}




def clear_page(self):
    with self._lock:
        self._edge_page_owner = None


def register_page(self, payload):
    token = str(payload.get('token') or '')
    try:
        revision = int(payload.get('revision'))
    except (ValueError, TypeError):
        return {'ok': False, 'reason': 'Invalid page media revision.'}
    with self._lock:
        if (not self._running or not re.fullmatch(r'[0-9a-f]{32}', token)
                or revision != self._media_revision
                or str(payload.get('spotifyUri') or '') != self._uri):
            return {'ok': False, 'reason': 'Page does not own the active Spotify revision.'}
        self._edge_page_owner = {'token':token, 'generation':self._generation}
        return {'ok': True, 'pageOwnerConfirmed': True}


def stop_page(self, payload):
    with self._lock:
        ticket = getattr(self, '_edge_page_owner', None)
        token = str(payload.get('token') or '')
        if (not ticket or not secrets.compare_digest(token, ticket['token'])
                or ticket['generation'] != self._generation or not self._running):
            return {'ok': False, 'reason': 'Page has no matching exact Spotify owner.'}
        self._edge_page_owner = None
        self._edge_queue_lease = None
        return self._stop_locked()

def command(self, action, payload):
    if action == 'page-register':
        return register_page(self, payload)
    if action == 'page-stop-owned':
        return stop_page(self, payload)
    if action == 'queue-arm':
        return arm(self, payload)
    if action == 'queue-stop-owned':
        with self._lock:
            lease = getattr(self, '_edge_queue_lease', None)
            if not lease or payload.get('leaseId') != lease['leaseId']:
                return {'ok': False, 'reason': 'No matching exact-page owner lease.'}
            self._edge_queue_lease = None
            return self._stop_locked()
    if action == 'queue-disarm':
        with self._lock:
            lease = getattr(self, '_edge_queue_lease', None)
            if not lease:
                return {'ok': True, 'queueLease': {'state': 'disarmed'}}
            if payload.get('leaseId') != lease['leaseId']:
                return {'ok': False, 'reason': 'Queue lease is not owned by this caller.'}
        return disarm(self)
    return {'ok': False, 'reason': 'Unknown queue command.'}


def on_ended(self, revision):
    """Only a verified, accepted native Ended event may advance this exact lease."""
    with self._lock:
        lease = getattr(self, '_edge_queue_lease', None)
        if (not lease or lease['state'] != 'active'
                or lease['generation'] != self._generation
                or lease['revision'] != revision
                or lease['claimedRevision'] == revision
                or self._ended_revision != revision
                or self._manual_pause_revision == revision):
            return False
        if time.monotonic() - lease['began'] > MAX_AGE_SECONDS:
            self._edge_queue_lease = None
            return False
        lease['claimedRevision'] = revision
        lease['consecutiveFailures'] = 0
        lease_id, generation = lease['leaseId'], lease['generation']
    threading.Thread(target=_advance, args=(self, lease_id, generation, revision, False),
                     daemon=True, name='eveos-edge-queue-advance').start()
    return True


def on_terminal(self, revision):
    """A bounded *native* startup watchdog is the sole source of skip-on-failure.

    A timeout is NOT evidence that a Spotify URL is permanently unavailable.
    Never skip user Pause, stale revisions, or a queue without an active lease.
    """
    with self._lock:
        lease = getattr(self, '_edge_queue_lease', None)
        if (not lease or lease['state'] != 'active' or not self._running
                or lease['generation'] != self._generation
                or lease['revision'] != revision or self._media_revision != revision
                or lease['claimedRevision'] == revision
                or self._failure_revision != revision or self._failure_terminal is not True
                or self._manual_pause_revision == revision):
            return False
        if time.monotonic() - lease['began'] > MAX_AGE_SECONDS:
            self._edge_queue_lease = None
            return False
        kind = str(self._failure_kind or '')
        if kind not in {'provider-start-timeout', 'provider-track-unavailable',
                        'provider-region-unavailable'}:
            return False
        reason = str(self._failure_reason or 'Spotify playback could not be confirmed.')[:180]
        lease['claimedRevision'] = revision
        lease['consecutiveFailures'] += 1
        lease['failures'].append({'itemId': lease['itemId'], 'revision': revision,
                                  'kind': kind, 'reason': reason})
        if len(lease['failures']) > MAX_ENTRIES:
            lease['failures'] = lease['failures'][-MAX_ENTRIES:]
        if lease['consecutiveFailures'] >= len(lease['entries']):
            lease['state'] = 'finished'
            self._record('edge-queue-all-tracks-failed', revision=revision)
            return True
        lease_id, generation = lease['leaseId'], lease['generation']
        self._record('edge-queue-terminal-claimed', revision=revision, kind=kind)
    threading.Thread(target=_advance, args=(self, lease_id, generation, revision, True),
                     daemon=True, name='eveos-edge-queue-skip-failed').start()
    return True


def _advance(self, lease_id, generation, revision, terminal=False):
    # Yield briefly to let a manually issued Stop/Next revoke this lease first.
    time.sleep(0.1)
    with self._lock:
        lease = getattr(self, '_edge_queue_lease', None)
        if (not lease or lease['leaseId'] != lease_id or lease['generation'] != generation
                or lease['revision'] != revision or not self._running
                or self._media_revision != revision
                or (terminal and (self._failure_revision != revision
                                  or self._failure_terminal is not True))
                or (not terminal and self._ended_revision != revision)
                or self._manual_pause_revision == revision):
            return
        index = lease['index'] + 1
        if index >= len(lease['entries']):
            if lease['loop']:
                index = 0
            else:
                lease['state'] = 'finished'
                self._record('edge-queue-finished', revision=revision)
                return
        entry = lease['entries'][index]
        from server_modules.audioflix_spotify_edge_session import switch_track
        try:
            result = switch_track(self, {'spotifyUri': entry['spotifyUri'],
                                         'deviceId': self._requested_device_id,
                                         'gain': entry['gain']})
        except Exception as error:
            lease['state'] = 'uncertain'
            self._record('edge-queue-switch-error', revision=revision, errorType=type(error).__name__)
            return
        if not result.get('ok'):
            lease['state'] = 'uncertain'
            self._record('edge-queue-switch-refused', revision=revision)
            return
        lease['index'] = index
        lease['itemId'] = entry['itemId']
        lease['revision'] = self._media_revision
        lease['claimedRevision'] = -1
        self._record('edge-queue-switched', revision=self._media_revision, index=index)
