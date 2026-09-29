'use strict';
const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
const sourceWindow = chrome.windows.getCurrent();
const requestedWindow = new URLSearchParams(location.search).get('windowId');

function controls() {
  for (const id of ['copy', 'export', 'clear']) $(id).disabled = !$('urls').value;
}
$('collect').onclick = async () => {
  $('collect').disabled = true;
  try {
    const ownWindow = await sourceWindow;
    const windowId = requestedWindow === null ? ownWindow.id : Number(requestedWindow);
    const result = await EveOSTabCollector.collect(chrome, windowId);
    $('urls').value = result.text; controls();
    status(`Collected ${result.count} of ${result.total} tabs from this window.`);
  } catch (_error) {
    $('urls').value = ''; controls();
    status('Could not read this window. Reopen the popup and try again.');
  } finally { $('collect').disabled = false; }
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('urls').value); status('URLs copied.'); }
  catch (_error) { $('urls').focus(); $('urls').select(); status('Copy was blocked. Press Ctrl+C to copy the selected URLs.'); }
};
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([$('urls').value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'eveos-tab-urls.txt';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); status('URL text exported.');
};
$('clear').onclick = () => { $('urls').value = ''; controls(); status('Cleared.'); };
