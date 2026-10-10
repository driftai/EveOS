#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePython } = require('../setup/python_runtime.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function run(command, args, label) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe'
    });

    if (result.status === 0) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        return;
    }

    const stdout = String(result.stdout || '').trim();
    const stderr = String(result.stderr || '').trim();
    const details = [stdout, stderr].filter(Boolean).join('\n');
    throw new Error(`${label} failed with exit code ${result.status}${details ? `\n${details}` : ''}`);
}

const nodeContracts = [
    'tests/audioflix_library_mutation_observer_contract.test.js',
    'tests/gemini_agentic_dialog_portal_hotloop_contract.test.js',
    'tests/gemini_agentic_loader_preload_contract.test.js',
    'tests/gemini_section_collapse_hotloop_contract.test.js',
    'tests/gemini_server_inspector_hotloop_contract.test.js',
    'tests/search_monitor_scroll_preserve_hotloop_contract.test.js',
    'tests/watchfusion_frame_capabilities_hotloop_contract.test.js',
    'tests/world_book_narration_agentic_hotloop_contract.test.js',
    'tests/world_book_narration_slot_resilience_contract.test.js',
    'tests/world_book_status_probe_coalescing_contract.test.js'
];

const pythonContracts = [
    'tests/test_gemini_explicit_workspace_boot_contract.py',
    'tests/test_gemini_communication_preload_contract.py',
    'tests/test_gemini_external_dependency_preload_contract.py',
    'tests/test_gemini_svg_monitor_scope_contract.py',
    'tests/test_nexus_gemini_workspace_bridge_contract.py'
];

run(
    process.execPath,
    [path.join(ROOT, 'tools', 'smoke', 'renderer_watchdog_contract_smoke.js')],
    'renderer watchdog contract smoke'
);

run(
    process.execPath,
    ['--test', ...nodeContracts.map((relative) => path.join(ROOT, relative))],
    'recovered structural Node contracts'
);

run(
    resolvePython(ROOT),
    ['-m', 'pytest', ...pythonContracts, '-q'],
    'recovered structural Python contracts'
);

console.log('RECOVERED_STRUCTURAL_REGRESSION_SMOKE_OK');
