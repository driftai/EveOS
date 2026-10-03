module.exports = function seedAudioflixDurabilityFixture() {
    window.EveAudioflixState.addPort({ nickname: 'RTPort', path: 'C:/rt/sounds' });
    window.EveAudioflixState.addSoundboardGroup('RTGroup');
    window.EveAudioflixState.addItem('sound', {
        id: 'rt-sound',
        title: 'RT Sound',
        url: 'media/rt.wav',
        localPath: 'C:/rt/sounds/rt.wav',
        volume: 0,
        category: 'Alerts',
        exposed: true,
        hotkey: 'ctrl+shift+r'
    });
    window.EveAudioflixState.addItem('music', {
        id: 'rt-music',
        title: 'RT Music',
        url: 'https://example.com/watch?v=rt',
        localPath: 'C:/rt/music/Sleep/Disc 1/RT Music.mp3',
        localizations: [
            {
                source: 'folder:Sleep',
                path: 'C:/rt/music/Sleep/Disc 1/RT Music.mp3',
                kind: 'file'
            },
            {
                source: 'group:Night',
                path: 'C:/rt/music/Night/RT Music.mp3',
                kind: 'shortcut',
                linkOf: 'C:/rt/music/Sleep/Disc 1/RT Music.mp3'
            }
        ],
        classifiers: ['Sleep', 'Manual'],
        artist: 'Runtime Artist',
        card: 'Sleep',
        folder: 'Sleep',
        category: 'Ambient',
        volume: 0.62,
        duration: 321,
        exposed: true,
        hotkey: 'alt+r',
        playlistId: 'playlist-rt',
        sourceId: 'source-rt',
        upstreamMissing: true,
        isPorted: true,
        isMusicPort: true,
        createdAt: 101,
        updatedAt: 202,
        lastPlayedAt: 303
    });
    window.EveAudioflixState.addItem('music', { id: 'other-music', title: 'Other Music', url: 'media/other.mp3' });
    window.EveAudioflixState.addItem('music', { id: 'main-workspace-music', title: 'Main Workspace Music', url: 'media/main.mp3' });
    window.EveAudioflixState.addItem('music', { id: 'folder-music', title: 'Folder Music', url: 'media/folder.mp3' });
    window.EveAudioflixState.addItem('music', { id: 'bookmark-music', title: 'Bookmark Music', url: 'media/bookmark.mp3' });
    window.EveAudioflixState.addItem('music', { id: 'outside-folder-music', title: 'Outside Folder Music', url: 'media/outside.mp3' });
    window.EveAudioflixLinks.add(['rt-music'], {
        scopeType: 'card',
        workspaceId: 'main',
        categoryName: 'RT Card'
    }, 'music');
    window.EveAudioflixLinks.add(['rt-sound'], {
        scopeType: 'card',
        workspaceId: 'main',
        categoryName: 'RT Card'
    }, 'sound');
    window.EveAudioflixState.addMusicGroup('Mood');
    window.EveAudioflixState.addMusicGroup('Night', 'Mood');
    window.EveAudioflixState.toggleMusicGroup('rt-music', 'Night', true);
    window.EveAudioflixState.addSoundboardGroup('SFX');
    window.EveAudioflixState.setGroupParent('sound', 'RTGroup', 'SFX');
    window.EveAudioflixState.toggleSoundGroup('rt-sound', 'RTGroup', true);
    window.EveAudioflixState.update({
        musicClassifiers: ['Sleep', 'Manual'],
        musicPlaylists: [{
            id: 'playlist-rt',
            title: 'Runtime Playlist',
            url: 'https://example.com/playlist',
            source: 'manual',
            lastSyncedAt: 404
        }],
        musicPortConnections: [{
            id: 'music-port-rt',
            folder: 'Sleep',
            path: 'C:/rt/music/Sleep',
            lastSyncedAt: 505,
            trackCount: 1
        }],
        localizeDir: 'C:/rt/music/Sleep',
        localizeScopeDirs: {
            'folder:Sleep': 'C:/rt/music/Sleep',
            'group:Night': 'C:/rt/music/Night'
        },
        dupDismissedPairs: ['rt-music|rt-sound'],
        portVolumes: { 'rt-sound': 0 },
        exposedPortedSounds: { 'rt-sound': true },
        portHotkeys: { 'rt-sound': 'ctrl+shift+r' }
    }, 'durability-rich-metadata');
    window.EveAudioflixLinks.add(['other-music'], {
        scopeType: 'workspace',
        workspaceId: 'other'
    }, 'music');
    window.EveAudioflixLinks.add(['main-workspace-music'], {
        scopeType: 'workspace',
        workspaceId: 'main'
    }, 'music');
    window.EveAudioflixLinks.add(['folder-music'], {
        scopeType: 'folder',
        workspaceId: 'main',
        categoryName: 'RT Card',
        folderId: 'folder-root'
    }, 'music');
    window.EveAudioflixLinks.add(['bookmark-music'], {
        scopeType: 'bookmark',
        workspaceId: 'main',
        categoryName: 'RT Card',
        folderId: 'folder-child',
        bookmarkId: 'bookmark-child'
    }, 'music');
    window.EveAudioflixLinks.add(['outside-folder-music'], {
        scopeType: 'folder',
        workspaceId: 'main',
        categoryName: 'RT Card',
        folderId: 'folder-outside'
    }, 'music');

    const datapack = window.EveDataStore.Store.captureState();
    datapack.bookmarks.links = [
        {
            id: 'bookmark-root',
            title: 'Root Folder Bookmark',
            url: 'https://example.com/root',
            workspace: 'main',
            category: 'RT Card',
            folderId: 'folder-root'
        },
        {
            id: 'bookmark-child',
            title: 'Child Folder Bookmark',
            url: 'https://example.com/child',
            workspace: 'main',
            category: 'RT Card',
            folderId: 'folder-child'
        },
        {
            id: 'bookmark-outside',
            title: 'Outside Folder Bookmark',
            url: 'https://example.com/outside',
            workspace: 'main',
            category: 'RT Card',
            folderId: 'folder-outside'
        }
    ];
    datapack.bookmarks.folders = {
        'main::RT Card': {
            nodes: [
                { id: 'folder-root', parentId: null, name: 'Root Folder', order: 1 },
                { id: 'folder-child', parentId: 'folder-root', name: 'Child Folder', order: 1 },
                { id: 'folder-outside', parentId: null, name: 'Outside Folder', order: 2 }
            ]
        }
    };
    window.EveDataStore.Store.applyState(datapack);
};
