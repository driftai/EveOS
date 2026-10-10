'use strict';

const { execFileSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const numberList = values => [...new Set((values || []).map(Number).filter(value => Number.isInteger(value) && value > 0))];

function windowsPortPid(port) {
    if (!Number.isInteger(Number(port))) return 0;
    try {
        const script = `$p=(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if($p){$p}`;
        return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()) || 0;
    } catch { return 0; }
}

function posixPortPid(port) {
    if (!Number.isInteger(Number(port))) return 0;
    for (const [command, args] of [
        ['lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t']],
        ['fuser', [`${Number(port)}/tcp`]]
    ]) {
        try {
            const text = execFileSync(command, args, { encoding: 'utf8' });
            const pid = Number(String(text).match(/\d+/)?.[0]);
            if (pid) return pid;
        } catch {}
    }
    return 0;
}

function portPid(port) { return process.platform === 'win32' ? windowsPortPid(port) : posixPortPid(port); }

function windowsSnapshot(rootPids) {
    if (!rootPids.length) return [];
    try {
        const roots = rootPids.join(',');
        const script = [
            `$roots=@(${roots})`,
            '$rows=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize',
            '$keep=New-Object System.Collections.Generic.HashSet[int]',
            '$roots | ForEach-Object {[void]$keep.Add([int]$_)}',
            'do {$changed=$false; foreach($r in $rows){if($keep.Contains([int]$r.ParentProcessId)-and -not $keep.Contains([int]$r.ProcessId)){[void]$keep.Add([int]$r.ProcessId);$changed=$true}}} while($changed)',
            '$rows | Where-Object {$keep.Contains([int]$_.ProcessId)} | ConvertTo-Json -Compress'
        ].join(';');
        const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
        if (!raw) return [];
        const values = JSON.parse(raw);
        return (Array.isArray(values) ? values : [values]).map(row => ({
            pid: Number(row.ProcessId) || 0, ppid: Number(row.ParentProcessId) || 0,
            name: String(row.Name || ''), rssBytes: Number(row.WorkingSetSize) || 0
        }));
    } catch { return []; }
}

function posixSnapshot(rootPids) {
    try {
        const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' });
        const rows = raw.trim().split(/\r?\n/).map(line => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
            return match ? { pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, name: match[4] } : null;
        }).filter(Boolean);
        const keep = new Set(rootPids);
        let changed = true;
        while (changed) { changed = false; for (const row of rows) if (keep.has(row.ppid) && !keep.has(row.pid)) { keep.add(row.pid); changed = true; } }
        return rows.filter(row => keep.has(row.pid));
    } catch { return []; }
}

function createRuntimeSampler(options = {}) {
    const intervalMs = Math.max(1000, Number(options.intervalMs) || 5000);
    const maxSamples = Math.max(1, Number(options.maxSamples) || 220);
    const controllerRootPids = numberList(options.controllerRootPids);
    let backendPid = Number(options.backendPid) || portPid(Number(options.backendPort));
    let timer = null, label = '', samples = [], warnings = [];
    if (!backendPid && options.backendPort) warnings.push(`backend PID unavailable for port ${options.backendPort}`);

    const sample = () => {
        if (!backendPid && options.backendPort) backendPid = portPid(Number(options.backendPort));
        const roots = numberList([backendPid, ...controllerRootPids]);
        const processes = process.platform === 'win32' ? windowsSnapshot(roots) : posixSnapshot(roots);
        const rssBytes = processes.reduce((sum, row) => sum + (Number(row.rssBytes) || 0), 0);
        samples.push({ at: new Date().toISOString(), label, backendPid: backendPid || null,
            controllerRootPids, processCount: processes.length, rssBytes, processes });
        if (samples.length > maxSamples) samples.shift();
    };

    return {
        async start(nextLabel = 'runtime') {
            label = String(nextLabel || 'runtime'); sample();
            timer = setInterval(sample, intervalMs); timer.unref?.(); return this;
        },
        async stop() {
            if (timer) clearInterval(timer); timer = null; sample(); await sleep(0);
            return { backendPid: backendPid || null, controllerRootPids, samples, warnings };
        }
    };
}

module.exports = { createRuntimeSampler, portPid };
