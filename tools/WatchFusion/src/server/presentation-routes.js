import { json, readBody } from './http-utils.js';
import { createPlayoutCoordinator } from './playout-coordinator.js';
import { noteRejection, roster, sanitizeHostRecovery, sanitizeSensor, sanitizeDecoderRecovery, sanitizeMemberPrecision, collectRecoveryEvents, recoveryHistory } from './presentation-report-schema.js';

const reportsByRoom = new WeakMap();
const reportLifetime = 5000;
const proposalLifetime = 120000;
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const metric = (value, min, max) => finite(value, min, max) ? value : null;
const shortId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value);

function scope(room) {
  const source = room.source;
  const mode = source?.kind === 'media' && source.url ? 'direct' : source?.videoId ? 'youtube' : '';
  return { mode, source, linked: room.linkedSourceId || null, host: room.hostId };
}

export function presentationScope(room) {
  const current = scope(room);
  const previous = reportsByRoom.get(room);
  if (previous && previous.current.source === current.source && previous.current.linked === current.linked && previous.current.host === current.host) return previous;
  const entry = { current, epoch: (previous?.epoch || 0) + 1, reports: new Map(), proposals: new Map(), playout:createPlayoutCoordinator() };
  reportsByRoom.set(room, entry);
  return entry;
}

export function observeLinkedPlayout(room, sample, at) {
  const entry = presentationScope(room);
  if (!entry.current.mode || !entry.current.linked) return;
  entry.playout.transport(room.playback);
  entry.linkedOutput = {muted:sample.tabMuted, at};
  entry.playout.observe('linked', sample, at);
}

export async function handlePresentation(req, res, room, member, at = Date.now()) {
  const entry = presentationScope(room);
  const { current } = entry;
  if (!current.mode) return json(res, 409, { error: 'This playback mode does not support acoustic calibration.' });

  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST for presentation timing.' });
  let body;
  try { body = await readBody(req, { maxBytes: 2560 }); }
  catch (error) { noteRejection(entry, error.code === 'PAYLOAD_TOO_LARGE' ? 'payload' : 'invalid-body'); return json(res, error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: 'Invalid presentation request.' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { noteRejection(entry, 'invalid-body'); return json(res, 400, { error: 'Invalid presentation request.' }); }
  if (presentationScope(room) !== entry || body.epoch !== entry.epoch || !room.members.has(member.id)) {
    noteRejection(entry, 'epoch-changed');
    return json(res, 409, { error: 'Room timing changed.' });
  }
  const time = Date.now();
  const segment = entry.playout.transport(room.playback);
  for (const [id, item] of entry.reports) if (!room.members.has(id) || time - item.receivedAt > reportLifetime) entry.reports.delete(id);
  for (const [id, item] of entry.proposals) if (!room.members.has(id) || item.expiresAt <= time) entry.proposals.delete(id);
  let recoveryAck=[];
  if (body.report) {
    const report = body.report;
    if (!shortId(report.outputSession) || report.mode !== current.mode || !finite(report.sampledAt, at - 1800, at + 150) ||
        !finite(report.rate, .25, 2.05) || !finite(report.positionMs, 0, 1e10) || !finite(report.roomPositionMs, 0, 1e10)) {
      // v13.10.8e: a device whose clock estimate is skewed used to vanish from the trace without a reason.
      noteRejection(entry, finite(report.sampledAt, 0, 1e15) && !finite(report.sampledAt, at - 1800, at + 150) ? 'clock-skew' : 'invalid-report');
      return json(res, 400, { error: 'Stale or invalid playback timing.' });
    }
    recoveryAck=collectRecoveryEvents(room,member,report.decoderRecovery?.events,time);
    const prior = entry.reports.get(member.id);
    if (!prior || report.sampledAt > prior.sampledAt) {
      if (member.id === room.hostId && body.segment === segment)
        entry.mirrorConflict = report.mirrorContradicted === true ? {segment, at:report.sampledAt} : null;
      if (prior && prior.outputSession !== report.outputSession) entry.proposals.delete(member.id);
      entry.reports.set(member.id, {
        member: member.publicId, mode: current.mode, receivedAt: at, sampledAt: report.sampledAt, outputSession: report.outputSession,
        ...(report.clientBuild==='wf-06jid'?{clientBuild:report.clientBuild}:{}),
        playoutSegment:body.segment === segment ? segment : null, positionMs: report.positionMs, roomPositionMs: report.roomPositionMs, rate: report.rate,
        targetPositionMs: metric(report.targetPositionMs, 0, 1e10),
        rttMs: metric(report.rttMs, 0, 5000), offsetMs: metric(report.offsetMs, -1e12, 1e12),
        clockWitness: report.clockWitness === true,
        adjustmentMs: metric(report.adjustmentMs, -1500, 1500),
        videoFrameOffsetMs: metric(report.videoFrameOffsetMs, -2000, 2000),
        sourceAgeMs: metric(report.sourceAgeMs, 0, 10000),
        startupWaitMs: metric(report.startupWaitMs, 0, 30000),
        startupPhase: typeof report.startupPhase === 'string' && /^(?:source-awaiting|awaiting-first-frame|awaiting-play|decoder-buffering|decoder-stalled|decoder-warming|decoder-advancing|decoder-confirmed|fine-locked|room-paused|direct-ready)$/.test(report.startupPhase) ? report.startupPhase : null,
        audioReadiness: typeof report.audioReadiness === 'string' && /^(?:room-muted|needs-gesture|verifying|player-unmuted|autoplay-blocked|unknown)$/.test(report.audioReadiness) ? report.audioReadiness : null,
        corrections: metric(report.corrections, 0, 1e6),
        filteredDriftMs: metric(report.filteredDriftMs, -200000, 200000),
        seekHealth: report.seekHealth && typeof report.seekHealth === 'object' ? {
          reason: typeof report.seekHealth.reason === 'string' && /^[a-z-]{1,40}$/.test(report.seekHealth.reason) ? report.seekHealth.reason : null,
          attempts: metric(report.seekHealth.attempts, 0, 1e6),
          failures: metric(report.seekHealth.failures, 0, 100),
          overshoots: metric(report.seekHealth.overshoots, 0, 1e6),
          cooldownRemainingMs: metric(report.seekHealth.cooldownRemainingMs, 0, 60000),
          recoveryAttempts: Number.isInteger(report.seekHealth.recoveryAttempts) ? metric(report.seekHealth.recoveryAttempts, 0, 1e6) : null,
          lastRecoveryBiasMs: metric(report.seekHealth.lastRecoveryBiasMs, 0, 2500)
        } : null,
        ready: report.ready === true, playing: report.playing === true, buffering: report.buffering === true,
        bufferedUntilMs: metric(report.bufferedUntilMs, 0, 1e10),
        recentCorrection: typeof report.recentCorrection === 'string' && /^[a-z-]{1,42}$/.test(report.recentCorrection) ? report.recentCorrection : null,
        audible: report.audible === true, follows: report.follows === true, correcting: report.correcting === true,
        // v13.10.8e: host recovery (legacy peer path and source-led path) and sensor provenance survive, bounded.
        hostRecovery: member.id === room.hostId ? sanitizeHostRecovery(report.hostRecovery) : null,
        sensor: sanitizeSensor(report.sensor), decoderRecovery: sanitizeDecoderRecovery(report.decoderRecovery), memberPrecision:sanitizeMemberPrecision(report.memberPrecision), precisionAllowanceMs:member.id===room.hostId&&current.mode==='youtube'&&body.segment===segment&&report.clockWitness===true&&finite(report.rttMs,0,45)?metric(report.precisionAllowanceMs,0,12):null
      });
      // Off-rate playback is active correction, not a reason to drop the device:
      // it remains observed as telemetry while excluded from reference selection.
      const offRate = report.playing && Math.abs(report.rate - room.playback.rate) > .041 * room.playback.rate;
      if (body.segment === segment) entry.playout.observe(member.id, {
        ...entry.reports.get(member.id), correcting: offRate || report.correcting === true,
        uncertaintyMs: finite(report.rttMs, 0, 200) ? (current.mode === 'youtube' ? 35 : 12) + report.rttMs / 2 : Infinity
      }, at);
    }
  }

  if (body.proposal) {
    if (room.hostId !== member.id) return json(res, 403, { error: 'Only the room host can send a calibration.' });
    const { target, outputSession, adjustmentMs, observedMs, uncertaintyMs, id } = body.proposal;
    const receiver = [...room.members.values()].find(item => item.publicId === target);
    const report = receiver && entry.reports.get(receiver.id);
    if (!entry.reports.has(member.id) || !report?.follows || !report.ready || report.outputSession !== outputSession ||
        receiver.id === member.id || !finite(adjustmentMs, -1500, 1500)
        || !finite(observedMs, -1500, 1500) || !finite(uncertaintyMs, 5, 30)
        || !shortId(id)) {
      return json(res, 409, { error: 'A current viewer and a confident measurement are required.' });
    }
    entry.proposals.set(receiver.id, { id, outputSession, adjustmentMs, observedMs, uncertaintyMs, expiresAt: time + proposalLifetime });
  }
  const proposal = entry.proposals.get(member.id);
  if (proposal && body.dismiss === proposal.id) entry.proposals.delete(member.id);
  const viewers = new Set([...room.members.values()].filter(item =>
    time - item.lastSeen <= 15000 && (entry.current.linked || item.id !== room.hostId)).map(item => item.id));
  const coordination = entry.playout.coordinate({now:time, authority:entry.current.linked ? 'linked' : room.hostId, viewers,
    allowHoldback:entry.current.mode === 'direct' && entry.linkedOutput?.muted === true && time - entry.linkedOutput.at < 1800});
  coordination.mirrorContradicted = entry.mirrorConflict?.segment === segment && time - entry.mirrorConflict.at <= 1500;
  // Only the current host's current-segment report can corroborate member precision.
  const hostReport=entry.reports.get(room.hostId);
  if(member.id!==room.hostId&&entry.current.mode==='youtube'&&entry.current.linked&&hostReport?.playoutSegment===segment&&time-hostReport.receivedAt<=1000&&room.members.has(room.hostId)){
    const {member,outputSession,playoutSegment,positionMs,sampledAt,rate,ready,playing,buffering,correcting,adjustmentMs,startupPhase,clockWitness,audible,rttMs,precisionAllowanceMs}=hostReport;
    coordination.hostWitness={member,outputSession,playoutSegment,positionMs,sampledAt,rate,ready,playing,buffering,correcting,adjustmentMs,startupPhase,clockWitness,audible,rttMs,precisionAllowanceMs};
  }
  return json(res, 200, {
    serverReceivedAt: at, serverTime: Date.now(), coordination, serverBuild:'wf-06jid', recoveryAck,
    ...((body.diagnostics === true || body.trace === true) ? {peers:[...entry.reports.values()], roster:roster(entry, room, time),...(body.trace===true?{recoveryHistory:recoveryHistory(room,time)}:{})} : {}),
    ...(body.diagnostics === true ? {proposal:entry.proposals.get(member.id) || null} : {})
  });
}
