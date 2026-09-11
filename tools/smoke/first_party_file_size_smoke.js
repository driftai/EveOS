const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAX_LINES = 450;
const CODE_EXTENSIONS = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.css',
    '.html',
    '.py',
    '.ps1',
    '.bat'
]);
const EXCLUDED_DIRECTORIES = new Set([
    '.git',
    '.venv',
    'venv',
    'env',
    '.youtube-piano-venv',
    '.piano-hifi-venv',
    'bin',
    'build',
    'coverage',
    'data',
    'dist',
    'node_modules',
    'output',
    'playwright-report',
    'test-results',
    'third-party',
    'third_party',
    'vendor'
]);
const EXCLUDED_PATH_PREFIXES = [
    // World Portal bundles the independently maintained GPL Orogen application.
    'tools/World-Book/tools/World-Portal/outer/orogen/',
    // WatchFusion bundles the independently maintained VoxelVision engine.
    'tools/WatchFusion/voxelvision/',
    // WatchFusion downloads the external Nuvio smart TV client on demand.
    'tools/WatchFusion/nuvio/'
];

function countPhysicalLines(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (!source) return 0;
    return source.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function isExcludedPath(filePath) {
    const normalized = path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
    return EXCLUDED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function collectCodeFiles(directory, files = []) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        const filePath = path.join(directory, entry.name);
        if (isExcludedPath(filePath)) return;
        if (entry.isDirectory()) {
            const name = entry.name.toLowerCase();
            if (!EXCLUDED_DIRECTORIES.has(name) && !name.endsWith('-venv') && !name.includes('venv')) {
                collectCodeFiles(filePath, files);
            }
            return;
        }
        if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            files.push(filePath);
        }
    });
    return files;
}

const measured = collectCodeFiles(REPO_ROOT)
    .map((filePath) => ({
        filePath,
        relativePath: path.relative(REPO_ROOT, filePath),
        lines: countPhysicalLines(filePath)
    }))
    .sort((left, right) => right.lines - left.lines);
const oversized = measured.filter((entry) => entry.lines > MAX_LINES);

if (oversized.length) {
    const details = oversized
        .map((entry) => `${entry.lines} ${entry.relativePath}`)
        .join('\n');
    throw new Error(`First-party code files exceed ${MAX_LINES} lines:\n${details}`);
}

console.log('FIRST_PARTY_FILE_SIZE_SMOKE_OK', JSON.stringify({
    maxLines: MAX_LINES,
    measuredFiles: measured.length,
    largest: measured[0] || null
}));
