window.getModalStackZIndex = function () {
    // Any currently-open overlay/dialog/surface that a modal must sit ON TOP of. This must include:
    //  - the Search Monitor (#loadingIndicator), which reaches z=1000000 in fullscreen/workspace
    //    mode — modals spawned from the embedded Gemini workspace were rendering BEHIND it;
    //  - Notes & World Books, whose workspace itself sits above the ordinary modal baseline;
    //  - other open native <dialog>s, so a confirm from inside one stacks above it;
    //  - high-z overlays spawned from other surfaces (e.g. the Chat Clear dialog).
    const selectors = [
        '#loadingIndicator',
        'dialog[open]',
        '#constellation-map-overlay',
        '.notes-world-book-overlay.is-open',
        '#custom-modal-overlay',
        '#custom-confirm-modal',
        '#chat-clear-dialog',
        '#chat-clear-overlay',
        '#gemini-new-chat-confirm',
        '.modal-overlay',
        '[data-eve-dialog]'
    ];
    const seen = new Set();
    const candidates = [];
    selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => {
            if (element && !seen.has(element)) { seen.add(element); candidates.push(element); }
        });
    });

    return candidates.reduce((maxZ, element) => {
        const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
        if (!style || style.display === 'none' || style.visibility === 'hidden') return maxZ;
        const nextZ = parseInt(style.zIndex, 10);
        return Number.isFinite(nextZ) ? Math.max(maxZ, nextZ) : maxZ;
    }, 3000);
};

window.showConfirm = function (msg, options = {}) {
    return new Promise((resolve) => {
        window.setupModal(options.title || 'Confirm', msg, false, (result) => resolve(!!result), '', options);
    });
};

window.showConfirmWithTitle = function (title, msg, options = {}) {
    return new Promise((resolve) => {
        window.setupModal(title || 'Confirm', msg, false, (result) => resolve(!!result), '', options);
    });
};

window.showPrompt = function (msg, defaultValue = '') {
    return new Promise((resolve) => {
        window.setupModal(msg, '', true, (result) => resolve(result), defaultValue);
    });
};

window.setupModal = function (title, msg, isPrompt, callback, defaultValue = '', options = {}) {
    const overlay = document.getElementById('custom-modal-overlay');
    const titleEl = document.getElementById('custom-modal-title');
    const msgEl = document.getElementById('custom-modal-msg');
    const inputContainer = document.getElementById('custom-modal-input-container');
    const input = document.getElementById('custom-modal-input');
    const confirmBtn = document.getElementById('custom-modal-confirm');
    const cancelBtn = document.getElementById('custom-modal-cancel');

    if (!overlay) return callback(false);

    const modalOptions = options && typeof options === 'object' ? options : {};
    overlay.dataset.modalKind = modalOptions.kind || (isPrompt ? 'prompt' : 'confirm');
    titleEl.innerText = title;
    msgEl.innerText = msg;
    msgEl.style.display = msg ? 'block' : 'none';
    confirmBtn.innerText = modalOptions.confirmLabel || (isPrompt ? 'Save' : 'Confirm');
    cancelBtn.innerText = modalOptions.cancelLabel || 'Cancel';

    if (isPrompt) {
        inputContainer.style.display = 'block';
        input.value = defaultValue;
    } else {
        inputContainer.style.display = 'none';
    }

    overlay.style.zIndex = String((typeof window.getModalStackZIndex === 'function' ? window.getModalStackZIndex() : 3000) + 2);
    overlay.style.display = 'flex';
    if (isPrompt) {
        window.requestAnimationFrame(() => {
            input.focus();
            if (!defaultValue) input.select?.();
        });
    }

    const overlayClickHandler = (event) => {
        if (event.target !== overlay) return;
        cancelBtn.click();
    };
    const keyHandler = (event) => {
        if (event.key === 'Escape') cancelBtn.click();
        if (!isPrompt && event.key === 'Enter') confirmBtn.click();
    };

    const cleanup = () => {
        overlay.style.display = 'none';
        overlay.style.zIndex = '';
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
        input.onkeydown = null;
        overlay.onclick = null;
        delete overlay.dataset.modalKind;
        document.removeEventListener('keydown', keyHandler);
    };

    confirmBtn.onclick = () => {
        cleanup();
        if (isPrompt) callback(input.value);
        else callback(true);
    };

    cancelBtn.onclick = () => {
        cleanup();
        callback(null);
    };

    overlay.onclick = overlayClickHandler;
    document.addEventListener('keydown', keyHandler);

    if (isPrompt) {
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.stopPropagation();
                confirmBtn.click();
            }
            if (e.key === 'Escape') {
                e.stopPropagation();
                cancelBtn.click();
            }
        };
    }
};
