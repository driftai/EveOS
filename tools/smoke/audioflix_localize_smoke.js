/**
 * audioflix_localize_smoke.js
 *
 * Music-library localization orchestration (audioflix.localize.js) against the real state store,
 * with the native transport stubbed (no server / yt-dlp needed):
 *   1. Scope collection: library / folder / group / song select the right tracks.
 *   2. Candidates: only ONLINE tracks lacking a local file are localized.
 *   3. localizeScope tags each downloaded track with localPath while KEEPING its url (dual-source).
 *   4. Reimport "music port": scanning a folder re-attaches files to tracks by normalized title.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
function runScript(ctx, rel) { vm.runInNewContext(fs.readFileSync(path.join(root, rel), 'utf8'), ctx, { filename: rel }); }
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

function makeCtx(stored, nativeStub) {
    const stores = { eveAudioflixFallbackState: stored ? JSON.stringify(stored) : null };
    const ctx = {
        console, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, Promise, RegExp,
        queueMicrotask, setTimeout, clearTimeout,
        localStorage: {
            getItem: (k) => (k in stores ? stores[k] : null),
            setItem: (k, v) => { stores[k] = String(v); },
            removeItem: (k) => { delete stores[k]; }
        },
        config: {},
        window: { dispatchEvent() {}, addEventListener() {} },
        CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; }
    };
    ctx.window.window = ctx.window;
    ctx.window.localStorage = ctx.localStorage;
    ctx.window.CustomEvent = ctx.CustomEvent;
    ctx.window.setTimeout = setTimeout;
    ctx.window.clearTimeout = clearTimeout;
    ctx.window.EveAudioflixNative = nativeStub;
    return ctx;
}

function loadAll(ctx) {
    runScript(ctx, 'js/modules/features/audioflix/audioflix.paths.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.groups.tree.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.state.schema.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.state.groups.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.state.recovery.js')
    runScript(ctx, 'js/modules/features/audioflix/audioflix.state.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.nexus.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.classifiers.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.localize.audit.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.localize.port.js');
    runScript(ctx, 'js/modules/features/audioflix/audioflix.localize.js');
    return { S: ctx.window.EveAudioflixState, L: ctx.window.EveAudioflixLocalize, C: ctx.window.EveAudioflixClassifiers };
}

const SEED = {
    music: [
        { id: 'a', title: 'Night Drive', url: 'https://youtube.com/watch?v=1', folder: 'Chill' },
        { id: 'b', title: 'Local Song', url: 'C:/music/local.mp3', folder: 'Chill' },
        { id: 'c', title: 'Focus Flow', url: 'https://youtube.com/watch?v=2', folder: 'Focus' }
    ],
    musicGroups: ['G'],
    musicGroupMap: { a: ['G'] }
};

function stub() {
    const downloaded = [];
    return {
        downloaded,
        localizeTrack: async (track, dir) => { downloaded.push(track.id); return { ok: true, id: track.id, filePath: `${dir}/${track.title}.mp3`, ext: 'mp3', mp3: true }; },
        scanLocalized: async (dir) => ({ ok: true, dir, files: [{ name: 'Night Drive', fileName: 'Night Drive.mp3', path: `${dir}/Night Drive.mp3`, ext: 'mp3' }] })
    };
}

(async function main() {
    // --- 1 + 2. Scope collection + candidates ---
    {
        const { L } = loadAll(makeCtx(SEED, stub()));
        assert(L.collectScope('library').length === 3, 'library scope = all 3');
        assert(L.collectScope('folder', 'Chill').map(i => i.id).sort().join() === 'a,b', 'folder Chill = a,b');
        assert(L.collectScope('group', 'G').map(i => i.id).join() === 'a', 'group G = a');
        assert(L.collectScope('song', 'c').map(i => i.id).join() === 'c', 'song = c');
        // Only online tracks with no local file are candidates (b is a local path -> excluded).
        assert(L.localizeCandidates('library').map(i => i.id).sort().join() === 'a,c', 'candidates = online-only a,c');
        console.log('scope + candidates OK');
    }

    // --- 3. localizeScope tags localPath but keeps the online url (dual-source) ---
    {
        const nat = stub();
        nat.scanLocalized = async (dir) => ({ ok: true, dir, files: [] });
        const { S, L } = loadAll(makeCtx(SEED, nat));
        const res = await L.localizeScope('folder', 'Chill', 'D:/EveMusic', () => {});
        assert(res.ok && res.done === 1 && res.total === 1, `localized 1 online track in Chill (got done=${res.done})`);
        assert(nat.downloaded.join() === 'a', 'only track a was downloaded');
        const a = S.ensure().music.find(m => m.id === 'a');
        assert(a.url === 'https://youtube.com/watch?v=1', 'a keeps its online url');
        assert(a.localPath === 'D:/EveMusic/Night Drive.mp3', 'a now carries a localPath');
        assert(S.ensure().localizeDir.split('\\').join('/') === 'D:/EveMusic', 'target folder remembered for next time (stored with normalized separators)');
        // Re-running finds nothing to localize (already has localPath).
        assert(L.localizeCandidates('folder', 'Chill').length === 0, 're-run has no candidates');
        console.log('localizeScope OK (dual-source: url kept + localPath added)');
    }

    // --- 4. Reimport music port: attach files to tracks by title ---
    {
        const { S, L } = loadAll(makeCtx(SEED, stub()));
        const res = await L.reimportMerge('D:/EveMusic');
        assert(res.ok && res.matched === 1, `reimport matched 1 by title (got ${res.matched})`);
        const a = S.ensure().music.find(m => m.id === 'a');
        assert(a.localPath === 'D:/EveMusic/Night Drive.mp3', 'reimport re-attached localPath by title');
        console.log('reimport music port OK');
    }

    // --- 5. Group localization classes: folder=1st, group=2nd, shortcut=3rd (smart mode) ---
    {
        const seed = {
            music: [
                { id: 'f1', title: 'Folder Song', url: 'https://y/1', folder: 'Chill', localizations: [{ source: 'folder:Chill', path: 'D:/Chill/Folder Song.mp3', kind: 'file' }], localPath: 'D:/Chill/Folder Song.mp3' },
                { id: 'n1', title: 'New Song', url: 'https://y/2', folder: 'Chill' },
                { id: 's1', title: 'Shared Song', url: 'https://y/3', folder: 'Chill', localizations: [{ source: 'group:Other', path: 'D:/Other/Shared Song.mp3', kind: 'file' }], localPath: 'D:/Other/Shared Song.mp3' }
            ],
            musicGroups: ['Vibes'], musicGroupMap: { f1: ['Vibes'], n1: ['Vibes'], s1: ['Vibes'] }
        };
        const nat = stub();
        const { S, L } = loadAll(makeCtx(seed, nat));
        const res = await L.localizeScope('group', 'Vibes', 'D:/Vibes', () => {}, false, 'link');
        assert(res.ok && res.skipped === 1 && res.shortcut === 1 && res.done === 1, `link classes: skip1/short1/dl1 (got ${res.skipped}/${res.shortcut}/${res.done})`);
        assert(nat.downloaded.join() === 'n1', 'only the fresh song downloaded');
        const m = (id) => S.ensure().music.find((x) => x.id === id);
        assert(L.effectiveLocalPath(m('f1')) === 'D:/Chill/Folder Song.mp3', 'f1 keeps folder path (1st class)');
        assert(m('s1').localizations.some((l) => l.source === 'group:Vibes' && l.kind === 'shortcut' && l.path === 'D:/Other/Shared Song.mp3'), 's1 got a group shortcut to the existing file');
        assert(L.effectiveLocalPath(m('s1')) === 'D:/Other/Shared Song.mp3', 's1 effective = shortcut target (3rd class, no dup file)');
        assert(L.effectiveLocalPath(m('n1')) === 'D:/Vibes/New Song.mp3', 'n1 got a 2nd-class group file');
        assert(L.songLocalizationList(m('f1'))[0].label.startsWith('Folder'), 'song list ranks folder first');
        console.log('group classes OK — link mode (folder 1st / group 2nd / shortcut 3rd)');
    }

    // --- 5b. "Fresh" mode: no shortcuts — folder copies still skipped, everything else downloads ---
    {
        const seed = {
            music: [
                { id: 'f1', title: 'Folder Song', url: 'https://y/1', folder: 'Chill', localizations: [{ source: 'folder:Chill', path: 'D:/Chill/Folder Song.mp3', kind: 'file' }], localPath: 'D:/Chill/Folder Song.mp3' },
                { id: 's1', title: 'Shared Song', url: 'https://y/3', folder: 'Chill', localizations: [{ source: 'group:Other', path: 'D:/Other/Shared Song.mp3', kind: 'file' }], localPath: 'D:/Other/Shared Song.mp3' }
            ],
            musicGroups: ['Vibes'], musicGroupMap: { f1: ['Vibes'], s1: ['Vibes'] }
        };
        const nat = stub();
        const { S, L } = loadAll(makeCtx(seed, nat));
        const res = await L.localizeScope('group', 'Vibes', 'D:/Vibes', () => {}, false, 'smart');
        assert(res.skipped === 1 && res.shortcut === 0 && res.done === 1, `fresh mode: skip folder, no shortcut, download the rest (got ${res.skipped}/${res.shortcut}/${res.done})`);
        const s1 = S.ensure().music.find((x) => x.id === 's1');
        assert(s1.localizations.some((l) => l.source === 'group:Vibes' && l.kind === 'file'), 'fresh mode gives s1 a real group file, not a shortcut');
        console.log('group classes OK — fresh mode (no shortcuts)');
    }

    // --- 6. Duplicate mode: every online song gets its own copy; folder still plays first ---
    {
        const seed = {
            music: [{ id: 'f1', title: 'Folder Song', url: 'https://y/1', folder: 'Chill', localizations: [{ source: 'folder:Chill', path: 'D:/Chill/Folder Song.mp3', kind: 'file' }], localPath: 'D:/Chill/Folder Song.mp3' }],
            musicGroups: ['Vibes'], musicGroupMap: { f1: ['Vibes'] }
        };
        const { S, L } = loadAll(makeCtx(seed, stub()));
        const res = await L.localizeScope('group', 'Vibes', 'D:/Vibes', () => {}, false, 'dup');
        assert(res.done === 1, 'dup mode downloads even the folder-localized song');
        const m = S.ensure().music.find((x) => x.id === 'f1');
        assert(m.localizations.some((l) => l.source === 'folder:Chill') && m.localizations.some((l) => l.source === 'group:Vibes'), 'f1 carries both folder + group paths');
        assert(L.effectiveLocalPath(m) === 'D:/Chill/Folder Song.mp3', 'folder path still primary over the group dup');
        console.log('duplicate mode OK (2 paths, folder still 1st)');
    }

    // --- 7. Reuse mode creates a REAL on-disk link, and the sensor trusts it ---
    {
        const seed = {
            music: [
                { id: 's1', title: 'Shared Song', url: 'https://y/3', folder: 'Chill',
                  localizations: [{ source: 'folder:Chill', path: 'D:/Chill/Shared Song.mp3', kind: 'file' }],
                  localPath: 'D:/Chill/Shared Song.mp3' }
            ],
            musicGroups: ['Vibes'], musicGroupMap: { s1: ['Vibes'] }
        };
        // Folder-localized already, so 'link' mode would normally skip it; drop the folder class to
        // force the shortcut branch (song localized elsewhere, e.g. by another group).
        seed.music[0].localizations = [{ source: 'group:Other', path: 'D:/Other/Shared Song.mp3', kind: 'file' }];
        const links = [];
        const nat = stub();
        nat.linkLocalFile = async (source, dir, name) => {
            links.push({ source, dir, name });
            return { ok: true, path: `${dir}/${name}.mp3`, method: 'hardlink' };
        };
        // Only the ORIGINAL folder holds the real bytes; the group dir reports the link file.
        nat.scanLocalized = async (dir) => {
            if (String(dir).includes('Other')) return { ok: true, dir, files: [{ name: 'Shared Song', fileName: 'Shared Song.mp3', path: 'D:/Other/Shared Song.mp3', ext: 'mp3' }] };
            if (String(dir).includes('Vibes')) return { ok: true, dir, files: [{ name: 'Shared Song', fileName: 'Shared Song.mp3', path: 'D:/Vibes/Shared Song.mp3', ext: 'mp3' }] };
            return { ok: true, dir, files: [] };
        };
        const { S, L } = loadAll(makeCtx(seed, nat));
        const res = await L.localizeScope('group', 'Vibes', 'D:/Vibes', () => {}, false, 'link');
        assert(res.shortcut === 1 && res.done === 0, `reuse mode links instead of downloading (got short=${res.shortcut} dl=${res.done})`);
        assert(links.length === 1 && links[0].source === 'D:/Other/Shared Song.mp3' && links[0].dir === 'D:/Vibes',
            'a real link was requested from the existing file into the group folder');
        const entry = S.ensure().music[0].localizations.find((l) => l.source === 'group:Vibes');
        assert(entry && entry.kind === 'shortcut', 'group entry is a shortcut');
        assert(entry.path === 'D:/Vibes/Shared Song.mp3', `shortcut path is the link inside the group folder (got ${entry.path})`);
        assert(entry.linkOf === 'D:/Other/Shared Song.mp3', `shortcut records the physical file it points at (got ${entry.linkOf})`);

        // The sensor must NOT call this missing: its physical bytes exist, just in another folder.
        const audit = await L.auditScopeDiskStatus('group', 'Vibes');
        assert(audit.missing === 0, `a shortcut with a live target must not read as missing (got missing=${audit.missing})`);
        assert(S.ensure().music[0].missingLocal !== true, 'track is not flagged missingLocal');
        console.log('shortcut link + shortcut-aware sensor OK');
    }

    // --- 8. Sensor still reports a genuinely deleted file ---
    {
        const seed = {
            music: [{ id: 'g1', title: 'Gone Song', url: 'https://y/9', folder: 'Chill',
                      localizations: [{ source: 'folder:Chill', path: 'D:/Chill/Gone Song.mp3', kind: 'file' }],
                      localPath: 'D:/Chill/Gone Song.mp3' }],
            musicGroups: ['Vibes'], musicGroupMap: { g1: ['Vibes'] },
            localizeScopeDirs: { 'group:Vibes': 'D:/Vibes' }
        };
        const nat = stub();
        nat.scanLocalized = async (dir) => ({ ok: true, dir, files: [] });   // nothing on disk anywhere
        const { S, L } = loadAll(makeCtx(seed, nat));
        const audit = await L.auditScopeDiskStatus('group', 'Vibes');
        assert(audit.missing === 1, `a truly deleted file must still be reported (got ${audit.missing})`);
        assert(S.ensure().music[0].missingLocal === true, 'deleted file flags missingLocal');
        console.log('deleted-file detection OK');
    }

    // --- 9. Recalibrating ONE scope must not stomp another scope's paths ---
    {
        const seed = {
            music: [{
                id: 't1', title: 'Both Song', url: 'https://y/1', folder: 'Chill',
                localizations: [
                    { source: 'folder:Chill', path: 'D:/Chill/Both Song.mp3', kind: 'file' },
                    { source: 'group:Vibes', path: 'D:/Vibes/Both Song.mp3', kind: 'shortcut', linkOf: 'D:/Chill/Both Song.mp3' }
                ],
                localPath: 'D:/Chill/Both Song.mp3'
            }],
            musicGroups: ['Vibes'], musicGroupMap: { t1: ['Vibes'] },
            localizeScopeDirs: { 'folder:Chill': 'D:/Chill', 'group:Vibes': 'D:/Vibes' }
        };
        const { S, L } = loadAll(makeCtx(seed, stub()));
        // Move only the GROUP's path. The folder file (the physical copy) must not move.
        L.updateScopeDir('group', 'Vibes', 'E:/NewVibes');
        let t = S.ensure().music[0];
        const folderEntry = t.localizations.find((l) => l.source === 'folder:Chill');
        const groupEntry = t.localizations.find((l) => l.source === 'group:Vibes');
        assert(folderEntry.path === 'D:/Chill/Both Song.mp3', `folder (physical) path untouched by a group recalibrate (got ${folderEntry.path})`);
        assert(groupEntry.path === 'E:\\NewVibes\\Both Song.mp3', `group shortcut moved to the new dir (got ${groupEntry.path})`);
        assert(groupEntry.linkOf === 'D:/Chill/Both Song.mp3', 'shortcut still points at the real physical file');
        assert(L.effectiveLocalPath(t) === 'D:/Chill/Both Song.mp3', 'folder file still wins as the effective path');

        // Now move the FOLDER: its own entry moves, the group shortcut path stays in the group folder.
        L.updateScopeDir('folder', 'Chill', 'E:/NewChill');
        t = S.ensure().music[0];
        assert(t.localizations.find((l) => l.source === 'folder:Chill').path === 'E:\\NewChill\\Both Song.mp3', 'folder entry moved');
        assert(t.localizations.find((l) => l.source === 'group:Vibes').path === 'E:\\NewVibes\\Both Song.mp3', 'group entry not dragged along by the folder recalibrate');
        assert(L.effectiveLocalPath(t) === 'E:\\NewChill\\Both Song.mp3', 'effective path follows the folder (1st class)');
        console.log('scoped recalibrate OK (physical vs shortcut paths kept apart)');
    }

    // --- 10. Recalibration preserves nested relative paths and clears stale missing flags. ---
    {
        const oldRoot = 'D:/OldMusic';
        const newRoot = 'E:/NewMusic';
        const seed = {
            music: [{
                id: 'nested', title: 'Nested Song', url: 'https://y/nested', folder: 'Sleep',
                localPath: `${oldRoot}/Disc 1/Nested Song.mp3`,
                localizations: [{
                    source: 'folder:Sleep',
                    path: `${oldRoot}/Disc 1/Nested Song.mp3`,
                    kind: 'file'
                }],
                missingLocal: true
            }],
            musicPortConnections: [{
                id: 'port-sleep', path: oldRoot, folder: 'Sleep', lastSyncedAt: 1, trackCount: 1
            }],
            localizeScopeDirs: { 'folder:Sleep': oldRoot }
        };
        const nat = {
            scanLocalized: async (dir) => ({
                ok: true,
                dir,
                files: [{
                    name: 'Nested Song',
                    fileName: 'Nested Song.mp3',
                    path: `${dir}/Disc 1/Nested Song.mp3`,
                    ext: 'mp3'
                }]
            })
        };
        const { S, L } = loadAll(makeCtx(seed, nat));
        const result = await L.recalibrateScopePath('folder', 'Sleep', `"${newRoot}"`);
        const track = S.ensure().music[0];
        const entry = track.localizations.find((loc) => loc.source === 'folder:Sleep');
        const connection = S.ensure().musicPortConnections.find((item) => item.id === 'port-sleep');
        assert(result.ok && result.recalibrated === 1, 'nested recalibration did not match the track');
        assert(entry.path.replace(/\\/g, '/') === `${newRoot}/Disc 1/Nested Song.mp3`, 'nested relative path was flattened');
        assert(track.localPath.replace(/\\/g, '/') === `${newRoot}/Disc 1/Nested Song.mp3`, 'effective local path did not follow recalibration');
        assert(track.missingLocal === false, 'recalibration did not clear stale missingLocal');
        assert(connection.path.replace(/\\/g, '/') === newRoot, 'Music Port root did not follow recalibration');
        console.log('nested path recalibration OK');
    }

    // --- 11. Folder/group renames migrate physical ownership metadata case-insensitively. ---
    {
        const seed = {
            music: [{
                id: 'rename-track',
                title: 'Rename Track',
                url: 'https://y/rename',
                folder: 'Sleep',
                card: 'Sleep',
                localPath: 'D:/Sleep/Sub/Rename Track.mp3',
                localizations: [
                    { source: 'folder:sLeEp', path: 'D:/Sleep/Sub/Rename Track.mp3', kind: 'file' },
                    { source: 'group:NIGHT', path: 'D:/Night/Rename Track.mp3', kind: 'file' }
                ]
            }],
            musicGroups: ['NIGHT'],
            musicGroupMap: { 'rename-track': ['night'] },
            musicPortConnections: [{ id: 'rename-port', folder: 'SLEEP', path: 'D:/Sleep' }],
            localizeScopeDirs: {
                'folder:SLEEP': 'D:/Sleep',
                'group:Night': 'D:/Night'
            },
            activeMusicFolderScope: 'sleep',
            activeFrontendMusicGroup: 'night'
        };
        const { S, L } = loadAll(makeCtx(seed, {}));
        S.renameMusicFolder('sleep', 'Rest');
        S.renameGroup('music', 'night', 'Dream');
        const stored = S.ensure();
        const track = stored.music[0];
        assert(track.folder === 'Rest' && track.card === 'Rest', 'folder rename did not update the track');
        assert(track.localizations.some((entry) => entry.source === 'folder:Rest'), 'folder localization ownership was left stale');
        assert(track.localizations.some((entry) => entry.source === 'group:Dream'), 'group localization ownership was left stale');
        assert(stored.musicPortConnections[0].folder === 'Rest', 'Music Port connection did not follow folder rename');
        assert(stored.localizeScopeDirs['folder:Rest'] === 'D:/Sleep', 'folder localization root did not migrate');
        assert(stored.localizeScopeDirs['group:Dream'] === 'D:/Night', 'group localization root did not migrate');
        assert(stored.activeMusicFolderScope === 'Rest', 'active folder scope did not follow rename');
        assert(stored.activeFrontendMusicGroup === 'Dream', 'active group scope did not follow rename');
        const moved = L.updateScopeDir('folder', 'REST', 'E:/Rest');
        assert(moved.updatedCount === 1, 'case-insensitive folder scope failed to collect its track');
        assert(track.id === 'rename-track', 'rename fixture was corrupted');
        console.log('folder/group localization rename migration OK');
    }

    // --- 12. importMusicPort: subfolder tracks get targetFolder and subfolder manual classifiers ---
    {
        const rootDir = 'C:/Users/alvin/Downloads/Temp-Music-Index-Holder/Old Song Relocation';
        const nat = {
            scanLocalized: async (dir) => ({
                ok: true,
                dir,
                files: [
                    { name: 'Anime Song', fileName: 'Anime Song.mp3', path: `${dir}/Anime/Anime Song.mp3`, ext: 'mp3' },
                    { name: 'Piano Track', fileName: 'Piano Track.mp3', path: `${dir}/Instrumental/Piano/Piano Track.mp3`, ext: 'mp3' },
                    { name: 'Root Track', fileName: 'Root Track.mp3', path: `${dir}/Root Track.mp3`, ext: 'mp3' }
                ]
            })
        };
        const { S, L, C } = loadAll(makeCtx({}, nat));
        const res = await L.importMusicPort(rootDir, 'Old-Song-Relocation');
        assert(res.ok && res.added === 3, `imported 3 tracks (got ${res.added})`);
        
        const music = S.ensure().music;
        assert(music.every((m) => m.folder === 'Old-Song-Relocation'), 'all imported tracks carry target folder tag "Old-Song-Relocation"');
        assert(music.every((m) => m.isPorted === true), 'all imported tracks carry isPorted=true flag');

        const animeSong = music.find((m) => m.title === 'Anime Song');
        const pianoTrack = music.find((m) => m.title === 'Piano Track');
        const rootTrack = music.find((m) => m.title === 'Root Track');

        assert(animeSong.classifiers.includes('Anime'), 'subfolder "Anime" attached as manual classifier');
        assert(pianoTrack.classifiers.includes('Instrumental') && pianoTrack.classifiers.includes('Piano'), 'nested subfolders "Instrumental" and "Piano" attached as manual classifiers');
        assert(rootTrack.classifiers.length === 0, 'root track gets no subfolder classifiers');
        assert((S.ensure().musicGroupMap[animeSong.id] || []).includes('Anime'), 'nearest subfolder also becomes the imported track group');
        assert((S.ensure().musicGroupMap[pianoTrack.id] || []).includes('Piano'), 'deepest nested subfolder becomes the track group');
        assert(animeSong.musicPortGroup === 'Anime', 'automatic Anime port group persists on the item');
        assert(pianoTrack.musicPortGroup === 'Piano', 'deepest automatic port group persists on the item');
        assert(!(S.ensure().musicGroupMap[rootTrack.id] || []).length, 'root-level port tracks do not get a synthetic group');
        assert(animeSong.localizations.some((entry) => entry.source === 'folder:Old-Song-Relocation'), 'imported track lacks durable folder localization');
        assert(S.ensure().musicPortConnections.some((entry) => entry.folder === 'Old-Song-Relocation' && entry.path === rootDir), 'Music Port connection was not retained');

        assert(C.manualNames().includes('Anime') && C.manualNames().includes('Instrumental') && C.manualNames().includes('Piano'), 'subfolder names registered in state.musicClassifiers');
        console.log('importMusicPort subfolder classifier extraction OK');
    }

    // --- 13. Sync restores moved roots without marking unrelated URL-only tracks missing. ---
    {
        const oldRoot = 'D:/OldPort';
        const newRoot = 'E:/NewPort';
        const seed = {
            music: [
                {
                    id: 'ported', title: 'Ported Song', url: 'https://y/ported', folder: 'Port',
                    localPath: `${oldRoot}/Sub/Ported Song.mp3`,
                    localizations: [{ source: 'folder:Port', path: `${oldRoot}/Sub/Ported Song.mp3`, kind: 'file' }],
                    isMusicPort: true,
                    missingLocal: true
                },
                { id: 'online', title: 'Online Only', url: 'https://y/online', folder: 'Port' }
            ],
            musicPortConnections: [{ id: 'port-root', path: newRoot, folder: 'Port', trackCount: 1 }],
            localizeScopeDirs: { 'folder:Port': newRoot }
        };
        const nat = {
            scanLocalized: async (dir) => ({
                ok: true,
                dir,
                files: [{
                    name: 'Ported Song',
                    fileName: 'Ported Song.mp3',
                    path: `${dir}/Sub/Ported Song.mp3`,
                    ext: 'mp3'
                }]
            })
        };
        const { S, L } = loadAll(makeCtx(seed, nat));
        const result = await L.syncMusicPortFolder('Port');
        const ported = S.ensure().music.find((item) => item.id === 'ported');
        const online = S.ensure().music.find((item) => item.id === 'online');
        assert(result.ok && result.restored === 1 && result.missing === 0, 'Music Port sync did not restore the moved file cleanly');
        assert(ported.localPath.replace(/\\/g, '/') === `${newRoot}/Sub/Ported Song.mp3`, 'sync did not preserve nested relative path');
        assert(ported.missingLocal === false, 'restored Music Port track remains missing');
        assert(online.missingLocal !== true, 'unrelated URL-only track was incorrectly marked missing');
        console.log('Music Port moved-root sync OK');
    }

    console.log('AUDIOFLIX_LOCALIZE_SMOKE_OK');
})().catch((err) => { console.error(err); process.exit(1); });
