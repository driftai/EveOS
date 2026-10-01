window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    let overlay = null;
    let previewing = false;
    let dictating = false;
    let unsubscribe = null;

    function activeEditor() {
        return overlay?.dataset.eveNotesMode === 'scratchpad'
            ? overlay.querySelector('[data-world-book-notes]')
            : overlay?.querySelector('[data-eve-notes-editor]');
    }

    function appendAtCursor(editor, text) {
        if (!editor || !text) return;
        const start = Number.isFinite(editor.selectionStart) ? editor.selectionStart : editor.value.length;
        const end = Number.isFinite(editor.selectionEnd) ? editor.selectionEnd : start;
        const prefix = start > 0 && !/\s$/.test(editor.value.slice(0, start)) ? ' ' : '';
        editor.setRangeText(prefix + text, start, end, 'end');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function renderMarkdown() {
        const editor = overlay?.querySelector('[data-eve-notes-editor]');
        const output = overlay?.querySelector('[data-eve-notes-markdown-preview]');
        if (!editor || !output) return;
        output.replaceChildren();
        let inCode = false;
        let code = null;
        String(editor.value || '').split(/\r?\n/).forEach(line => {
            if (line.startsWith('```')) {
                inCode = !inCode;
                if (inCode) { code = document.createElement('pre'); output.appendChild(code); }
                return;
            }
            if (inCode) { code.textContent += `${line}\n`; return; }
            const match = /^(#{1,3})\s+(.*)$/.exec(line);
            const node = document.createElement(match ? `h${match[1].length}` : 'p');
            node.textContent = match ? match[2] : line || ' ';
            output.appendChild(node);
        });
    }

    function togglePreview(button) {
        const editor = overlay?.querySelector('[data-eve-notes-editor]');
        const output = overlay?.querySelector('[data-eve-notes-markdown-preview]');
        if (!editor || !output || editor.disabled) return;
        previewing = !previewing;
        if (previewing) renderMarkdown();
        editor.hidden = previewing;
        output.hidden = !previewing;
        button.textContent = previewing ? 'Edit' : 'Preview';
    }

    function toggleDictation(button) {
        const recognition = window.AudioProcessingControlsAgentic?.SpeechRecognitionHandler;
        if (!recognition) return;
        if (!recognition.isSupported?.()) recognition.initialize?.();
        if (!recognition.isSupported?.()) { button.textContent = 'Mic unavailable'; return; }
        if (dictating) {
            recognition.stop?.();
            unsubscribe?.();
            unsubscribe = null;
            dictating = false;
        } else {
            unsubscribe = recognition.subscribe?.(text => appendAtCursor(activeEditor(), text));
            recognition.start?.({ autoSend: false });
            dictating = true;
        }
        overlay.querySelectorAll('[data-eve-notes-dictate]').forEach(item => {
            item.textContent = dictating ? 'Stop dictation' : 'Dictate';
            item.setAttribute('aria-pressed', dictating ? 'true' : 'false');
        });
    }

    function bind(target) {
        overlay = target;
        if (!overlay || overlay.dataset.notesEditorToolsBound === '1') return;
        overlay.dataset.notesEditorToolsBound = '1';
        overlay.addEventListener('click', event => {
            const preview = event.target.closest?.('[data-eve-notes-preview]');
            const dictate = event.target.closest?.('[data-eve-notes-dictate]');
            if (preview) togglePreview(preview);
            else if (dictate) toggleDictation(dictate);
        });
        overlay.querySelector('[data-eve-notes-editor]')?.addEventListener('input', () => {
            if (previewing) renderMarkdown();
        });
    }

    ns.notesEditorTools = Object.freeze({ bind });
})(window.EveWorldBook);
