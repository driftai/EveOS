'use strict';

const protocol = globalThis.EveOSExtensionProtocol;
const servicesHost = document.querySelector('[data-services]');
const connectorsHost = document.querySelector('[data-connectors]');
const status = document.querySelector('[data-status]');

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function serviceCard(item) {
  const detail = item.online ? (item.detail?.message || 'Ready') : 'Not running';
  return `<article class="card"><strong>${escapeHtml(item.name)}</strong><span class="badge ${item.online ? 'online' : ''}">${item.online ? 'ONLINE' : 'OFFLINE'}</span><small>${escapeHtml(detail)}</small><button type="button" data-open-service="${escapeHtml(item.id)}">Open</button></article>`;
}

function connectorCard(item) {
  const capabilities = item.capabilities.length ? item.capabilities.join(' · ') : 'Connector protocol ready';
  const actions = (item.actions || []).map(action => {
    const input = action.input?.kind === 'text'
      ? `<input data-connector-input="${escapeHtml(item.extensionId)}:${escapeHtml(item.id)}:${escapeHtml(action.id)}" placeholder="${escapeHtml(action.input.placeholder || '')}" aria-label="${escapeHtml(action.label)} input">`
      : '';
    return `<div class="connector-action">${input}<button type="button" data-invoke-connector="${escapeHtml(item.extensionId)}" data-connector-id="${escapeHtml(item.id)}" data-action-id="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>${action.description ? `<small>${escapeHtml(action.description)}</small>` : ''}</div>`;
  }).join('');
  return `<article class="card connector-card"><strong>${escapeHtml(item.name)}</strong><span class="badge online">${item.integration === 'included' ? 'INCLUDED' : 'CONNECTED'}</span><small>${escapeHtml(capabilities)}</small><button type="button" data-open-connector="${escapeHtml(item.extensionId)}" data-connector-id="${escapeHtml(item.id)}">Open tool</button>${actions ? `<div class="connector-actions">${actions}</div>` : ''}</article>`;
}

function render(snapshot) {
  servicesHost.innerHTML = (snapshot.services || []).map(serviceCard).join('') || '<div class="empty">No EveOS services registered.</div>';
  connectorsHost.innerHTML = (snapshot.connectors || []).map(connectorCard).join('')
    || '<div class="empty">No companion extensions discovered yet.</div>';
  status.textContent = `Updated ${new Date(snapshot.generatedAt || Date.now()).toLocaleTimeString()}`;
}

async function send(type, detail = {}) {
  return chrome.runtime.sendMessage({ channel: protocol.UI_CHANNEL, type, ...detail });
}

async function refresh(type = 'refresh') {
  status.textContent = type === 'scan' ? 'Discovering EveOS companions...' : 'Refreshing EveOS...';
  const result = await send(type);
  if (!result?.ok) throw new Error(result?.message || result?.code || 'Extension Hub request failed.');
  render(result.snapshot);
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.action === 'refresh') await refresh();
    else if (target.dataset.action === 'discover') {
      const granted = await chrome.permissions.request({ permissions: ['management'] });
      if (!granted) throw new Error('Companion discovery permission was not granted.');
      await refresh('scan');
    } else if (target.dataset.openService) {
      await send('open-service', { id: target.dataset.openService });
    } else if (target.dataset.openConnector) {
      const result = await send('open-connector', { extensionId: target.dataset.openConnector, id: target.dataset.connectorId });
      if (!result?.ok) throw new Error(result?.message || result?.code || 'Companion could not be opened.');
    } else if (target.dataset.invokeConnector) {
      const extensionId = target.dataset.invokeConnector;
      const action = target.dataset.actionId;
      const id = target.dataset.connectorId;
      const selector = `[data-connector-input="${CSS.escape(extensionId)}:${CSS.escape(id)}:${CSS.escape(action)}"]`;
      const input = document.querySelector(selector);
      const result = await send('invoke-connector', { extensionId, id, action, value: input?.value || '' });
      if (!result?.ok) throw new Error(result?.message || result?.code || 'Companion action failed.');
      status.textContent = result.detail?.message || 'Companion action completed.';
    }
  } catch (error) {
    status.textContent = error?.message || String(error);
  }
});

void refresh().catch(error => { status.textContent = error?.message || String(error); });
