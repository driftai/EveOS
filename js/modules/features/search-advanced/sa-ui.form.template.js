window.EveOS = window.EveOS || {};
window.EveOS.SearchAdvanced = window.EveOS.SearchAdvanced || {};
window.EveOS.SearchAdvanced.Modules = window.EveOS.SearchAdvanced.Modules || {};

(function () {
    if (window.EveOS.SearchAdvanced.Modules.createUiFormTemplate) return;

    window.EveOS.SearchAdvanced.Modules.createUiFormTemplate = function createUiFormTemplate() {
        return `
<div class="modal-overlay" id="expandedSearchModal">
    <div class="nx-panel">
        <!-- RPG Frame Corner Decorations -->
        <div class="nx-corner nx-corner-tl"></div>
        <div class="nx-corner nx-corner-tr"></div>
        <div class="nx-corner nx-corner-bl"></div>
        <div class="nx-corner nx-corner-br"></div>

        <!-- Header -->
        <div class="nx-header">
            <div class="nx-header-title">
                <span class="nx-header-icon">⚔</span>
                <span class="nx-header-text">NEXUS SEARCH</span>
                <span class="nx-header-sub">Unified Knowledge Index</span>
            </div>
            <div class="nx-header-actions">
                <button type="button" class="nx-gemini-btn nx-audioflix-btn" id="nxAudioflixLinkBtn" title="Return to Nexus Audio Link" style="background:linear-gradient(135deg,rgba(255,202,95,0.25),rgba(245,158,11,0.35)); border:1px solid rgba(255,202,95,0.5); color:#ffca5f; font-weight:700; margin-right:6px;">🔎 Nexus Audio Link</button>
                <button type="button" class="nx-gemini-btn" id="nxGeminiLinkBtn" title="Open Gemini AI Link">✦ Gemini</button>
                <button class="nx-close-btn" onclick="closeModals()" title="Close">✕</button>
            </div>
        </div>

        <!-- Main Body: Two Columns -->
        <div class="nx-body">
            <!-- Left Column: Controls -->
            <div class="nx-sidebar" id="nxSidebar">
                <button type="button" class="nx-sidebar-toggle" id="nxSidebarToggle" title="Collapse sidebar">◀</button>
                <!-- Search Input -->
                <div class="nx-section nx-section-query" id="nxQuerySection">
                    <label class="nx-section-label">⌕ QUERY</label>
                    <div class="nx-typeahead-wrap">
                        <input type="text" id="esQuery" class="nx-input nx-query-input" placeholder="Search across all vectors..." autocomplete="off" aria-autocomplete="list" aria-controls="nxTypeahead" aria-expanded="false">
                        <div class="nx-typeahead" id="nxTypeahead" role="listbox" hidden></div>
                    </div>
                </div>

                <nav class="nx-jump-rail" id="nxJumpRail" aria-label="Nexus panel navigation">
                    <button type="button" class="nx-jump-btn nx-jump-active" data-nx-jump="query">Query</button>
                    <button type="button" class="nx-jump-btn" data-nx-jump="vectors">Vectors</button>
                    <button type="button" class="nx-jump-btn" data-nx-jump="filters">Filters</button>
                    <button type="button" class="nx-jump-btn" data-nx-jump="debug">Debug</button>
                    <button type="button" class="nx-jump-btn" data-nx-jump="state">View State</button>
                    <button type="button" class="nx-jump-btn" data-nx-jump="results">Results</button>
                </nav>

                <!-- Search Vectors (RPG Skill Slots) -->
                <div class="nx-section" id="nxVectorSection">
                    <label class="nx-section-label">⚡ SEARCH VECTORS</label>
                    <div class="nx-vector-grid">
                        <button type="button" class="nx-vector-slot nx-active" id="nxVectorGoogle" data-vector="google" title="Google Custom Search">
                            <span class="nx-vector-icon">🔍</span>
                            <span class="nx-vector-name">Google CSE</span>
                            <span class="nx-vector-glow"></span>
                        </button>
                        <button type="button" class="nx-vector-slot nx-active" id="nxVectorKnowledge" data-vector="knowledge" title="Saved source graph and knowledge caches">
                            <span class="nx-vector-icon">🧭</span>
                            <span class="nx-vector-name">Source Graph</span>
                            <span class="nx-vector-glow"></span>
                        </button>
                        <button type="button" class="nx-vector-slot nx-active" id="nxVectorCache" data-vector="cachedResults" title="Cached API Results">
                            <span class="nx-vector-icon">🔮</span>
                            <span class="nx-vector-name">API Cache</span>
                            <span class="nx-vector-glow"></span>
                        </button>
                        <button type="button" class="nx-vector-slot nx-active" id="nxVectorBookmarks" data-vector="bookmarks" title="Local Bookmarks">
                            <span class="nx-vector-icon">🔖</span>
                            <span class="nx-vector-name">Bookmarks</span>
                            <span class="nx-vector-glow"></span>
                        </button>
                    </div>
                </div>

                <!-- Google CSE Config (Collapsible) -->
                <details class="nx-section nx-details" id="nxGoogleConfig">
                    <summary class="nx-section-label nx-section-toggle">🗝 GOOGLE CSE CONFIG</summary>
                    <div class="nx-detail-body">
                        <label class="nx-field">
                            <span>API Key</span>
                            <input type="password" id="esApiKey" class="nx-input" placeholder="Google API key">
                        </label>
                        <label class="nx-field">
                            <span>Search Engine ID (CX)</span>
                            <input type="text" id="esCx" class="nx-input" placeholder="Programmable Search Engine ID">
                        </label>
                    </div>
                </details>

                <!-- Advanced Filters (Collapsible) -->
                <details class="nx-section nx-details" id="nxFiltersConfig">
                    <summary class="nx-section-label nx-section-toggle">⚙ ADVANCED FILTERS</summary>
                    <div class="nx-detail-body nx-filter-grid">
                        <label class="nx-field">
                            <span>Sort</span>
                            <select id="esSort" class="nx-input">
                                <option value="">Relevance</option>
                                <option value="date">Date</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>Site Restrict</span>
                            <input type="text" id="esSite" class="nx-input" placeholder="example.com">
                        </label>
                        <label class="nx-field">
                            <span>Language</span>
                            <select id="esLanguage" class="nx-input">
                                <option value="">Any</option>
                                <option value="lang_en">English</option>
                                <option value="lang_es">Spanish</option>
                                <option value="lang_fr">French</option>
                                <option value="lang_de">German</option>
                                <option value="lang_ja">Japanese</option>
                                <option value="lang_ko">Korean</option>
                                <option value="lang_zh-CN">Chinese (Simplified)</option>
                                <option value="lang_zh-TW">Chinese (Traditional)</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>Country</span>
                            <select id="esCountry" class="nx-input">
                                <option value="">Any</option>
                                <option value="countryUS">United States</option>
                                <option value="countryCA">Canada</option>
                                <option value="countryGB">United Kingdom</option>
                                <option value="countryAU">Australia</option>
                                <option value="countryDE">Germany</option>
                                <option value="countryFR">France</option>
                                <option value="countryJP">Japan</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>File Type</span>
                            <select id="esFileType" class="nx-input">
                                <option value="">Any</option>
                                <option value="pdf">PDF</option>
                                <option value="doc">DOC</option>
                                <option value="docx">DOCX</option>
                                <option value="xls">XLS</option>
                                <option value="ppt">PPT</option>
                                <option value="txt">TXT</option>
                                <option value="jpg">JPG</option>
                                <option value="png">PNG</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>Date Range</span>
                            <select id="esDateRestrict" class="nx-input">
                                <option value="">Any Time</option>
                                <option value="d[1]">Past 24 hours</option>
                                <option value="w[1]">Past week</option>
                                <option value="m[1]">Past month</option>
                                <option value="m[6]">Past 6 months</option>
                                <option value="y[1]">Past year</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>SafeSearch</span>
                            <select id="esSafe" class="nx-input">
                                <option value="">Default</option>
                                <option value="active">Strict</option>
                                <option value="off">Off</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>Usage Rights</span>
                            <select id="esRights" class="nx-input">
                                <option value="">Any</option>
                                <option value="cc_publicdomain">Public Domain</option>
                                <option value="cc_attribute">Attribution</option>
                                <option value="cc_sharealike">Share Alike</option>
                                <option value="cc_noncommercial">Non-Commercial</option>
                                <option value="cc_nonderived">No Derivatives</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>Results Per Page</span>
                            <select id="esNum" class="nx-input">
                                <option value="10">10 (Max)</option>
                                <option value="5">5</option>
                                <option value="3">3</option>
                                <option value="1">1</option>
                            </select>
                        </label>
                        <label class="nx-field">
                            <span>Exact Phrase</span>
                            <input type="text" id="esExactTerms" class="nx-input" placeholder="Exact phrase">
                        </label>
                        <label class="nx-field">
                            <span>Exclude Words</span>
                            <input type="text" id="esExcludeTerms" class="nx-input" placeholder="Words to exclude">
                        </label>
                    </div>
                </details>

                <!-- Action Buttons -->
                <div class="nx-actions" id="nxActionSection">
                    <button class="nx-btn nx-btn-primary" id="esRunBtn">⚔ Search</button>
                    <button class="nx-btn nx-btn-secondary" id="esClearBtn">↺ Clear</button>
                    <button type="button" class="nx-btn nx-btn-secondary" id="nxDatapackViewBtn" title="Open scoped datapack macro state">View State</button>
                </div>

                <!-- Debug Diagnostics (Collapsible) -->
                <details class="nx-section nx-details" id="nxDebugSection">
                    <summary class="nx-section-label nx-section-toggle">🔧 DEBUG DIAGNOSTICS</summary>
                    <div class="nx-detail-body" id="nxDebugContainer">
                        <div class="nx-debug-placeholder" style="padding:12px; text-align:center; color:rgba(128,128,128,0.6); font-size:0.78rem;">Click to load diagnostics...</div>
                    </div>
                </details>
            </div>

            <!-- Right Column: Results -->
            <div class="nx-results-panel">
                <div class="nx-results-header" id="nxResultsHeader">
                    <span class="nx-results-title">RESULTS</span>
                    <span class="nx-scope-indicator" id="esScopeIndicator" style="display:none"></span>
                    <div class="nx-results-mode nx-scope-mode" id="nxScopeModeToggle" role="group" aria-label="Search scope mode">
                        <button type="button" class="nx-mode-btn nx-mode-btn-active" data-scope-mode="current">Current</button>
                        <button type="button" class="nx-mode-btn" data-scope-mode="all">All Tabs</button>
                    </div>
                    <div class="nx-results-mode" id="nxResultsModeToggle" role="group" aria-label="Result display mode">
                        <button type="button" class="nx-mode-btn nx-mode-btn-active" data-results-mode="segmented">Segmented</button>
                        <button type="button" class="nx-mode-btn" data-results-mode="merged">Merged</button>
                    </div>
                    <div class="nx-inline-search" id="nxInlineSearch">
                        <input type="text" id="nxInlineQuery" class="nx-inline-query" placeholder="Search...">
                        <button type="button" class="nx-inline-search-btn" id="nxInlineSearchBtn">⚔</button>
                    </div>
                    <span class="nx-results-meta" id="esMeta">Activate vectors and search.</span>
                </div>
                <div class="nx-results-body" id="esResults" tabindex="-1"></div>
            </div>
        </div>

        <!-- Orphan Alert Banner (hidden by default) -->
        <div class="nx-orphan-banner" id="nxOrphanBanner" style="display:none">
            <div class="nx-orphan-info">
                <span class="nx-orphan-icon">⚠</span>
                <span class="nx-orphan-text" id="nxOrphanText">0 orphaned bookmarks from deleted workspaces</span>
            </div>
            <div class="nx-orphan-actions">
                <button class="nx-orphan-btn nx-orphan-view" id="nxOrphanViewBtn" title="View orphaned bookmarks">View</button>
                <button class="nx-orphan-btn nx-orphan-rescue" id="nxOrphanRescueBtn" title="Move orphans to active workspace">Rescue</button>
                <button class="nx-orphan-btn nx-orphan-dismiss" id="nxOrphanDismissBtn" title="Dismiss">✕</button>
            </div>
        </div>

        <!-- Footer Stat Bar -->
        <div class="nx-footer" id="nxFooterStats">
            <div class="nx-stat"><span class="nx-stat-label">Entries</span><span class="nx-stat-value" id="nxStatEntries">—</span></div>
            <div class="nx-stat"><span class="nx-stat-label">Providers</span><span class="nx-stat-value" id="nxStatProviders">—</span></div>
            <div class="nx-stat"><span class="nx-stat-label">Cards</span><span class="nx-stat-value" id="nxStatCards">—</span></div>
            <div class="nx-stat"><span class="nx-stat-label">Vectors</span><span class="nx-stat-value" id="nxStatVectors">—</span></div>
        </div>
    </div>
</div>`;
    };
})();
