'use strict';
const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
const sourceWindow = chrome.windows.getCurrent();
const requestedWindow = new URLSearchParams(location.search).get('windowId');
let busy = false;
async function windowId() {
  const own = await sourceWindow;
  if (requestedWindow !== null && !/^\d+$/.test(requestedWindow)) throw new Error('No browser window selected.');
  const id = requestedWindow === null ? own.id : Number(requestedWindow);
  if (!Number.isInteger(id) || id < 0) throw new Error('No browser window selected.');
  return id;
}
function controls() {
  const hasText = Boolean($('urls').value.trim());
  for (const id of ['copy', 'open', 'export', 'clear']) $(id).disabled = busy || !hasText;
  $('collect').disabled = busy; $('urls').readOnly = busy;
}
$('urls').addEventListener('input', () => { controls(); status($('urls').value.trim() ? 'Ready to copy, open or save.' : 'No URLs.'); });
$('collect').onclick = async () => {
  if (busy) return; busy = true; controls();
  try {
    const result = await EveOSTabCollector.collect(chrome, await windowId());
    $('urls').value = result.text; controls();
    status(`Collected ${result.count} of ${result.total} tabs from this window.`);
  } catch (_error) {
    status('Could not read this window. Existing text kept; reopen the popup and try again.');
  } finally { busy = false; controls(); }
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('urls').value); status('URLs copied.'); }
  catch (_error) { $('urls').focus(); $('urls').select(); status('Copy was blocked. Press Ctrl+C to copy the selected URLs.'); }
};
$('open').onclick = async () => {
  if (busy || !$('urls').value.trim()) return;
  const text = $('urls').value; busy = true; controls(); status('Opening URLs in this window…');
  try {
    const result = await EveOSTabCollector.open(chrome, await windowId(), text);
    status(`Opened ${result.opened} ${result.opened === 1 ? 'tab' : 'tabs'} in this window.${result.invalid ? ` Skipped ${result.invalid} invalid/unsupported.` : ''}${result.failed ? ` ${result.failed} could not be opened.` : ''}`);
  } catch (error) { status(error?.message || 'Could not open URLs.'); }
  finally { busy = false; controls(); }
};
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([$('urls').value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'eveos-tab-urls.txt';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); status('URL text exported.');
};
$('clear').onclick = () => { $('urls').value = ''; controls(); status('Cleared.'); };
