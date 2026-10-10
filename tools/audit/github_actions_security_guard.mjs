#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const runGit = args => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });

function stripYamlComment(value) {
    let single = false;
    let double = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === "'" && !double) single = !single;
        else if (char === '"' && !single && value[index - 1] !== '\\') double = !double;
        else if (char === '#' && !single && !double && (index === 0 || /\s/.test(value[index - 1]))) {
            return value.slice(0, index).trimEnd();
        }
    }
    return value.trimEnd();
}

function unquote(value) {
    const trimmed = stripYamlComment(String(value || '')).trim();
    if (trimmed.length >= 2) {
        const quote = trimmed[0];
        if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function parseKeyValue(line) {
    const clean = stripYamlComment(line);
    const match = clean.match(/^(\s*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(.*?)\s*$/);
    if (!match) return null;
    return {
        indent: match[1].length,
        key: match[2] || match[3] || match[4],
        value: match[5] || ''
    };
}

function blockAfter(lines, index, indent) {
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const raw = lines[cursor];
        const clean = stripYamlComment(raw);
        if (!clean.trim()) {
            block.push(raw);
            continue;
        }
        const childIndent = raw.match(/^\s*/)?.[0].length ?? 0;
        if (childIndent <= indent) break;
        block.push(raw);
    }
    return block;
}

function directChildren(lines, index, indent) {
    const children = [];
    let childIndent = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const raw = lines[cursor];
        const clean = stripYamlComment(raw);
        if (!clean.trim()) continue;
        const currentIndent = raw.match(/^\s*/)?.[0].length ?? 0;
        if (currentIndent <= indent) break;
        const pair = parseKeyValue(raw);
        if (!pair) continue;
        if (childIndent === null) childIndent = pair.indent;
        if (pair.indent === childIndent) children.push({ index: cursor, pair });
    }
    return children;
}

function flowMapEntries(value) {
    const text = unquote(value);
    if (!text.startsWith('{') || !text.endsWith('}')) return [];
    const body = text.slice(1, -1);
    const entries = [];
    const pattern = /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))/g;
    let match;
    while ((match = pattern.exec(body))) {
        entries.push({
            key: match[1] || match[2] || match[3],
            value: unquote(match[4] ?? match[5] ?? match[6] ?? '')
        });
    }
    return entries;
}

function scalarContainsToken(value, token) {
    const normalized = unquote(value)
        .replace(/[\[\]{},]/g, ' ')
        .replace(/["']/g, ' ')
        .toLowerCase();
    return normalized.split(/\s+/).filter(Boolean).includes(token.toLowerCase());
}

function hasPullRequestTargetEvent(lines) {
    for (let index = 0; index < lines.length; index += 1) {
        const pair = parseKeyValue(lines[index]);
        if (!pair || pair.indent !== 0 || pair.key.toLowerCase() !== 'on') continue;
        if (pair.value) {
            if (pair.value.trim().startsWith('*')) return true;
            if (flowMapEntries(pair.value).some((entry) => entry.key.toLowerCase() === 'pull_request_target')) return true;
            return scalarContainsToken(pair.value, 'pull_request_target');
        }
        for (const raw of blockAfter(lines, index, pair.indent)) {
            const clean = stripYamlComment(raw).trim();
            if (!clean) continue;
            const child = parseKeyValue(raw);
            if (child?.key?.toLowerCase() === 'pull_request_target') return true;
            const seq = clean.match(/^-\s*(.+?)\s*$/);
            if (seq && scalarContainsToken(seq[1], 'pull_request_target')) return true;
        }
    }
    return false;
}

function inspectPermissionDeclaration(lines, index, pair, file, failures) {
    let hasContentsRead = false;
    const inspectEntry = (key, rawValue, lineNumber) => {
        const value = unquote(rawValue).toLowerCase();
        if (value === 'write') failures.push(`${file}:${lineNumber}: write permission is forbidden by the repository automation baseline`);
        if (String(key).toLowerCase() === 'contents' && value === 'read') hasContentsRead = true;
    };

    const direct = unquote(pair.value).toLowerCase();
    if (direct === 'write-all') {
        failures.push(`${file}:${index + 1}: permissions: write-all is forbidden`);
        return { hasContentsRead: false };
    }
    if (direct === 'read-all') return { hasContentsRead: true };

    if (pair.value) {
        for (const entry of flowMapEntries(pair.value)) inspectEntry(entry.key, entry.value, index + 1);
        return { hasContentsRead };
    }

    for (const child of directChildren(lines, index, pair.indent)) {
        inspectEntry(child.pair.key, child.pair.value, child.index + 1);
    }
    return { hasContentsRead };
}

function inspectPermissions(lines, file, failures) {
    let rootPermission = null;
    let jobsEntry = null;

    for (let index = 0; index < lines.length; index += 1) {
        const pair = parseKeyValue(lines[index]);
        if (!pair || pair.indent !== 0) continue;
        const key = pair.key.toLowerCase();
        if (key === 'permissions' && rootPermission === null) {
            rootPermission = {
                index,
                state: inspectPermissionDeclaration(lines, index, pair, file, failures)
            };
        } else if (key === 'jobs' && jobsEntry === null) {
            jobsEntry = { index, pair };
        }
    }

    const rootHasContentsRead = rootPermission?.state.hasContentsRead === true;
    const jobs = jobsEntry ? directChildren(lines, jobsEntry.index, jobsEntry.pair.indent) : [];

    if (!jobs.length) {
        if (!rootHasContentsRead) failures.push(`${file}: an explicit contents: read permission baseline is required`);
        return;
    }

    for (const job of jobs) {
        const jobName = job.pair.key;
        const children = directChildren(lines, job.index, job.pair.indent);
        const jobPermission = children.find((child) => child.pair.key.toLowerCase() === 'permissions');
        let effectiveContentsRead = rootHasContentsRead;

        if (jobPermission) {
            const state = inspectPermissionDeclaration(lines, jobPermission.index, jobPermission.pair, file, failures);
            effectiveContentsRead = state.hasContentsRead;
        }

        if (!effectiveContentsRead) {
            failures.push(`${file}: job ${jobName} requires effective contents: read permission (declare it on the job or inherit it from workflow permissions)`);
        }
    }
}

function stripComment(value) {
    const quote = value.match(/^(["'])(.*)\1\s*(?:#.*)?$/);
    if (quote) return quote[2].trim();
    return value.replace(/\s+#.*$/, '').trim();
}

function checkoutCredentialGuard(lines, index, file, failures) {
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
    if (!/^\s*(?:"persist-credentials"|'persist-credentials'|persist-credentials)\s*:\s*(?:"false"|'false'|false)\s*(?:#.*)?$/mi.test(block)) {
        failures.push(`${file}: actions/checkout must set persist-credentials: false`);
    }
}

export function analyzeWorkflowSource(source, file = 'workflow.yml') {
    const failures = [];
    const lines = String(source || '').split(/\r?\n/);
    const actionPin = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/i;
    const dockerPin = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/i;

    if (hasPullRequestTargetEvent(lines) && !source.includes('eveos-security-reviewed: pull_request_target')) {
        failures.push(`${file}: pull_request_target requires an explicit EveOS security review marker`);
    }
    inspectPermissions(lines, file, failures);

    for (const [index, line] of lines.entries()) {
        const match = line.match(/^\s*(?:-\s*)?(?:"uses"|'uses'|uses)\s*:\s*(.+?)\s*$/i);
        if (!match) continue;
        const target = stripComment(match[1]);
        if (target.startsWith('./')) continue;
        if (target.startsWith('docker://')) {
            if (!dockerPin.test(target)) failures.push(`${file}:${index + 1}: Docker action must be sha256 pinned: ${target}`);
            continue;
        }
        if (!actionPin.test(target)) failures.push(`${file}:${index + 1}: action must be pinned to a 40-hex commit SHA: ${target}`);
        if (/^actions\/checkout@/i.test(target)) checkoutCredentialGuard(lines, index, file, failures);
    }

    if (file.endsWith('repository-guardrails.yml') && /\bsecrets\./i.test(source)) {
        failures.push(`${file}: repository guardrails must not consume repository secrets`);
    }
    if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:bash|sh|pwsh|powershell)\b/i.test(source)) {
        failures.push(`${file}: pipe-to-shell network execution is forbidden`);
    }
    return [...new Set(failures)];
}

function main() {
    const failures = [];
    const warnings = [];
    const workflows = runGit(['ls-files', '.github/workflows/*.yml', '.github/workflows/*.yaml'])
        .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!workflows.length) failures.push('no tracked GitHub Actions workflows found');

    for (const file of workflows) {
        const source = fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8');
        failures.push(...analyzeWorkflowSource(source, file));
    }

    if (failures.length) {
        console.error('GITHUB_ACTIONS_SECURITY_FAILED');
        for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
        for (const warning of [...new Set(warnings)]) console.warn(`WARN ${warning}`);
        return 1;
    }
    for (const warning of [...new Set(warnings)]) console.warn(`WARN ${warning}`);
    console.log(`GITHUB_ACTIONS_SECURITY_OK workflows=${workflows.length} pinnedActions=true readOnly=true checkoutCredentials=false`);
    return 0;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) process.exit(main());
