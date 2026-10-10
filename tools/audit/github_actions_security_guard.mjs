#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const runGit = args => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const failures = [];
const warnings = [];

const workflows = runGit(['ls-files', '.github/workflows/*.yml', '.github/workflows/*.yaml'])
    .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
if (!workflows.length) failures.push('no tracked GitHub Actions workflows found');

const actionPin = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/i;
const dockerPin = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/i;

function stripComment(value) {
    const quote = value.match(/^(["'])(.*)\1\s*(?:#.*)?$/);
    if (quote) return quote[2].trim();
    return value.replace(/\s+#.*$/, '').trim();
}

function checkoutCredentialGuard(lines, index, file) {
    let start = index;
    const usesIndent = lines[index].match(/^\s*/)?.[0].length ?? 0;
    while (start > 0) {
        const line = lines[start - 1];
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        if (/^\s*-\s+(?:name|uses):/.test(line) && indent < usesIndent) break;
        if (indent < usesIndent - 2 && line.trim()) break;
        start -= 1;
    }
    let end = index + 1;
    while (end < lines.length) {
        const line = lines[end];
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        if (/^\s*-\s+(?:name|uses):/.test(line) && indent < usesIndent) break;
        if (indent < usesIndent - 2 && line.trim()) break;
        end += 1;
    }
    const block = lines.slice(start, end).join('\n');
    if (!/^\s*persist-credentials:\s*false\s*(?:#.*)?$/mi.test(block)) {
        failures.push(`${file}: actions/checkout must set persist-credentials: false`);
    }
}

for (const file of workflows) {
    const source = fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8');
    const lines = source.split(/\r?\n/);

    if (/^\s*pull_request_target\s*:/m.test(source)
        && !source.includes('eveos-security-reviewed: pull_request_target')) {
        failures.push(`${file}: pull_request_target requires an explicit EveOS security review marker`);
    }
    if (/^\s*permissions:\s*write-all\b/mi.test(source)) {
        failures.push(`${file}: permissions: write-all is forbidden`);
    }
    for (const [index, line] of lines.entries()) {
        if (/^\s*[A-Za-z0-9_-]+:\s*write\s*(?:#.*)?$/i.test(line)) {
            failures.push(`${file}:${index + 1}: write permission is forbidden by the repository automation baseline`);
        }
        const match = line.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/i);
        if (!match) continue;
        const target = stripComment(match[1]);
        if (target.startsWith('./')) continue;
        if (target.startsWith('docker://')) {
            if (!dockerPin.test(target)) failures.push(`${file}:${index + 1}: Docker action must be sha256 pinned: ${target}`);
            continue;
        }
        if (!actionPin.test(target)) failures.push(`${file}:${index + 1}: action must be pinned to a 40-hex commit SHA: ${target}`);
        if (/^actions\/checkout@/i.test(target)) checkoutCredentialGuard(lines, index, file);
    }

    if (!/^\s*contents:\s*read\s*(?:#.*)?$/mi.test(source)) {
        failures.push(`${file}: an explicit contents: read permission baseline is required`);
    }
    if (file.endsWith('repository-guardrails.yml') && /\bsecrets\./i.test(source)) {
        failures.push(`${file}: repository guardrails must not consume repository secrets`);
    }
    if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:bash|sh|pwsh|powershell)\b/i.test(source)) {
        failures.push(`${file}: pipe-to-shell network execution is forbidden`);
    }
}

if (failures.length) {
    console.error('GITHUB_ACTIONS_SECURITY_FAILED');
    for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
    for (const warning of [...new Set(warnings)]) console.warn(`WARN ${warning}`);
    process.exit(1);
}
for (const warning of [...new Set(warnings)]) console.warn(`WARN ${warning}`);
console.log(`GITHUB_ACTIONS_SECURITY_OK workflows=${workflows.length} pinnedActions=true readOnly=true checkoutCredentials=false`);
