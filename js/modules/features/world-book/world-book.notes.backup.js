window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    function download(payload) {
        const raw = atob(payload.base64 || '');
        const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = payload.filename || 'EveOS-Spatial-Notes.zip';
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function exportSpatial() {
        download(await ns.notesClient.exportSpatial());
        return 'Spatial Notes backup exported.';
    }

    async function importSpatial(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return ns.notesClient.importSpatial(btoa(binary));
    }

    ns.notesBackup = Object.freeze({ exportSpatial, importSpatial });
})(window.EveWorldBook);
