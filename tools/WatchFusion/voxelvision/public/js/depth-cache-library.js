/** Navigable UI for browser-local depth analyses. */

import {
  createConversionFeedbackReport,
  normalizeConversionFeedback
} from './depth-feedback-report.js';
import { conversionScoreForSession } from './depth-conversion-score.js';
import { conversionLabel, descriptorConversionMode } from './depth-conversion-mode.js';
import { DEPTH_CACHE_PIPELINE_VERSION } from './depth-cache-codec.js';
import { sortDepthProfilesByQuality } from './depth-profile-resume.js';
import { canonicalMediaIdentity } from './youtube-source.js';

const ISSUE_LABELS = {
  'uneven-depth': 'Uneven / tilted panel',
  'terraced-heights': 'Stacked / terraced heights',
  'border-wall': 'Bottom / edge wall',
  'depth-flicker': 'Depth flicker / pumping',
  'stale-lag': 'Stale or lagging depth',
  'weak-object-separation': 'Weak object separation',
  'missed-foreground-detail': 'Missed hair / thin foreground'
};

function formatDate(value) {
  const date = new Date(Number(value) || 0);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unknown date';
}

function sourceIdentity(session) {
  return canonicalMediaIdentity(session.sourceIdentity || session.descriptor?.source || session.id);
}

function sessionQuality(session) {
  return conversionScoreForSession(session).quality;
}

function yieldToMainThread() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

function scheduleWhenIdle(callback) {
  if (typeof requestIdleCallback === 'function') {
    return { idle: true, id: requestIdleCallback(callback, { timeout: 900 }) };
  }
  return { idle: false, id: setTimeout(callback, 80) };
}

function cancelScheduled(task) {
  if (!task) return;
  if (task.idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(task.id);
  else clearTimeout(task.id);
}

export function groupDepthCacheSessions(sessions = []) {
  const groups = new Map();
  for (const session of sessions) {
    const identity = sourceIdentity(session);
    if (!groups.has(identity)) groups.set(identity, { identity, sessions: [] });
    groups.get(identity).sessions.push(session);
  }
  return [...groups.values()].map(group => {
    const ranked = sortDepthProfilesByQuality(group.sessions);
    group.best = ranked.find(session => session.descriptor?.pipeline === DEPTH_CACHE_PIPELINE_VERSION)
      || ranked[0];
    group.sessions = [group.best, ...ranked.filter(session => session !== group.best)];
    return group;
  }).sort((a, b) => Number(b.best?.lastAccess || 0) - Number(a.best?.lastAccess || 0));
}

function button(label, action, title) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'btn cache-action';
  element.textContent = label;
  if (title) element.title = title;
  element.addEventListener('click', action);
  return element;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.readOnly = true;
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('Clipboard access was denied by the browser.');
}

export class DepthCacheLibrary {
  constructor(coordinator) {
    this.coordinator = coordinator;
    this.container = document.getElementById('depthCacheLibrary');
    this.status = document.getElementById('depthCacheLibraryStatus');
    this.refreshVersion = 0;
    this.initialRefresh = null;
    document.getElementById('refreshDepthCacheBtn')?.addEventListener('click', () => this.refresh());
    document.getElementById('clearDepthCacheBtn')?.addEventListener('click', () => this.#clearAll());
    // Cache browsing is not part of first paint. Let the player controls and
    // WebGL surface become interactive before reading/rendering a large library.
    this.initialRefresh = scheduleWhenIdle(() => this.refresh().catch(() => {}));
  }

  async refresh() {
    if (!this.container) return;
    cancelScheduled(this.initialRefresh);
    this.initialRefresh = null;
    const version = ++this.refreshVersion;
    this.#setStatus('Reading browser-local analyses...', 'working');
    try {
      const sessions = await this.coordinator.listSessions();
      if (version !== this.refreshVersion) return;
      this.container.replaceChildren();
      if (!sessions.length) {
        const empty = document.createElement('div');
        empty.className = 'cache-empty';
        empty.textContent = 'No analyzed videos yet. Hybrid playback adds them here.';
        this.container.append(empty);
        this.#setStatus('Cache library ready.', 'ready');
        return;
      }
      const groups = groupDepthCacheSessions(sessions);
      let sliceStartedAt = performance.now();
      for (const group of groups) {
        this.container.append(this.#renderGroup(group));
        if (performance.now() - sliceStartedAt >= 12) {
          await yieldToMainThread();
          if (version !== this.refreshVersion) return;
          sliceStartedAt = performance.now();
        }
      }
      this.#setStatus(`${groups.length} cached video${groups.length === 1 ? '' : 's'} · ${sessions.length} reusable profile${sessions.length === 1 ? '' : 's'}.`, 'ready');
    } catch (error) {
      this.#setStatus(`Cache library unavailable: ${error.message}`, 'missing');
    }
  }

  #renderGroup(group) {
    const session = group.best;
    const quality = group.sessions
      .map(sessionQuality)
      .filter(item => item.score != null)
      .sort((a, b) => (b.count || 0) - (a.count || 0))[0];
    const card = document.createElement('article');
    card.className = 'cache-card';
    const header = document.createElement('div');
    header.className = 'cache-card-head';
    const title = document.createElement('strong');
    title.textContent = session.sourceTitle || 'Cached video';
    const badge = document.createElement('span');
    badge.className = 'cache-score';
    badge.textContent = quality?.score == null ? 'Scoring...' : `${quality.score}/100 ${quality.grade || ''}`;
    header.append(title, badge);
    const totalNative = group.sessions.reduce((sum, item) => sum + (Number(item.frameCount) || 0), 0);
    const meta = document.createElement('div');
    meta.className = 'cache-meta';
    meta.textContent = `${group.sessions.length} profile${group.sessions.length === 1 ? '' : 's'} · ${totalNative} native depth maps · best profile shown first`;
    const actions = document.createElement('div');
    actions.className = 'cache-actions';
    actions.append(
      button('Replay Best', () => this.#runReplay(session, card), 'Open the most complete stored profile.'),
      button('Delete Video', () => this.#deleteGroup(group, card), 'Permanently remove this video and all of its depth profiles.')
    );
    const profiles = document.createElement('details');
    profiles.className = 'cache-profiles';
    const summary = document.createElement('summary');
    summary.textContent = `Profiles (${group.sessions.length})`;
    profiles.append(summary);
    profiles.addEventListener('toggle', () => {
      if (profiles.open && profiles.dataset.loaded !== 'true') {
        this.#populateProfiles(profiles, group.sessions, card).catch(error => {
          this.#setStatus(`Could not render cached profiles: ${error.message}`, 'missing');
        });
      }
    });
    card.append(header, meta, actions, profiles);
    return card;
  }

  async #populateProfiles(profiles, sessions, card) {
    if (profiles.dataset.loaded === 'true' || profiles.dataset.loading === 'true') return;
    profiles.dataset.loading = 'true';
    let sliceStartedAt = performance.now();
    for (const session of sessions) {
      profiles.append(this.#renderProfile(session, card));
      if (performance.now() - sliceStartedAt >= 12) {
        await yieldToMainThread();
        sliceStartedAt = performance.now();
      }
    }
    profiles.dataset.loaded = 'true';
    delete profiles.dataset.loading;
  }

  #renderProfile(session, card) {
    const descriptor = session.descriptor || {};
    const frameCount = Number(session.frameCount) || 0;
    const reusedFrames = Number(session.reusableFrames) || 0;
    const totalFrames = Number(session.totalFrames) || 0;
    const available = Math.min(totalFrames || Infinity, frameCount + reusedFrames);
    const percent = totalFrames ? Math.round(available / totalFrames * 100) : 0;
    const profile = document.createElement('div');
    profile.className = 'cache-profile';

    const meta = document.createElement('div');
    meta.className = 'cache-meta';
    const conversion = conversionLabel(descriptorConversionMode(descriptor, session.generationEnvironment));
    meta.textContent = `${descriptor.cols || '?'} × ${descriptor.rows || '?'} · ${descriptor.fps || '?'} depth FPS · ${conversion} · ${descriptor.model || 'model'} · ${percent}% playable (${frameCount} native${reusedFrames ? ` + ${reusedFrames} shared` : ''})`;

    if (descriptor.foregroundAssist) meta.textContent += ' · Anime foreground assistance';
    const detail = document.createElement('div');
    detail.className = 'cache-meta';
    const calibrationLabel = session.calibration
      ? `Recalibrated ${session.calibration.frameCount || 0}/${frameCount} cached maps`
      : 'Original calibration';
    const state = percent >= 100 || session.analysisState === 'complete'
      ? 'complete'
      : session.analysisState === 'in-progress' ? 'analyzing' : 'paused - resumes on replay/import';
    detail.textContent = `${calibrationLabel} - ${state} - used ${formatDate(session.lastAccess)}`;

    const actions = document.createElement('div');
    actions.className = 'cache-actions';
    actions.append(
      button('Replay', () => this.#runReplay(session, card), 'Open the stored source with this exact depth profile.'),
      button('Recalibrate', () => this.#runRecalibration(session, card), 'Create a scene-aware calibration overlay while retaining original frames.'),
      button('Delete profile', () => this.#deleteProfile(session, card), 'Remove only this conversion profile. Keep the video and other profiles.')
    );
    profile.append(meta, detail, actions, this.#renderFeedback(session, card));
    return profile;
  }

  #renderFeedback(session, card) {
    const scored = conversionScoreForSession(session);
    const quality = scored.quality;
    const saved = normalizeConversionFeedback(session.feedback);
    const details = document.createElement('details');
    details.className = 'cache-feedback';
    const summary = document.createElement('summary');
    summary.textContent = saved.rating10 == null ? 'Rate + copy compact generation report' : `Your score: ${saved.rating10}/10 - edit or copy report`;

    const automatic = document.createElement('div');
    automatic.className = 'feedback-diagnostics';
    const components = quality.components || {};
    automatic.textContent = `Tool ${quality.score ?? '?'}/100 ${quality.grade || ''} - ${quality.count || 0} samples (${scored.basis}) - edges ${components.edgeAlignment ?? '?'} - temporal ${components.temporalStability ?? '?'} - relief ${components.usefulRelief ?? '?'} - borders ${components.borderIntegrity ?? '?'} - precision ${components.precision ?? '?'}`;

    const scoreLabel = document.createElement('label');
    scoreLabel.className = 'feedback-field';
    const scoreText = document.createElement('span');
    scoreText.textContent = 'Your quality score';
    const score = document.createElement('select');
    score.className = 'feedback-score-input';
    const unrated = document.createElement('option');
    unrated.value = '';
    unrated.textContent = 'Not rated';
    score.append(unrated);
    for (let value = 1; value <= 10; value++) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value}/10`;
      score.append(option);
    }
    score.value = saved.rating10 == null ? '' : String(saved.rating10);
    scoreLabel.append(scoreText, score);

    const issueList = document.createElement('fieldset');
    issueList.className = 'feedback-issues';
    const legend = document.createElement('legend');
    legend.textContent = 'What looked wrong?';
    issueList.append(legend);
    for (const [value, label] of Object.entries(ISSUE_LABELS)) {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = value;
      input.checked = saved.issueTags.includes(value);
      const text = document.createElement('span');
      text.textContent = label;
      row.append(input, text);
      issueList.append(row);
    }

    const notes = document.createElement('textarea');
    notes.className = 'feedback-notes';
    notes.rows = 3;
    notes.maxLength = 4000;
    notes.placeholder = 'Describe the scene and what the voxel conversion got wrong...';
    notes.value = saved.notes;

    const hint = document.createElement('div');
    hint.className = 'cache-meta';
    hint.textContent = 'Tip: replay and pause on the problem frame first. Save/Copy captures that timestamp when this profile is active.';

    const status = document.createElement('div');
    status.className = 'feedback-save-status';
    status.textContent = saved.updatedAt ? `Saved ${formatDate(saved.updatedAt)}` : 'Not saved yet.';

    const actions = document.createElement('div');
    actions.className = 'cache-actions';
    const readFeedback = () => normalizeConversionFeedback({
      rating10: score.value || null,
      issueTags: [...issueList.querySelectorAll('input:checked')].map(input => input.value),
      notes: notes.value,
      playbackTimeSeconds: session.feedback?.playbackTimeSeconds ?? saved.playbackTimeSeconds
    });
    actions.append(
      button('Save Feedback', () => this.#saveFeedback(session, card, readFeedback(), summary, status).catch(error => {
        this.#setStatus(`Could not save feedback: ${error.message}`, 'missing');
      }), 'Save your score and observations with this cache profile.'),
      button('Copy Report', () => this.#copyFeedbackReport(session, card, readFeedback(), summary, status), 'Copy only generation settings, score components and your feedback for Nova.')
    );
    details.append(summary, automatic, scoreLabel, issueList, notes, hint, actions, status);
    return details;
  }

  async #saveFeedback(session, card, feedback, summary, status) {
    this.#disableCard(card, true);
    status.textContent = 'Saving feedback...';
    try {
      const updated = await this.coordinator.saveSessionFeedback(session.id, feedback);
      session.feedback = updated.feedback;
      summary.textContent = updated.feedback.rating10 == null
        ? 'Feedback saved - copy compact generation report'
        : `Your score: ${updated.feedback.rating10}/10 - saved`;
      status.textContent = `Saved ${formatDate(updated.feedback.updatedAt)}.`;
      this.#setStatus('Your assessment is stored with this exact cache profile.', 'ready');
      return updated;
    } catch (error) {
      status.textContent = `Save failed: ${error.message}`;
      throw error;
    } finally {
      this.#disableCard(card, false);
    }
  }

  async #copyFeedbackReport(session, card, feedback, summary, status) {
    try {
      const updated = await this.#saveFeedback(session, card, feedback, summary, status);
      const report = createConversionFeedbackReport(updated);
      await copyText(report.text);
      status.textContent = 'Copied compact generation report. Paste it directly into chat with Nova.';
      this.#setStatus('Compact generation report copied to clipboard.', 'ready');
    } catch (error) {
      status.textContent = `Copy failed: ${error.message}`;
      this.#setStatus(`Could not copy report: ${error.message}`, 'missing');
    }
  }

  async #runReplay(session, card) {
    this.#disableCard(card, true);
    this.#setStatus('Opening cached video and restoring its quality profile...', 'working');
    try {
      await this.coordinator.replaySession(session.id);
      this.#setStatus('Cached video ready. Existing depth frames will replay immediately.', 'ready');
    } catch (error) {
      this.#setStatus(`Replay failed: ${error.message}`, 'missing');
    } finally {
      this.#disableCard(card, false);
    }
  }

  async #runRecalibration(session, card) {
    this.#disableCard(card, true);
    try {
      const result = await this.coordinator.recalibrateSession(session.id, progress => {
        const label = progress.phase === 'scan' ? 'Scanning original maps' : 'Writing calibrated maps';
        this.#setStatus(`${label} ${progress.current}/${progress.total}...`, 'working');
      });
      this.#setStatus(`Recalibrated ${result.frameCount} frames without replacing the originals.`, 'ready');
    } catch (error) {
      this.#setStatus(`Recalibration failed: ${error.message}`, 'missing');
    } finally {
      this.#disableCard(card, false);
    }
  }

  async #deleteGroup(group, card) {
    const title = group.best?.sourceTitle || 'this cached video';
    const confirmed = window.confirm(
      `Delete “${title}” and all ${group.sessions.length} cached depth profile${group.sessions.length === 1 ? '' : 's'}? This cannot be undone.`
    );
    if (!confirmed) return;
    this.#disableCard(card, true);
    this.#setStatus(`Deleting ${title}...`, 'working');
    try {
      const result = await this.coordinator.deleteSourceCache(group.identity);
      await this.refresh();
      this.#setStatus(`Removed ${result.sessions} profile${result.sessions === 1 ? '' : 's'} and ${result.frames} depth maps.`, 'ready');
    } catch (error) {
      this.#disableCard(card, false);
      this.#setStatus(`Delete failed: ${error.message}`, 'missing');
    }
  }
  async #deleteProfile(session, card) {
    const d = session.descriptor || {};
    const label = `${d.cols} × ${d.rows}, ${d.fps} FPS, ${conversionLabel(descriptorConversionMode(d, session.generationEnvironment))}${d.foregroundAssist ? ', anime assistance' : ''}`;
    if (!window.confirm(`Delete the ${label} profile for “${session.sourceTitle || 'Cached video'}”? Its depth maps and feedback cannot be recovered. The video and other profiles are kept.`)) return;
    this.#disableCard(card, true);
    try {
      const result = await this.coordinator.deleteProfile(session.id);
      await this.refresh();
      this.#setStatus(`Removed ${result.sessions} profile and ${result.frames} depth maps. Video and other profiles retained.`, 'ready');
    } catch (error) {
      this.#disableCard(card, false);
      this.#setStatus(`Profile deletion failed: ${error.message}`, 'missing');
    }
  }

  async #clearAll() {
    const sessions = await this.coordinator.listSessions();
    if (!sessions.length) return this.#setStatus('There are no cached conversions to clear.', 'ready');
    if (!window.confirm(`Clear all ${sessions.length} cached depth profiles and stored video sources?`)) return;
    if (!window.confirm('This permanently removes every browser-local VoxelVision conversion. Continue?')) return;
    this.#setStatus('Clearing every cached conversion...', 'working');
    try {
      const result = await this.coordinator.clearAllCaches();
      await this.refresh();
      this.#setStatus(`Cleared ${result.sessions} profiles and ${result.frames} depth maps.`, 'ready');
    } catch (error) {
      this.#setStatus(`Clear all failed: ${error.message}`, 'missing');
    }
  }

  #disableCard(card, disabled) {
    card.querySelectorAll('button').forEach(element => { element.disabled = disabled; });
  }

  #setStatus(message, state) {
    if (!this.status) return;
    this.status.textContent = message;
    this.status.dataset.state = state;
  }
}
