"""Quota-conscious model policy and observational usage evidence (not billing)."""
from __future__ import annotations
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path

TIERS = {
    'small': {'model': 'gpt-5.6-luna', 'effort': 'low', 'reserve': 6},
    'medium': {'model': 'gpt-5.6-terra', 'effort': 'medium', 'reserve': 10},
    'complex': {'model': 'gpt-5.6-sol', 'effort': 'medium', 'reserve': 15},
}
ALLOWED_EFFORTS = ('low', 'medium', 'high')
WINDOWS = ('fiveHour', 'weekly')


def choose(tier: str, effort: str | None = None, permit_high: bool = False) -> dict:
    if tier not in TIERS:
        raise ValueError('Unrecognized task tier')
    plan = {**TIERS[tier], 'tier': tier}
    if effort is not None:
        if effort not in ALLOWED_EFFORTS:
            raise ValueError('Only low, medium and explicitly approved high are allowed')
        if effort == 'high' and not permit_high:
            raise ValueError('High reasoning requires explicit permission')
        plan['effort'] = effort
    return plan


def snapshot_valid(s: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    try:
        at = datetime.fromisoformat(s['observedAt'].replace('Z', '+00:00'))
        age = (now - at).total_seconds()
        if not (-10 <= age <= 90) or s.get('state') != 'AVAILABLE' or s.get('incomplete') or s.get('reached'):
            return False
        for name in WINDOWS:
            w = s[name]
            if not isinstance(w['remainingPercent'], (int, float)) or not 0 <= w['remainingPercent'] <= 100:
                return False
            if not w.get('resetAt'):
                return False
            reset = datetime.fromisoformat(w['resetAt'].replace('Z', '+00:00'))
            if reset <= now:
                return False
        return True
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def quota_decision(s: dict, plan: dict, history: list[dict] | None = None, now=None) -> dict:
    if not snapshot_valid(s, now):
        return {'permitted': False, 'reason': 'FRESH_COMPLETE_QUOTA_REQUIRED', 'reserve': None}
    history = history or []
    same = [r for r in history if r.get('model') == plan['model'] and r.get('effort') == plan['effort'] and r.get('valid')]
    # Learning requires 3 samples; observed deltas are not exclusive-model attribution.
    sample_count = len(same)
    reserve = float(plan['reserve'])
    if sample_count >= 3:
        spend = [float(r['windows'][w]) for r in same[-20:] for w in WINDOWS if isinstance(r.get('windows', {}).get(w), (int, float))]
        if spend:
            reserve = max(reserve, 1.5 * statistics.median(spend) + 3)
    remaining = min(s[w]['remainingPercent'] for w in WINDOWS)
    return {'permitted': remaining > reserve, 'reason': 'CAPACITY_READY' if remaining > reserve else 'LOW_QUOTA_RESERVE',
            'reserve': round(reserve, 2), 'remaining': remaining, 'matchingSamples': sample_count}


def burn_observation(before: dict, after: dict, plan: dict, elapsed_seconds: float) -> dict:
    output = {'schema': 'eveos.codex-burn-observation.v1', 'model': plan['model'], 'effort': plan['effort'],
              'tier': plan['tier'], 'elapsedSeconds': round(max(elapsed_seconds, 0), 2),
              'observedAt': after.get('observedAt'), 'windows': {}, 'valid': False,
              'caveat': 'Account-level percentage-point delta during run; concurrent usage can contribute. Not tokens, dollars or causal model cost.'}
    if not snapshot_valid(before, datetime.fromisoformat(before.get('observedAt', '').replace('Z', '+00:00'))) or not snapshot_valid(after, datetime.fromisoformat(after.get('observedAt', '').replace('Z', '+00:00'))):
        output['reason'] = 'INCOMPLETE_SNAPSHOTS'
        return output
    for window in WINDOWS:
        a, b = before[window], after[window]
        if a.get('resetAt') != b.get('resetAt') or float(b['remainingPercent']) > float(a['remainingPercent']):
            output['reason'] = 'WINDOW_RESET_OR_ACCOUNT_REPLENISHMENT'
            output['windows'] = {}
            return output
        output['windows'][window] = round(float(a['remainingPercent']) - float(b['remainingPercent']), 3)
    output['valid'] = True
    return output


def load_history(path: Path, max_records: int = 250) -> list[dict]:
    if not path.is_file() or path.stat().st_size > 1_000_000:
        return []
    result = []
    for line in path.read_text(encoding='utf-8').splitlines()[-max_records:]:
        try:
            data = json.loads(line)
            if data.get('schema') == 'eveos.codex-burn-observation.v1':
                result.append(data)
        except (ValueError, TypeError):
            pass
    return result
