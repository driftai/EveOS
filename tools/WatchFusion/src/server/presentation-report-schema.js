// v13.10.8e: bounded, schema-checked timing diagnostics that may cross the presentation route.
// Only enums and capped integers survive. No URLs, IDs, titles, tokens or free text are echoed.
const WORD = /^[a-z][a-z-]{0,41}$/;
const word = value => typeof value === 'string' && WORD.test(value) ? value : null;
const int = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null;
const ms = value => int(value, -600000, 600000);
const count = value => int(value, 0, 100000);

// Which clock the player position was read against; a speaker is never one of them.
export const SENSOR_DOMAINS = new Set(['player-timeline', 'media-element', 'video-frame']);
export const AUDIBLE_OUTPUTS = new Set(['player', 'source-tab', 'both', 'none', 'unknown']);
const CLOCK_STATES = new Set(['bounded', 'coarse', 'thin', 'unstable', 'stale', 'unknown']);
const TIMELINE_STATES = new Set(['advancing', 'slow', 'held', 'jumped', 'unverified']);

function linkedSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {outcome: word(value.outcome), stage: word(value.stage), attempts: count(value.attempts),
    witnesses: count(value.witnesses), errorMs: ms(value.errorMs), segment: count(value.segment), verifyMs: int(value.verifyMs, 0, 600000),
    beforeMs: ms(value.beforeMs), residualMs: ms(value.residualMs), progressMs: ms(value.progressMs), contradictedMs: ms(value.contradictedMs)};
}

export function sanitizeHostRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {outcome: word(value.outcome), stage: word(value.stage), reference: word(value.reference),
    attempts: count(value.attempts), witnesses: count(value.witnesses), peerCount: count(value.peerCount),
    peerSpreadMs: ms(value.peerSpreadMs), hostErrorMs: ms(value.hostErrorMs), peerErrorMs: ms(value.peerErrorMs),
    gapMs: ms(value.gapMs), dwellMs: int(value.dwellMs, 0, 600000), verifyMs: int(value.verifyMs, 0, 600000),
    linkedSource: linkedSource(value.linkedSource)};
}

export function sanitizeSensor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {domain: SENSOR_DOMAINS.has(value.domain) ? value.domain : null,
    heldMs: int(value.heldMs, 0, 10000), cadenceMs: int(value.cadenceMs, 0, 10000),
    clockBoundMs: int(value.clockBoundMs, 0, 10000), clockState: CLOCK_STATES.has(value.clockState) ? value.clockState : 'unknown',
    timelineState: TIMELINE_STATES.has(value.timelineState) ? value.timelineState : 'unverified',
    timelineRatePct: int(value.timelineRatePct, 0, 300), audibleOutput: AUDIBLE_OUTPUTS.has(value.audibleOutput) ? value.audibleOutput : 'unknown'};
}

// Diagnostic fields do not grant correction authority; only bounded values survive.
export function sanitizeMemberPrecision(v){
  if(!v||typeof v!=='object'||Array.isArray(v))return null;
  return {reason:word(v.reason),medianMs:ms(v.medianMs),madMs:int(v.madMs,0,600000),pulses:count(v.pulses),active:v.active===true,restoring:v.restoring===true,verdict:word(v.verdict),verification:word(v.verification),rateTrial:word(v.rateTrial),rateAttempts:count(v.rateAttempts),clockAllowanceMs:int(v.clockAllowanceMs,0,10000)};
}
// Remote decoder diagnostics are bounded enums and integers only: never raw messages or URLs.
export function sanitizeDecoderRecovery(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return {outcome:word(v.outcome),steps:int(v.steps,0,2),healthyProgressMs:int(v.healthyProgressMs,0,600000),
    stallMs:int(v.stallMs,0,600000),stallSteps:int(v.stallSteps,0,3),arbiterReason:word(v.arbiterReason),
    replayLoads:count(v.replayLoads)};
}

// Bounded per-room event journal survives peer report expiry, source changes,
// and output-session replacement. No URLs, tokens, arbitrary payloads or IDs in exported logs.
const journals=new WeakMap(), RECOVERY_AGE=1800000, RECOVERY_MAX=180;
const RECOVERY_KINDS=new Set(['reload-requested','reload-issued','reload-failed','rebuild-requested','rebuild-issued','rebuild-failed','motion-restored','handoff-issued','handoff-verified','handoff-unverified','retry-reload-requested','retry-reload-issued','retry-reload-failed','budget-spent','manual-rebuild-requested','manual-rebuild-issued','manual-rebuild-failed']);
function recoveryQueue(room,time){let q=journals.get(room);if(!q){q=new Map();journals.set(room,q);}for(const [key,e] of q)if(time-e.at>=RECOVERY_AGE)q.delete(key);return q;}
export function collectRecoveryEvents(room,member,events,time){
  if(!Array.isArray(events)||!Number.isFinite(time))return [];
  const q=recoveryQueue(room,time),ack=[];
  for(const e of events.slice(0,8)){
    if(!e||typeof e.id!=='string'||!/^[0-9a-f-]{8,64}$/.test(e.id)||!RECOVERY_KINDS.has(e.kind)||!Number.isFinite(e.ageMs)||e.ageMs<0||e.ageMs>=RECOVERY_AGE)continue;
    const id=e.id;
    if(!q.has(id)){const device=typeof member.name==='string'?member.name.replace(/(?:https?:\/\/|www\.)\S+/gi,'[link]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,80):'Viewer';q.set(id,{id,kind:e.kind,device,at:Math.round(time-e.ageMs),segment:int(e.segment,0,1e9),step:int(e.step,0,2),errorMs:ms(e.errorMs)});}
    ack.push(e.id);while(q.size>RECOVERY_MAX)q.delete(q.keys().next().value);
  }
  return ack;
}
export function recoveryHistory(room,time){return [...recoveryQueue(room,time).values()];}

// Why a member's report did not become a peer row: counts only, per room timing scope.
export const REJECTIONS = ['payload', 'invalid-body', 'epoch-changed', 'clock-skew', 'invalid-report'];
export function noteRejection(entry, reason) {
  entry.rejections ||= Object.fromEntries(REJECTIONS.map(name => [name, 0]));
  if (reason in entry.rejections) entry.rejections[reason] = Math.min(1e6, entry.rejections[reason] + 1);
}

export function roster(entry, room, time) {
  const seen = [...room.members.values()].filter(item => time - item.lastSeen <= 15000).length;
  const reporting = [...entry.reports.values()].filter(item => time - item.receivedAt <= 5000).length;
  return {members: seen, reporting, rejections: {...(entry.rejections || Object.fromEntries(REJECTIONS.map(name => [name, 0])))}};
}
