function renderQueuePreview(preview, { state, currentIndex, nextIndex, labelFor, onPlay, onMove, onDuplicate, onRemove }) {
  preview.replaceChildren();
  const manual = state.mode === 'manual';
  const shuffle = state.mode === 'shuffle';
  let draggedId = '';

  state.items.forEach((item, itemIndex) => {
    const status = itemIndex === currentIndex ? 'current'
      : itemIndex < (Number(state.cursor) || 0) ? 'played'
        : shuffle ? 'candidate' : itemIndex === nextIndex ? 'next' : 'queued';
    const row = document.createElement('div');
    row.className = `piano-queue-preview-row ${status}`;
    row.dataset.queuePreviewStatus = status;
    row.dataset.queueId = item.queueId;
    row.setAttribute('role', 'listitem');

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'piano-queue-preview-jump';
    jump.title = status === 'played' ? 'Go back to this song' : status === 'current' ? 'Resume this song' : 'Jump to this song';
    const number = document.createElement('span'); number.textContent = `#${itemIndex + 1}`;
    const label = document.createElement('strong'); label.textContent = labelFor(item);
    const stateLabel = document.createElement('small');
    stateLabel.textContent = status === 'current' ? 'NOW' : status === 'played' ? 'PLAYED' : status === 'next' ? 'NEXT' : status === 'candidate' ? 'POSSIBLE' : 'UPCOMING';
    jump.append(number, label, stateLabel);
    jump.addEventListener('click', () => onPlay(item.queueId));
    row.append(jump);

    if (manual) {
      row.draggable = true;
      row.title = 'Drag to reorder this manual queue entry';
      row.addEventListener('dragstart', event => {
        draggedId = item.queueId;
        row.classList.add('dragging');
        event.dataTransfer?.setData('text/plain', item.queueId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => { draggedId = ''; row.classList.remove('dragging'); delete row.dataset.dropAfter; });
      row.addEventListener('dragover', event => {
        if (!draggedId || draggedId === item.queueId) return;
        event.preventDefault();
        row.dataset.dropAfter = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2 ? '1' : '0';
      });
      row.addEventListener('dragleave', () => { delete row.dataset.dropAfter; });
      row.addEventListener('drop', event => {
        event.preventDefault();
        const source = draggedId || event.dataTransfer?.getData('text/plain');
        const after = row.dataset.dropAfter === '1';
        delete row.dataset.dropAfter;
        if (source && source !== item.queueId) onMove(source, item.queueId, after);
      });

      const actions = document.createElement('div'); actions.className = 'piano-queue-preview-actions';
      const duplicate = document.createElement('button'); duplicate.type = 'button'; duplicate.textContent = '+'; duplicate.title = 'Add another copy immediately after this entry';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '−'; remove.title = 'Remove this exact queue entry';
      duplicate.addEventListener('click', () => onDuplicate(item.queueId));
      remove.addEventListener('click', () => onRemove(item.queueId));
      actions.append(duplicate, remove); row.append(actions);
    }
    preview.append(row);
  });
}

export { renderQueuePreview };
