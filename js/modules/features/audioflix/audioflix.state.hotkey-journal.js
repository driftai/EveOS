// Independent recovery mirror for explicit Audioflix sound hotkey assignments.
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const SLOT = 'eveAudioflixHotkeyAssignmentsV1';
    const LIMIT = 10000;
    const cleanId = value => String(value || '').trim().slice(0, 180);
    const cleanCombo = value => value === null ? null : String(value || '').trim().toLowerCase().slice(0, 80);
    function sanitize(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const result = {};
        for (const [rawId, rawCombo] of Object.entries(source).slice(0, LIMIT)) {
            const id = cleanId(rawId), combo = cleanCombo(rawCombo);
            if (id && (combo === null || combo)) result[id] = combo;
        }
        return result;
    }
    function read() {
        try {
            const parsed = JSON.parse(localStorage.getItem(SLOT) || 'null');
            return parsed?.version === 1 ? sanitize(parsed.assignments) : {};
        } catch (_) { return {}; }
    }
    function write(assignments) {
        const clean = sanitize(assignments);
        try {
            localStorage.setItem(SLOT, JSON.stringify({ version: 1, savedAt: Date.now(), assignments: clean }));
            return clean;
        } catch (_) { return clean; }
    }
    function reconcile(assignments) {
        const saved = read(), incoming = sanitize(assignments), merged = { ...incoming, ...saved };
        if (JSON.stringify(saved) !== JSON.stringify(merged)) write(merged);
        return merged;
    }
    function record(id, combo) {
        const key = cleanId(id); if (!key) return read();
        const next = read(), value = cleanCombo(combo);
        if (value === null || value) next[key] = value;
        return write(next);
    }
    Object.assign(ns, { ready: true, read, reconcile, merge: reconcile, record });
})(window.EveAudioflixHotkeyJournal = window.EveAudioflixHotkeyJournal || {});
