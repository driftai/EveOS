// Disk-status audit for Audioflix localization. An unavailable bridge or unreadable browser
// folder is "unverified", never proof that a file was deleted.
window.EveAudioflixLocalizeAudit = window.EveAudioflixLocalizeAudit || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixLocalizeAudit;
    if (ns.ready) return;

    ns.create = function create(deps) {
        const { S, text, paths, collectScope, getScopeDir, extractDir } = deps;

        async function auditScopeDiskStatus(scope, key) {
            const targetDir = getScopeDir(scope, key);
            const items = collectScope(scope, key);
            if (!items.length) {
                return { ok: true, complete: true, checked: 0, verified: 0, missing: 0, unverified: 0 };
            }

            const N = window.EveAudioflixNative;
            const FS = window.EveAudioflixFsPorts;
            const indexFiles = (files) => {
                const index = { paths: new Set(), names: new Set() };
                (Array.isArray(files) ? files : []).forEach((file) => {
                    if (file?.path) index.paths.add(paths?.key?.(file.path) || text(file.path).toLowerCase());
                    const name = text(file?.fileName || paths?.basename?.(file?.path)).toLowerCase();
                    if (name) index.names.add(name);
                });
                return index;
            };
            const presentIn = (dirFiles, value) => {
                const clean = text(value);
                if (!clean) return false;
                const filename = text(paths?.basename?.(clean)).toLowerCase();
                const pathKey = paths?.key?.(clean) || clean.toLowerCase().replace(/\\/g, '/');
                return dirFiles.paths.has(pathKey) || dirFiles.names.has(filename);
            };
            const dirCache = new Map();
            const scanDir = async (dir) => {
                const cacheKey = paths?.key?.(dir) || text(dir).toLowerCase();
                if (!cacheKey) return { verified: false, files: indexFiles([]) };
                if (dirCache.has(cacheKey)) return dirCache.get(cacheKey);
                let result = { verified: false, files: indexFiles([]) };
                try {
                    if (typeof N?.scanLocalized === 'function') {
                        const scan = await N.scanLocalized(dir);
                        if (scan?.ok) result = { verified: true, files: indexFiles(scan.files) };
                    }
                } catch { /* transport failure is unverified, not deleted */ }
                dirCache.set(cacheKey, result);
                return result;
            };
            const targetScan = targetDir
                ? await scanDir(targetDir)
                : { verified: false, files: indexFiles([]) };

            const browserCheck = async (claim) => {
                if (typeof FS?.verifyPath !== 'function') return { verified: false, present: false };
                try { return await FS.verifyPath(claim); }
                catch { return { verified: false, present: false }; }
            };

            let checked = 0;
            let verified = 0;
            let missing = 0;
            let unverified = 0;
            let shortcuts = 0;
            for (const item of items) {
                const claims = [];
                (item.localizations || []).forEach((entry) => {
                    const physical = entry.kind === 'shortcut' && text(entry.linkOf)
                        ? text(entry.linkOf)
                        : text(entry.path);
                    if (physical) claims.push(physical);
                    if (entry.kind === 'shortcut') shortcuts += 1;
                });
                if (!claims.length && text(item.localPath)) claims.push(text(item.localPath));
                if (!claims.length) continue;

                checked += 1;
                let found = false;
                let allClaimsVerified = true;
                for (const claim of claims) {
                    const ownScan = await scanDir(extractDir(claim));
                    const insideTarget = !!targetDir && paths?.relativeTo?.(claim, targetDir) != null;
                    const nativeVerified = ownScan.verified || (insideTarget && targetScan.verified);
                    const nativePresent = presentIn(ownScan.files, claim)
                        || (insideTarget && presentIn(targetScan.files, claim));
                    const browser = nativePresent
                        ? { verified: false, present: false }
                        : await browserCheck(claim);
                    if (nativePresent || browser.present) {
                        found = true;
                        break;
                    }
                    if (!nativeVerified && !browser.verified) allClaimsVerified = false;
                }

                if (found) {
                    verified += 1;
                    if (item.missingLocal) S()?.updateItem?.('music', item.id, { missingLocal: false });
                } else if (allClaimsVerified) {
                    verified += 1;
                    missing += 1;
                    if (!item.missingLocal) S()?.updateItem?.('music', item.id, { missingLocal: true });
                } else {
                    // Unavailable localhost / revoked browser permission proves nothing. Preserve the
                    // last verified health state until one of the real folder sensors can read it.
                    unverified += 1;
                }
            }

            return {
                ok: true,
                complete: unverified === 0,
                checked,
                verified,
                missing,
                unverified,
                shortcuts,
                targetDir,
                reason: unverified
                    ? 'Local files could not be verified. Start EveOS localhost or grant this folder.'
                    : ''
            };
        }

        return auditScopeDiskStatus;
    };

    ns.ready = true;
})();
