/**
 * interimIngestHandler.js
 * Smooth, monotonic playback for Gemini Live PCM chunks.
 */

window.AudioIngestCore = window.AudioIngestCore || {};

window.AudioIngestCore.InterimIngestHandler = {
    lastPacketTime: 0,
    activeSources: [],
    freshStartRequested: false,
    nextStartTime: 0,

    INITIAL_HEADROOM: 0.15,
    RESYNC_THRESHOLD: 5.0,
    IDLE_THRESHOLD: 10.0,
    MAX_LEAD: 2.0,
    HEARTBEAT_TIMEOUT: 15000,

    diagnostics: {
        chunks: 0,
        underflows: 0,
        backlogRecoveries: 0,
        backlogSourcesDropped: 0,
        hardStops: 0,
        maxLeadSec: 0,
        lastLeadSec: 0,
        lastArrivalGapMs: 0,
        maxArrivalGapMs: 0,
        lastPacketAt: 0
    },

    reset: function (context) {
        if (context) {
            this.nextStartTime = context.currentTime;
            this.freshStartRequested = true;
            this.lastPacketTime = 0;
        }
    },

    /** Hard cancellation is reserved for explicit stop/barge-in. */
    stopAll: function (reason = 'manual') {
        this.activeSources.forEach(source => {
            try { source.stop(); } catch (e) { }
        });
        this.activeSources = [];
        this.nextStartTime = 0;
        this.freshStartRequested = false;
        this.lastPacketTime = 0;
        this.diagnostics.hardStops += 1;
        if (reason) this.diagnostics.lastStopReason = String(reason);
    },

    /**
     * When the producer gets far ahead, discard only audio that has not begun yet.
     * The previous implementation called stopAll(), cutting the source the user was actively
     * hearing and producing the exact mid-word chop this guard was supposed to prevent.
     */
    dropQueuedBacklog: function (context) {
        if (!context) return 0;
        const now = context.currentTime;
        const kept = [];
        let dropped = 0;
        let playingEnd = now;

        this.activeSources.forEach(source => {
            const start = Number(source._eveStartTime);
            const end = Number(source._eveEndTime);
            if (Number.isFinite(start) && start > now + 0.01) {
                try { source.stop(); } catch (e) { }
                dropped += 1;
                return;
            }
            kept.push(source);
            if (Number.isFinite(end) && end > playingEnd) playingEnd = end;
        });

        this.activeSources = kept;
        this.nextStartTime = Math.max(playingEnd, now + this.INITIAL_HEADROOM);
        this.diagnostics.backlogRecoveries += 1;
        this.diagnostics.backlogSourcesDropped += dropped;
        return dropped;
    },

    isStillStreaming: function (context) {
        if (!context) return false;
        const now = Date.now();
        const isHeartbeatActive = this.lastPacketTime > 0
            && (now - this.lastPacketTime < this.HEARTBEAT_TIMEOUT);
        return this.activeSources.length > 0
            || this.nextStartTime > context.currentTime
            || isHeartbeatActive;
    },

    getDiagnostics: function () {
        const context = window.audioInputContext;
        const lead = context ? Math.max(0, this.nextStartTime - context.currentTime) : 0;
        return {
            available: true,
            ...this.diagnostics,
            activeSources: this.activeSources.length,
            queueLeadSec: Number(lead.toFixed(3)),
            maxLeadConfiguredSec: this.MAX_LEAD,
            initialHeadroomSec: this.INITIAL_HEADROOM,
            contextState: context?.state || 'unavailable',
            outputSampleRate: Number(context?.sampleRate || 0) || null
        };
    },

    playInterimAudio: async function (base64AudioChunk, context) {
        const arrivalNow = Date.now();
        if (this.diagnostics.lastPacketAt) {
            const arrivalGap = arrivalNow - this.diagnostics.lastPacketAt;
            this.diagnostics.lastArrivalGapMs = arrivalGap;
            this.diagnostics.maxArrivalGapMs = Math.max(this.diagnostics.maxArrivalGapMs, arrivalGap);
        }
        this.diagnostics.lastPacketAt = arrivalNow;
        this.diagnostics.chunks += 1;
        this.lastPacketTime = arrivalNow;

        const arrayBuffer = base64ToArrayBuffer(base64AudioChunk);
        try {
            if (typeof createAudioBufferFromPCM !== 'function') {
                console.warn("createAudioBufferFromPCM not available for interim playback");
                return;
            }

            const audioBuffer = createAudioBufferFromPCM(arrayBuffer, context);
            const interimSource = context.createBufferSource();
            interimSource.buffer = audioBuffer;
            interimSource.playbackRate.value = 1.0;
            interimSource.connect(context.destination);

            const gap = context.currentTime - this.nextStartTime;
            const isFreshStart = this.freshStartRequested
                || (this.activeSources.length === 0 && gap > this.IDLE_THRESHOLD);

            if (isFreshStart) {
                try {
                    const chirp = context.createBuffer(1, 1, 24000);
                    const chirpSource = context.createBufferSource();
                    chirpSource.buffer = chirp;
                    chirpSource.connect(context.destination);
                    chirpSource.start();
                } catch (e) { /* warm-up is best effort */ }

                this.nextStartTime = context.currentTime + this.INITIAL_HEADROOM;
                this.freshStartRequested = false;
            } else if (gap > this.RESYNC_THRESHOLD) {
                this.diagnostics.underflows += 1;
                this.nextStartTime = context.currentTime + this.INITIAL_HEADROOM;
            }

            let lead = this.nextStartTime - context.currentTime;
            if (lead > this.MAX_LEAD) {
                const dropped = this.dropQueuedBacklog(context);
                console.warn(`[InterimIngestHandler] ${lead.toFixed(2)}s stale lead; `
                    + `dropped ${dropped} not-yet-started sources without cutting current speech.`);
                lead = this.nextStartTime - context.currentTime;
            }

            const startTime = Math.max(this.nextStartTime, context.currentTime);
            if (startTime <= context.currentTime + 0.001 && this.activeSources.length === 0) {
                this.diagnostics.underflows += 1;
            }

            interimSource._eveStartTime = startTime;
            interimSource._eveEndTime = startTime + audioBuffer.duration;
            interimSource.start(startTime);

            this.activeSources.push(interimSource);
            interimSource.onended = () => {
                this.activeSources = this.activeSources.filter(s => s !== interimSource);
            };

            this.nextStartTime = interimSource._eveEndTime;
            const scheduledLead = Math.max(0, this.nextStartTime - context.currentTime);
            this.diagnostics.lastLeadSec = Number(scheduledLead.toFixed(3));
            this.diagnostics.maxLeadSec = Math.max(this.diagnostics.maxLeadSec, scheduledLead);
        } catch (error) {
            console.error("Error playing interim audio chunk:", error);
        }
    }
};

console.log("interimIngestHandler.js loaded.");
