const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
};

function makeAudit(item, native, browserFolders) {
    const ctx = {
        console,
        URL,
        Set,
        Map,
        String,
        Array,
        Object,
        Promise,
        window: {
            EveAudioflixNative: native,
            EveAudioflixFsPorts: browserFolders
        }
    };
    ctx.window.window = ctx.window;
    vm.runInNewContext(source('js/modules/features/audioflix/audioflix.paths.js'), ctx);
    vm.runInNewContext(source('js/modules/features/audioflix/audioflix.localize.audit.js'), ctx);
    const store = {
        updateItem(type, id, patch) {
            if (type === 'music' && id === item.id) Object.assign(item, patch);
        }
    };
    return ctx.window.EveAudioflixLocalizeAudit.create({
        S: () => store,
        text: (value) => String(value ?? '').trim(),
        paths: ctx.window.EveAudioflixPaths,
        collectScope: () => [item],
        getScopeDir: () => 'C:\\Users\\alvin\\Downloads\\test-2',
        extractDir: (value) => ctx.window.EveAudioflixPaths.dirname(value)
    });
}

(async function main() {
    const localPath = 'C:\\Users\\alvin\\Downloads\\test-2\\poster boy.mp3';

    {
        const item = { id: 'offline', title: 'poster boy', localPath, missingLocal: true };
        const audit = makeAudit(item, {
            scanLocalized: async () => { throw new Error('localhost unavailable'); }
        });
        const result = await audit('folder', 'Test');
        assert(result.unverified === 1 && result.missing === 0, 'offline scan is unverified, not missing');
        assert(item.missingLocal === true, 'unverified transport preserves the last verified missing state');
    }

    {
        const item = { id: 'present', title: 'poster boy', localPath, missingLocal: true };
        const audit = makeAudit(item, {
            scanLocalized: async (dir) => ({
                ok: true,
                files: [{ fileName: 'poster boy.mp3', path: `${dir}\\poster boy.mp3` }]
            })
        });
        const result = await audit('folder', 'Test');
        assert(result.complete && result.verified === 1 && result.missing === 0, 'native scan finds existing file');
        assert(item.missingLocal === false, 'native presence clears missing flag');
    }

    {
        const item = { id: 'browser', title: 'poster boy', localPath, missingLocal: true };
        const audit = makeAudit(item, {}, {
            verifyPath: async (claim) => ({ verified: claim === localPath, present: claim === localPath })
        });
        const result = await audit('folder', 'Test');
        assert(result.complete && result.verified === 1 && result.missing === 0, 'granted folder verifies file:// path');
        assert(item.missingLocal === false, 'browser-granted presence clears missing flag');
    }

    {
        const item = { id: 'gone', title: 'gone', localPath, missingLocal: false };
        const audit = makeAudit(item, {
            scanLocalized: async () => ({ ok: true, files: [] })
        });
        const result = await audit('folder', 'Test');
        assert(result.complete && result.missing === 1, 'authoritative empty scan still detects deletion');
        assert(item.missingLocal === true, 'verified deletion sets missing flag');
    }

    {
        const fsPath = 'fsport://music-root/Album/moved.mp3';
        const item = { id: 'fs-moved', title: 'moved', localPath: fsPath, missingLocal: false, isMusicPort: true };
        const audit = makeAudit(item, {
            scanLocalized: async () => { throw new Error('localhost unavailable'); }
        }, {
            verifyPath: async (claim) => ({ verified: claim === fsPath, present: false })
        });
        const result = await audit('folder', 'Ported');
        assert(result.complete && result.missing === 1, 'granted browser Music Port detects a moved file at its expected path');
        assert(item.missingLocal === true, 'moved browser-port track becomes missingLocal');
    }

    console.log('AUDIOFLIX_LOCALIZE_AUDIT_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
