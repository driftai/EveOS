/** Source-level facade over profile-specific IndexedDB depth records. */

import {
  buildDepthReusePlans,
  descriptorsShareDepthTimeline,
  materializeDepthReusePlan
} from './depth-cache-reuse.js';
import { descriptorConversionMode } from './depth-conversion-mode.js';

export class DepthCacheTimeline {
  constructor(store) {
    this.store = store;
    this.plans = new Map();
    this.sessionCount = 0;
    this.quality = null;
  }

  async prepare(cacheId, descriptor, frameCount, exactIndices) {
    const target = {
      ...descriptor,
      conversion: descriptorConversionMode(descriptor)
    };
    const sessions = (await this.store.listSessions())
      .map(session => ({
        ...session,
        descriptor: {
          ...(session.descriptor || {}),
          conversion: descriptorConversionMode(session.descriptor, session.generationEnvironment)
        }
      }))
      .filter(session => session.id !== cacheId && descriptorsShareDepthTimeline(target, session.descriptor));
    const indicesByCacheId = new Map();
    await Promise.all(sessions.map(async session => {
      indicesByCacheId.set(session.id, await this.store.frameIndices(session.id));
    }));
    this.plans = buildDepthReusePlans({
      target,
      targetFrameCount: frameCount,
      sessions,
      indicesByCacheId,
      exactIndices
    });
    const donorIds = new Set([...this.plans.values()].map(plan => plan.donorId));
    this.sessionCount = donorIds.size;
    this.quality = sessions
      .filter(session => donorIds.has(session.id) && session.qualityAccumulator?.score != null)
      .sort((a, b) => (b.qualityAccumulator.count || 0) - (a.qualityAccumulator.count || 0))[0]
      ?.qualityAccumulator || null;
    return this.snapshot();
  }

  has(index) {
    return this.plans.has(Number(index));
  }

  isAuthoritative(index) {
    return Boolean(this.plans.get(Number(index))?.authoritative);
  }

  async load(index, targetDescriptor) {
    const plan = this.plans.get(Number(index));
    if (!plan) return null;
    const first = await this.store.getFrame(plan.donorId, plan.firstIndex);
    const second = plan.secondIndex === plan.firstIndex
      ? first
      : await this.store.getFrame(plan.donorId, plan.secondIndex);
    const result = materializeDepthReusePlan(plan, first, second, targetDescriptor);
    return result ? { ...result, plan } : null;
  }

  clear() {
    this.plans.clear();
    this.sessionCount = 0;
    this.quality = null;
  }

  snapshot() {
    let authoritativeFrames = 0;
    for (const plan of this.plans.values()) if (plan.authoritative) authoritativeFrames += 1;
    return {
      reusableFrames: this.plans.size,
      authoritativeFrames,
      donorProfiles: this.sessionCount,
      quality: this.quality
    };
  }
}
