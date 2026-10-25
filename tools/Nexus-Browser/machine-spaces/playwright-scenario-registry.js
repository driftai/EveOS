'use strict';

// Version 1: qualification-only, fixed-source browser proof registry.
// Never interpret provider text as a script, URL, selector or command.
const entries = {
  'agent-nexus-browser': {
    surface: 'Agent Nexus',
    runner: 'tools/smoke/agent_nexus_browser_smoke.js',
    dependencies: [
      'tools/smoke/browser-smoke-diagnostics.shared.js',
      'tools/smoke/agent_nexus_browser_acceptance.shared.js'
    ]
  },
  'notes-worldbook-ui': {
    surface: 'Notes / World Book',
    runner: 'tools/smoke/notes_worldbook_browser_smoke.js',
    dependencies: ['tools/smoke/playwright-browser.js']
  },
  'audioflix-queue-ui': {
    surface: 'AudioFlix',
    runner: 'tools/smoke/audioflix_queue_view_smoke.js',
    dependencies: ['tools/smoke/helpers/audioflix_nexus_pointer.shared.js']
  },
  'bookmark-intel-ui': {
    surface: 'Bookmarks / INSITE',
    runner: 'tools/smoke/bookmark_intel_browser_smoke.js',
    dependencies: []
  }
};

const SCENARIOS = Object.freeze(Object.fromEntries(Object.entries(entries).map(([id, value]) => [
  id, Object.freeze({
    id, surface: value.surface, mode: 'qualification',
    runner: value.runner,
    command: `node ${value.runner}`,
    dependencies: Object.freeze([...value.dependencies])
  })
])));

function publicScenarios() {
  return Object.values(SCENARIOS).map(({ id, surface, mode }) => ({ id, surface, mode }));
}

module.exports = { SCENARIOS, publicScenarios };
