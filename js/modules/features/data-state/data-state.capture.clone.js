/**
 * Unified State Store Capture Clone Helpers
 */
window.EveDataStore = window.EveDataStore || {};
window.EveDataStore.CaptureModules = window.EveDataStore.CaptureModules || {};

(function () {
    window.EveDataStore.CaptureModules.createCaptureCloneHelpers = function createCaptureCloneHelpers() {
        const VERSION = 1;
        const KNOWLEDGE_STORAGE_KEYS = Object.freeze([
            'fandomDomains',
            'wikiEntries',
            'wikiCategories',
            'wikiDataStore',
            'wikiCacheStore',
            'apiSearchCachePool',
            'apiSearchPrefs'
        ]);

        function getLibraryStateModule() {
            return window.EveLibrary?.State;
        }

        function getLibraryStorageModule() {
            return window.EveLibrary?.Storage;
        }

        function getLinks() {
            if (typeof window.getLiveLinks === 'function') return window.getLiveLinks();
            return window.eveState?.links || window.links || [];
        }

        function getBookmarkFolders() {
            return window.eveState?.bookmarkFolders || window.bookmarkFolders || {};
        }

        function getQuickPins() {
            return window.eveState?.quickPins || window.quickPins || [];
        }

        function getConfig() {
            if (window.eveState?.config) return window.eveState.config;
            if (typeof config !== 'undefined') return config;
            return window.config || {};
        }

        function cloneLinks() {
            return getLinks().map(entry => ({ ...entry }));
        }

        function cloneConfig() {
            const current = getConfig();
            const cloned = { ...current };
            // Audioflix is captured once as a first-class top-level section below. Keeping a
            // second copy here bloats every backup and can make precedence ambiguous on restore.
            delete cloned.audioflix;
            return cloned;
        }

        // Audioflix (soundboard ports, groups, hotkeys, exposure, volumes) lives at
        // config.audioflix. Capture it as a first-class top-level key so it survives backups,
        // exports, and the various extraction paths instead of riding incidentally on config.
        function cloneAudioflix() {
            try {
                const cfg = getConfig();
                return cfg && cfg.audioflix ? JSON.parse(JSON.stringify(cfg.audioflix)) : null;
            } catch (error) {
                return null;
            }
        }

        function cloneAudioflixStructure() {
            try {
                const cfg = getConfig();
                const state = cfg && cfg.audioflix ? cfg.audioflix : null;
                return state ? (window.EveAudioflixStateRecovery?.snapshotStructure?.(state) || null) : null;
            } catch (error) {
                return null;
            }
        }

        function cloneAudioflixStructure() {
            const audioflix = cloneAudioflix();
            return audioflix ? window.EveAudioflixStateRecovery?.captureStructure?.(audioflix) || null : null;
        }

        function cloneBookmarkFolders() {
            try {
                return JSON.parse(JSON.stringify(getBookmarkFolders() || {}));
            } catch (error) {
                return {};
            }
        }

        function cloneQuickPins() {
            try {
                return JSON.parse(JSON.stringify(getQuickPins() || []));
            } catch (error) {
                return [];
            }
        }

        function cloneLibraries() {
            const stateModule = getLibraryStateModule();
            if (!stateModule) return {};
            try {
                return JSON.parse(JSON.stringify(stateModule.getAllLibraries()));
            } catch (error) {
                return {};
            }
        }

        function cloneConnections() {
            const apiConnections = window.EveLibrary?.ConnectionsAPI?.getAll?.();
            const connections = Array.isArray(apiConnections) ? apiConnections : (window.EveLibrary?.Connections || []);
            return connections.map(entry => ({ ...entry }));
        }

        function normalizeKnowledgeContextKey(value) {
            const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
            return normalized || '__global__';
        }

        function parseKnowledgeStorageKey(storageKey) {
            const rawKey = String(storageKey || '').trim();
            if (!rawKey) return null;

            for (const fieldKey of KNOWLEDGE_STORAGE_KEYS) {
                if (rawKey === fieldKey) {
                    return { contextKey: '__global__', fieldKey };
                }

                const suffix = `_${fieldKey}`;
                if (!rawKey.endsWith(suffix)) continue;

                let contextKey = rawKey.slice(0, -suffix.length);
                if (!contextKey) {
                    return { contextKey: '__global__', fieldKey };
                }

                if ((fieldKey === 'apiSearchCachePool' || fieldKey === 'apiSearchPrefs') && contextKey.startsWith('api_')) {
                    contextKey = contextKey.slice(4);
                }

                return {
                    contextKey: normalizeKnowledgeContextKey(contextKey),
                    fieldKey
                };
            }

            return null;
        }

        function cloneValue(value, fallbackValue) {
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (error) {
                return fallbackValue;
            }
        }

        function cloneKnowledgeState() {
            const scopedStorage = {};
            if (typeof localStorage === 'undefined' || typeof localStorage.length !== 'number') {
                return { scopedStorage };
            }

            for (let index = 0; index < localStorage.length; index += 1) {
                const storageKey = localStorage.key(index);
                const parsed = parseKnowledgeStorageKey(storageKey);
                if (!parsed) continue;

                try {
                    const rawValue = localStorage.getItem(storageKey);
                    if (rawValue == null) continue;
                    const parsedValue = JSON.parse(rawValue);
                    const contextKey = normalizeKnowledgeContextKey(parsed.contextKey);
                    if (!scopedStorage[contextKey]) scopedStorage[contextKey] = {};
                    scopedStorage[contextKey][parsed.fieldKey] = cloneValue(parsedValue, parsedValue);
                } catch (error) {
                    console.warn('[EveDataStore] Skipping invalid knowledge storage key during capture:', storageKey, error);
                }
            }

            return { scopedStorage };
        }

        function filterKnowledgeState(knowledgeState, contexts) {
            const normalizedContexts = new Set(
                (Array.isArray(contexts) ? contexts : [contexts])
                    .map((value) => normalizeKnowledgeContextKey(value))
                    .filter(Boolean)
            );
            const scopedStorage = {};
            const sourceBuckets = knowledgeState?.scopedStorage && typeof knowledgeState.scopedStorage === 'object'
                ? knowledgeState.scopedStorage
                : {};

            Object.entries(sourceBuckets).forEach(([contextKey, bucket]) => {
                const normalizedContext = normalizeKnowledgeContextKey(contextKey);
                if (!normalizedContexts.has(normalizedContext)) return;
                scopedStorage[normalizedContext] = cloneValue(bucket, {});
            });

            return { scopedStorage };
        }

        function captureState() {
            return {
                metadata: {
                    version: VERSION,
                    date: new Date().toISOString(),
                    generator: 'EveOS Unified Backup'
                },
                bookmarks: {
                    links: cloneLinks(),
                    config: cloneConfig(),
                    folders: cloneBookmarkFolders(),
                    pins: cloneQuickPins()
                },
                library: {
                    categories: cloneLibraries(),
                    connections: cloneConnections()
                },
                knowledge: cloneKnowledgeState(),
                audioflix: cloneAudioflix(),
                audioflixStructure: cloneAudioflixStructure(),
                audioflixStructure: cloneAudioflixStructure()
            };
        }

        return {
            getLibraryStateModule,
            getLibraryStorageModule,
            getLinks,
            getBookmarkFolders,
            getConfig,
            cloneLinks,
            cloneConfig,
            cloneBookmarkFolders,
            cloneQuickPins,
            cloneConnections,
            KNOWLEDGE_STORAGE_KEYS,
            normalizeKnowledgeContextKey,
            parseKnowledgeStorageKey,
            cloneKnowledgeState,
            filterKnowledgeState,
            cloneAudioflix,
            cloneAudioflixStructure,
            captureState
        };
    };
})();
