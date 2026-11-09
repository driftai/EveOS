import fs from 'node:fs';
import path from 'node:path';

export const EDGE_BETA_WINGET_ID = 'Microsoft.Edge.Beta';
export const EDGE_BETA_PAGE = 'https://www.microsoft.com/en-us/edge/download/insider';

export function edgeBetaCandidates(env = process.env, platform = process.platform) {
    if (platform !== 'win32') return [];
    const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA];
    return [...new Set(roots.filter(Boolean).map(root =>
        path.join(root, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe')))];
}

export function detectEdgeBeta({ env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}) {
    const candidates = edgeBetaCandidates(env, platform);
    const found = candidates.find(candidate => existsSync(candidate));
    return {
        installed: Boolean(found),
        executable: found || null,
        supportedPlatform: platform === 'win32',
        searchedCandidates: candidates.length
    };
}

export function firstRunSummary({ platform = process.platform, edgeBeta, wingetAvailable = false }) {
    const windows = platform === 'win32';
    return {
        schemaVersion: 1,
        operatingSystem: platform,
        baseEveOS: 'independent-of-edge-beta',
        spotifyDirect: windows ? (edgeBeta.installed ? 'available-browser-present' : 'needs-edge-beta') : 'windows-only',
        edgeBetaInstalled: !!edgeBeta.installed,
        edgeBetaExecutable: edgeBeta.executable || null,
        wingetAvailable: windows && !!wingetAvailable,
        edgeBetaInstaller: EDGE_BETA_WINGET_ID,
        edgeBetaOfficialDownload: EDGE_BETA_PAGE,
        automaticInstallPerformed: false
    };
}

export function installationArguments() {
    return ['install', '--id', EDGE_BETA_WINGET_ID, '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements'];
}
