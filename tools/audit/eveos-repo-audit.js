#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX_LINES = 450;
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.py', '.bat', '.ps1']);
const SKIP_DIRS = new Set([
    '.git', '.claude', '__pycache__', 'bin', 'logs', 'node_modules', 'output',
    '.venv', 'venv', 'env', '.env', '.youtube-piano-venv', '.piano-hifi-venv'
]);
const SKIP_PREFIXES = [
    path.join('data', 'modular-state'),
    path.join('data', 'modular-packs'),
    path.join('tools', 'camofox-runtime', 'node_modules'),
    path.join('tools', 'WatchFusion', 'nuvio')
];
const LINE_LIMIT_EXEMPT_PREFIXES = [
    'tools/World-Book/tools/World-Portal/outer/orogen/',
    'tools/WatchFusion/voxelvision/',
    'tools/WatchFusion/nuvio/'
];
const RUNTIME_SOURCE_PREFIXES = ['js/', 'css/', 'server/', 'server_modules/'];
const MOJIBAKE_MARKERS = [
    '\u00c2\u00b7',
    '\u00c3\u00a2',
    '\u00c3\u00d7',
    '\u00e2\u20ac',
    '\u00e2\u2020',
    '\u00e2\u2013',
    '\u00e2\u2014',
    '\u00e2\u0161',
    '\u00e2\u017e',
    '\u00e2\u201d',
    '\u00f0\u0178',
    '\ufffd'
];

function relative(filePath) {
    return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function shouldSkip(relativePath, dirName = '') {
    if (SKIP_DIRS.has(dirName) || dirName.endsWith('-venv') || dirName.includes('venv')) return true;
    const platformPath = relativePath.replace(/\//g, path.sep);
    return SKIP_PREFIXES.some((prefix) => (
        platformPath === prefix || platformPath.startsWith(`${prefix}${path.sep}`)
    ));
}

function walk(directory, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const rel = relative(absolute);
        if (shouldSkip(rel, entry.name)) continue;
        if (entry.isDirectory()) walk(absolute, files);
        else files.push(absolute);
    }
    return files;
}

function read(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function lineCount(source) {
    if (!source) return 0;
    return source.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function stripQuery(assetPath) {
    return String(assetPath || '').split(/[?#]/, 1)[0].replace(/^\/+/, '');
}

function evaluateManifest() {
    const context = vm.createContext({ window: {} });
    const partDir = path.join(ROOT, 'js', 'config', 'manifest', 'scripts.parts');
    const parts = fs.readdirSync(partDir)
        .filter((name) => name.endsWith('.js'))
        .sort((a, b) => a.localeCompare(b));

    for (const name of parts) {
        const filePath = path.join(partDir, name);
        new vm.Script(read(filePath), { filename: relative(filePath) }).runInContext(context);
    }

    for (const filePath of [
        path.join(ROOT, 'js', 'config', 'manifest', 'scripts.js'),
        path.join(ROOT, 'js', 'config', 'manifest', 'styles.js'),
        path.join(ROOT, 'js', 'config', 'manifest.js')
    ]) {
        new vm.Script(read(filePath), { filename: relative(filePath) }).runInContext(context);
    }

    return context.window.EveModuleManifest || { scripts: [], styles: [] };
}

function collectHtmlAssets() {
    const htmlPath = path.join(ROOT, 'EveOS.html');
    const html = read(htmlPath);
    const assets = [];
    const pattern = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi;
    let match;
    while ((match = pattern.exec(html))) assets.push(match[1]);
    return assets.filter((asset) => !/^(?:https?:|data:|blob:|#)/i.test(asset));
}

function findDuplicateAssets(assets) {
    const seen = new Map();
    const duplicates = [];
    for (const asset of assets) {
        const key = stripQuery(asset).toLowerCase();
        if (!key) continue;
        if (seen.has(key)) duplicates.push([asset, seen.get(key)]);
        else seen.set(key, asset);
    }
    return duplicates;
}

function inspectJavaScriptSyntax(sourceFiles, failures) {
    for (const filePath of sourceFiles) {
        const extension = path.extname(filePath).toLowerCase();
        if (!['.js', '.mjs', '.cjs'].includes(extension)) continue;
        try {
            esbuild.transformSync(read(filePath), {
                format: extension === '.cjs' ? 'cjs' : 'esm',
                loader: 'js',
                sourcefile: relative(filePath),
                target: 'esnext'
            });
        } catch (error) {
            const detail = error.errors?.[0]?.text || error.message;
            failures.push('javascript-syntax: ' + relative(filePath) + ': ' + detail);
        }
    }
}

function inspectLauncherContracts(failures) {
    const contracts = [
        ['start-server.bat', [
            'call "%BAT_DIR%\\eveos-ports.bat"',
            'call "%START_SERVER_PATHS_BAT%" :ResolveMainDataPackPath',
            'call "%START_SERVER_BROWSER_BAT%" :RefreshBrowserFallbackStatus'
        ]],
        ['tools/batch/eveos-ports.bat', [
            'EVEOS_WEB_PORT',
            'GEMINI_WS_PORT',
            'GEMINI_STATUS_PORT',
            'GEMINI_CONTROL_PORT'
        ]],
        ['tools/batch/start-server.paths.bat', [':ResolveMainDataPackPath', ':NormalizePortInput']],
        ['tools/batch/start-server.browser.bat', [':RefreshBrowserFallbackStatus', ':EnsureLightpandaMonitor']],
        ['tools/batch/start-server.browse.bat', [':LaunchBatch', ':BrowseProjectBatchFiles']],
        ['tools/batch/start-server.instance.bat', [':LaunchEveInstance', ':LaunchEvePortOnly']],
        ['tools/batch/start-server.stack.bat', [':BootStandardStack', ':EnsureBridge', ':PortInUse']]
    ];

    for (const [relativePath, markers] of contracts) {
        const filePath = path.join(ROOT, relativePath);
        if (!fs.existsSync(filePath)) {
            failures.push('launcher-contract missing-file: ' + relativePath);
            continue;
        }
        const source = read(filePath);
        for (const marker of markers) {
            if (!source.includes(marker)) {
                failures.push('launcher-contract missing-marker: ' + relativePath + ': ' + marker);
            }
        }
    }
}

function inspectRuntimeEncoding(sourceFiles, failures) {
    for (const filePath of sourceFiles) {
        const rel = relative(filePath);
        if (!RUNTIME_SOURCE_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
        const source = read(filePath);
        const marker = MOJIBAKE_MARKERS.find((candidate) => source.includes(candidate));
        if (marker) failures.push(`mojibake: ${rel}`);
    }
}

function inspectPackageScripts(failures) {
    const packagePath = path.join(ROOT, 'package.json');
    const source = read(packagePath);
    const scriptsMatch = source.match(/"scripts"\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (!scriptsMatch) {
        failures.push('package-scripts: scripts object not found');
        return;
    }

    const seen = new Set();
    for (const match of scriptsMatch[1].matchAll(/^\s*"([^"]+)"\s*:/gm)) {
        const key = match[1];
        if (seen.has(key)) failures.push(`duplicate-package-script: ${key}`);
        seen.add(key);
    }
}

function main() {
    const allFiles = walk(ROOT);
    const sourceFiles = allFiles.filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
    const failures = [];
    const warnings = [];

    for (const filePath of sourceFiles) {
        const rel = relative(filePath);
        if (LINE_LIMIT_EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
        const count = lineCount(read(filePath));
        if (count > MAX_LINES) failures.push(`line-limit ${count}: ${relative(filePath)}`);
    }

    inspectJavaScriptSyntax(sourceFiles, failures);
    inspectLauncherContracts(failures);
    inspectRuntimeEncoding(sourceFiles, failures);
    inspectPackageScripts(failures);

    let manifest = { scripts: [], styles: [] };
    try {
        manifest = evaluateManifest();
    } catch (error) {
        failures.push(`manifest-evaluation: ${error.message}`);
    }

    const manifestAssets = [...(manifest.scripts || []), ...(manifest.styles || [])];
    const htmlAssets = collectHtmlAssets();
    for (const asset of [...manifestAssets, ...htmlAssets]) {
        const localPath = stripQuery(asset);
        if (!localPath || /^(?:https?:|data:|blob:|#)/i.test(localPath)) continue;
        if (!fs.existsSync(path.join(ROOT, localPath))) failures.push(`missing-asset: ${asset}`);
    }

    for (const [duplicate, original] of findDuplicateAssets(manifestAssets)) {
        failures.push(`duplicate-manifest-asset: ${duplicate} (first: ${original})`);
    }

    const machinePathPattern = /[A-Za-z]:\\Users\\[^\\\r\n]+/g;
    for (const filePath of sourceFiles) {
        const rel = relative(filePath);
        if (rel.startsWith('tools/legacy/')) continue;
        const matches = read(filePath).match(machinePathPattern);
        if (matches) warnings.push(`machine-path: ${rel}: ${matches[0]}`);
    }

    const rootRuntimeArtifacts = ['chat_history.json', 'out.txt', 'server.log', 'server_err.log'];
    for (const name of rootRuntimeArtifacts) {
        if (fs.existsSync(path.join(ROOT, name))) warnings.push(`root-runtime-artifact: ${name}`);
    }

    const nativeDialogPattern = /(?:window\.)?(?:prompt|confirm|alert)\s*\(/g;
    const dialogInfrastructure = new Set([
        'js/modules/gemini/agentic/self_talk/ai_self_talk_features/ai_self_talk_core/selfTalkState.js',
        'js/modules/ui/inline-prompt.js',
        'js/modules/ui/notifications/dialogs.js'
    ]);
    for (const filePath of sourceFiles) {
        const rel = relative(filePath);
        if (!rel.startsWith('js/')
            || rel.startsWith('js/modules/features/scraper/')
            || dialogInfrastructure.has(rel)) continue;
        const matches = read(filePath).match(nativeDialogPattern);
        if (matches) warnings.push('native-dialog ' + matches.length + ': ' + rel);
    }
    // Hardcoded-secret guard: any real credential in source is a FAILURE. Keys belong in the
    // user's Settings (config.expandedSearch) and are resolved at runtime — never committed.
    const secretPatterns = [
        { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ },
        { name: 'google-oauth-id', re: /[0-9]+-[0-9a-z]{32}\.apps\.googleusercontent\.com/ },
        { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
        { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
        { name: 'generic-bearer-secret', re: /(?:secret|token|passwd|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i }
    ];
    const secretScanExtensions = new Set(['.js', '.py', '.html', '.json', '.bat', '.ps1', '.css', '.md']);
    for (const filePath of allFiles) {
        if (!secretScanExtensions.has(path.extname(filePath).toLowerCase())) continue;
        const rel = relative(filePath);
        // The audit tool itself defines these patterns as strings; don't self-flag.
        if (rel === 'tools/audit/eveos-repo-audit.js') continue;
        const contents = read(filePath);
        for (const { name, re } of secretPatterns) {
            if (re.test(contents)) failures.push(`hardcoded-secret ${name}: ${rel}`);
        }
    }

    const summary = {
        sourceFiles: sourceFiles.length,
        manifestScripts: (manifest.scripts || []).length,
        manifestStyles: (manifest.styles || []).length,
        failures: failures.length,
        warnings: warnings.length
    };

    console.log('EveOS repository audit');
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) {
        console.log('\nFailures:');
        failures.forEach((message) => console.log(`- ${message}`));
    }
    if (warnings.length) {
        console.log('\nWarnings:');
        warnings.forEach((message) => console.log(`- ${message}`));
    }
    process.exitCode = failures.length ? 1 : 0;
}

main();
