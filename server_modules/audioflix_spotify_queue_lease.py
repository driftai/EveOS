"""Broker-owned, bounded Spotify queue continuation; no browser-tab timers or replay.

Only a previously authenticated, current relay owner may arm this observer. Each
completed engine generation is claimed once. The normal broker transport lock and
preemption fence still control every Play. An ambiguous result retires the lease.
"""
from __future__ import annotations

import secrets
import threading
import time

from server_modules import audioflix_spotify_broker_preemption as preemption
from server_modules.audioflix_spotify_media_identity import media_from_payload

MAX_ITEMS = 256
MAX_LIFETIME_S = 8 * 3600
POLL_S = 0.65


class DelegatedQueue:
    def __init__(self, broker, engine):
        self.broker = broker
        self.engine = engine
        self.lease = None

    def projection(self, client_id):
        with self.broker._lock:
            lease = self.lease
            if not lease or lease['clientId'] != client_id:
                return None
            return {key: lease[key] for key in ('leaseId', 'runId', 'index', 'baseIndex',
                                                 'count', 'queueCount', 'itemId', 'generation',
                                                 'state', 'reason')}

    def invalidate(self, client_id, action):
        with self.broker._lock:
            lease = self.lease
            if lease and (lease['clientId'] == client_id or action == 'play'):
                lease['state'] = 'released'
                lease['reason'] = 'New authenticated playback intent.'

    def arm(self, client_id, args, connection_id, server_origin):
        broker = self.broker
        entries = args.get('entries')
        index = args.get('index')
        base_index = args.get('baseIndex', 0)
        queue_count = args.get('queueCount', len(entries) if isinstance(entries, list) else 0)
        run_id = args.get('runId')
        if not server_origin:
            return {'ok': False, 'reason': 'Trusted engine origin required.'}
        if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_ITEMS:
            return {'ok': False, 'reason': 'Delegated queue requires 1–256 Spotify items.'}
        if (type(index) is not int or type(base_index) is not int or type(queue_count) is not int
                or base_index < 0 or queue_count < 1
                or not base_index <= index < base_index + len(entries)
                or base_index + len(entries) > queue_count):
            return {'ok': False, 'reason': 'Invalid delegated queue index.'}
        if args.get('loop') is True and (base_index != 0 or len(entries) != queue_count):
            return {'ok': False, 'reason': 'Loop delegation requires the complete bounded queue.'}
        if type(run_id) is not int or not 0 < run_id <= 2 ** 53 - 1:
            return {'ok': False, 'reason': 'Invalid frontend playback run.'}
        cleaned = []
        for raw in entries:
            if not isinstance(raw, dict):
                return {'ok': False, 'reason': 'Invalid queue entry.'}
            identity = media_from_payload(raw)
            if not identity:
                return {'ok': False, 'reason': 'Delegation requires Spotify-only tracks or episodes.'}
            item_id = str(raw.get('itemId') or '')
            if not item_id or len(item_id) > 128:
                return {'ok': False, 'reason': 'Each queue item needs its exact bounded library ID.'}
            try:
                duration = max(0.0, min(86400.0, float(raw.get('duration') or 0)))
                gain = max(0.0, min(1.0, float(raw.get('effectiveVolume', 1))))
            except (TypeError, ValueError):
                return {'ok': False, 'reason': 'Invalid queue duration or volume.'}
            cleaned.append({**identity, 'itemId': item_id,
                            'title': str(raw.get('title') or '')[:240],
                            'duration': duration, 'effectiveVolume': gain})
        with broker._lock:
            client = broker._clients.get(client_id)
            if not client or client.get('connectionId') != connection_id or client.get('detached'):
                return {'ok': False, 'reason': 'Delegated queue connection is no longer current.'}
            if broker._owner_client_id != client_id:
                return {'ok': False, 'reason': 'Only the exact Spotify owner may delegate.'}
            fence = getattr(broker, '_latest_intent', None)
            engine_epoch = broker._engine_epoch
        status = self.engine.status()
        with broker._lock:
            broker._sync_engine_epoch_locked(status)
        actual = status.get('transport') or {}
        expected = cleaned[index - base_index]
        generation = actual.get('generation')
        if (not status.get('helperReachable') or not isinstance(generation, int)
                or generation <= 0 or actual.get('spotifyUri') != expected['spotifyUri']
                or actual.get('status') not in {'playing', 'starting', 'ended'}):
            return {'ok': False, 'reason': 'Managed engine is not on the exact current queue item.'}
        with broker._lock:
            if broker._owner_client_id != client_id or broker._engine_epoch != engine_epoch:
                return {'ok': False, 'reason': 'Spotify owner/engine changed during delegation.'}
            old = self.lease
            if old and old['state'] == 'active':
                old['state'] = 'released'
                old['reason'] = 'Superseded by a newer exact queue plan.'
            lease = {'leaseId': 'afq-' + secrets.token_hex(12), 'clientId': client_id,
                     'connectionId': connection_id, 'serverOrigin': server_origin, 'runId': run_id,
                     'index': index, 'baseIndex': base_index, 'queueCount': queue_count,
                     'itemId': expected['itemId'], 'count': len(cleaned), 'entries': cleaned,
                     'generation': generation, 'engineEpoch': engine_epoch,
                     'intentFence': fence, 'lastCompletion': '', 'state': 'active',
                     'reason': '', 'loop': args.get('loop') is True,
                     'repeatOne': args.get('repeatOne') is True,
                     'expiresAt': time.monotonic() + MAX_LIFETIME_S}
            self.lease = lease
        threading.Thread(target=self._watch, args=(lease,), daemon=True,
                         name='audioflix-spotify-queue-lease').start()
        return {'ok': True, 'queueLease': self.projection(client_id)}

    def disarm(self, client_id, lease_id):
        with self.broker._lock:
            lease = self.lease
            if lease and lease['clientId'] == client_id:
                if lease_id and lease_id != lease['leaseId']:
                    return {'ok': False, 'reason': 'Delegated queue lease identity changed.'}
                lease['state'] = 'released'
                lease['reason'] = 'Explicit frontend handoff.'
        return {'ok': True, 'queueLease': self.projection(client_id)}

    def _retire(self, lease, state, reason):
        with self.broker._lock:
            if self.lease is lease and lease['state'] == 'active':
                lease['state'] = state
                lease['reason'] = reason

    def _watch(self, lease):
        broker = self.broker
        while True:
            time.sleep(POLL_S)
            with broker._lock:
                if self.lease is not lease or lease['state'] != 'active':
                    return
                if time.monotonic() >= lease['expiresAt']:
                    lease['state'] = 'uncertain'; lease['reason'] = 'Queue lease expired.'
                    return
                client = broker._clients.get(lease['clientId'])
                if (not client or client.get('detached')
                    or client.get('connectionId') != lease['connectionId']
                    or broker._owner_client_id != lease['clientId']
                    or broker._engine_epoch != lease['engineEpoch']
                    or getattr(broker, '_latest_intent', None) != lease['intentFence']):
                    lease['state'] = 'uncertain'; lease['reason'] = 'Owner, relay, engine or intent changed.'
                    return
            if not broker._transport_lock.acquire(blocking=False):
                continue
            try:
                with broker._lock:
                    if self.lease is not lease or lease['state'] != 'active':
                        return
                result = self.engine.status()
                with broker._lock:
                    broker._sync_engine_epoch_locked(result)
                    if broker._engine_epoch != lease['engineEpoch']:
                        lease['state'] = 'uncertain'
                        lease['reason'] = 'Managed engine epoch changed during delegation.'
                        return
                current = result.get('transport') or {}
                expected = lease['entries'][lease['index'] - lease['baseIndex']]
                if (not result.get('helperReachable')
                    or current.get('spotifyUri') != expected['spotifyUri']
                    or current.get('generation') != lease['generation']):
                    self._retire(lease, 'uncertain', 'Engine identity/generation no longer matches queue lease.')
                    return
                # The managed engine has already proved its own natural completion.
                if current.get('status') != 'ended' or not current.get('ended') or not current.get('completionId'):
                    with broker._lock:
                        client = broker._clients.get(lease['clientId'])
                        if client and lease['state'] == 'active':
                            client['lastSeen'] = time.monotonic()  # bounded lease keeps owner alive
                    continue
                completion = str(current['completionId'])
                with broker._lock:
                    if self.lease is not lease or lease['state'] != 'active':
                        return
                    if completion == lease['lastCompletion']:
                        continue
                    lease['lastCompletion'] = completion  # claim BEFORE mutation: uncertain cannot replay
                    next_index = lease['index'] if lease['repeatOne'] else lease['index'] + 1
                    if next_index >= lease['queueCount']:
                        if lease['loop']:
                            next_index = 0
                        else:
                            lease['state'] = 'finished'
                            lease['reason'] = 'Queue reached its natural end.'
                            return
                    window_offset = next_index - lease['baseIndex']
                    if not 0 <= window_offset < lease['count']:
                        lease['state'] = 'window-exhausted'
                        lease['reason'] = 'Bounded queue window ended before the full queue.'
                        return
                    next_entry = lease['entries'][window_offset]
                # Reuse the broker's transport lock and accepted-intent fence. Never issue an
                # untracked browser command, and never retry a transport with unknown outcome.
                def play_if_current():
                    with broker._lock:
                        if self.lease is not lease or lease['state'] != 'active':
                            return {'ok': False, 'reason': 'Queue lease revoked before Play.'}
                    return broker._execute_transport(lease['clientId'], 'play',
                        next_entry, lease['serverOrigin'], lease['connectionId'])
                response = preemption.run_fenced(broker, lease['intentFence'], play_if_current)
                with broker._lock:
                    if self.lease is not lease or lease['state'] != 'active':
                        return
                    if not response.get('ok'):
                        lease['state'] = 'uncertain'
                        lease['reason'] = str(response.get('reason') or 'Delegated play outcome uncertain.')[:180]
                        return
                    state = response.get('engine') or {}
                    generation = state.get('generation')
                    if not isinstance(generation, int) or generation <= lease['generation']:
                        lease['state'] = 'uncertain'
                        lease['reason'] = 'Delegated play lacks a new authoritative generation.'
                        return
                    lease['index'] = next_index
                    lease['itemId'] = next_entry['itemId']
                    lease['generation'] = generation
                    client = broker._clients.get(lease['clientId'])
                    if client: client['lastSeen'] = time.monotonic()
            except Exception as exc:
                self._retire(lease, 'uncertain', 'Queue observer exception: ' + str(exc)[:120])
                return
            finally:
                broker._transport_lock.release()
