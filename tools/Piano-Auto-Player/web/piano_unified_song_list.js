export function enhanceSongListDisclosure(planner, savedCollapsed, saveCollapsed) {
  const results = planner?.querySelector('.planner-results');
  const list = results?.querySelector('[data-p-list]');
  if (!results || !list || results.querySelector(':scope > .piano-song-list-head')) return;

  results.classList.add('piano-song-list-panel');
  const head = document.createElement('header');
  head.className = 'piano-song-list-head';
  head.innerHTML = `
    <div class="piano-song-list-copy">
      <strong>SONGS</strong>
      <small>Browse the filtered library and manage its queue entries.</small>
    </div>
    <button type="button" class="ghost small" data-u-song-list-toggle aria-label="Toggle songs list">Collapse</button>`;
  results.prepend(head);

  const button = head.querySelector('[data-u-song-list-toggle]');
  const apply = collapsed => {
    results.dataset.uCollapsed = collapsed ? '1' : '0';
    button.textContent = collapsed ? 'Expand' : 'Collapse';
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    saveCollapsed('song-list', collapsed);
  };
  apply(savedCollapsed('song-list', false));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    apply(results.dataset.uCollapsed !== '1');
  });
}
