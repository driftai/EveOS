'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

function createQuietChildSuite({ root, name, artifactDirectory }) {
    const verbose = process.argv.includes('--verbose');
    const results = [];
    const directory = path.resolve(root, artifactDirectory);

    function run(runtime, relative, extraArgs = []) {
        const command = runtime === 'python'
            ? (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'))
            : process.execPath;
        const started = process.hrtime.bigint();
        const result = spawnSync(command, [path.join(root, relative), ...extraArgs], {
            cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024
        });
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const record = {
            id: relative, runtime, seconds: Number(seconds.toFixed(3)),
            exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '',
            error: result.error ? String(result.error.stack || result.error) : ''
        };
        results.push(record);
        if (verbose && record.exitCode === 0) process.stdout.write(record.stdout);
        if (result.error || result.status !== 0) {
            writeReport(false);
            const lines = `${record.stdout}\n${record.stderr}\n${record.error}`.trim().split(/\r?\n/).slice(-40);
            throw new Error(`${relative} failed with exit ${result.status}\n${lines.join('\n')}`);
        }
        return record;
    }

    function writeReport(ok) {
        fs.mkdirSync(directory, { recursive: true });
        const report = {
            schema: 'eveos.quiet-child-suite.v1', name, ok,
            totalSeconds: Number(results.reduce((sum, item) => sum + item.seconds, 0).toFixed(3)),
            results: results.map(({ stdout, stderr, ...item }) => ({
                ...item, stdoutLines: stdout.split(/\r?\n/).filter(Boolean).length,
                stderrLines: stderr.split(/\r?\n/).filter(Boolean).length,
                ...(ok ? {} : { stdout, stderr })
            }))
        };
        fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify(report, null, 2));
        return report;
    }

    function finish(summary) {
        const report = writeReport(true);
        const slowest = [...report.results].sort((a, b) => b.seconds - a.seconds).slice(0, 3)
            .map(item => `${path.basename(item.id)}=${item.seconds.toFixed(2)}s`).join(',');
        console.log(`${summary} children=${results.length} childSeconds=${report.totalSeconds.toFixed(2)} slowest=${slowest}`);
        return report;
    }

    return { runNode: (relative, ...args) => run('node', relative, args),
        runPython: (relative, ...args) => run('python', relative, args), finish };
}

module.exports = { createQuietChildSuite };
