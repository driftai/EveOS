const WATCHFUSION_MODEL_STATUS_KEY = 'voxelvision.model-ready-v1';
let setupHealthState = null;
let setupHealthBusy = false;

function readVoxelModelStatus() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHFUSION_MODEL_STATUS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function setupStateLabel(component) {
  if (component?.ready === true) return 'Ready';
  if (component?.ready === false) return 'Needs setup';
  return 'On demand';
}

function setupCard(label, state, message, { action = null, disabled = false } = {}) {
  const card = document.createElement('article');
  card.className = `setup-card setup-${String(state || 'unknown').toLowerCase().replace(/\s+/g, '-')}`;
  const head = document.createElement('div');
  head.className = 'setup-card-head';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const badge = document.createElement('span');
  badge.className = 'setup-state';
  badge.textContent = state;
  head.append(strong, badge);
  const text = document.createElement('p');
  text.textContent = message || '';
  card.append(head, text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary setup-action';
    button.dataset.setupInstall = action;
    button.disabled = Boolean(disabled);
    button.textContent = state === 'Ready' ? 'Update / Repair' : 'Install / Repair';
    card.append(button);
  }
  return card;
}

function setupModelCard(model, browserStatus) {
  const readyAt = browserStatus?.[model.key]?.readyAt || null;
  const ready = Boolean(readyAt);
  const state = ready ? 'Ready' : 'On demand';
  const message = ready
    ? `Last loaded successfully in this browser ${new Date(readyAt).toLocaleString()}. Browser cache is expected to retain the model.`
    : `${model.name} downloads automatically the first time this browser uses it${model.optional ? ' (optional)' : ''}.`;
  return setupCard(model.name, state, message);
}

function renderSetupHealth() {
  const grid = $('setupHealthGrid');
  const summary = $('setupHealthSummary');
  const installAll = $('setupInstallAllBtn');
  if (!grid || !summary) return;
  grid.replaceChildren();

  if (!setupHealthState) {
    summary.textContent = 'Checking local setup…';
    return;
  }

  const components = setupHealthState.components || {};
  const canInstall = setupHealthState.canInstall === true;
  const installing = setupHealthState.installing;
  const browserModels = readVoxelModelStatus();

  for (const key of ['runtime', 'nuvio', 'voxelvision', 'voxelYoutube']) {
    const component = components[key];
    if (!component) continue;
    grid.append(setupCard(
      component.label || key,
      setupStateLabel(component),
      component.message,
      {
        action: component.action,
        disabled: setupHealthBusy || Boolean(installing) || !canInstall
      }
    ));
  }

  for (const model of components.browserModels?.models || []) {
    grid.append(setupModelCard(model, browserModels));
  }

  const missingRecommended = components.nuvio?.ready !== true || components.voxelYoutube?.ready !== true;
  if (installAll) {
    installAll.hidden = !missingRecommended;
    installAll.disabled = !canInstall || setupHealthBusy || Boolean(installing);
  }

  if (installing) {
    summary.textContent = `Installing ${installing}… keep this tab open.`;
  } else if (!canInstall) {
    summary.textContent = setupHealthState.localRequest
      ? 'Status is available, but integrated installers require Windows.'
      : 'Status is visible here; installation actions are host-machine only.';
  } else if (setupHealthState.recommendedReady) {
    summary.textContent = 'Recommended WatchFusion components are ready. AI models remain browser-on-demand.';
  } else {
    summary.textContent = 'One or more recommended components can be installed or repaired from here.';
  }
}

async function refreshSetupHealth() {
  try {
    const response = await fetch(apiUrl('/api/setup/status'), { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Setup status failed (${response.status})`);
    setupHealthState = payload;
  } catch (error) {
    setupHealthState = {
      ok: false,
      components: {},
      canInstall: false,
      localRequest: false,
      error: error?.message || 'Setup status unavailable.'
    };
  }
  renderSetupHealth();
  return setupHealthState;
}

async function runSetupInstall(component) {
  if (setupHealthBusy) return;
  setupHealthBusy = true;
  renderSetupHealth();
  try {
    const response = await fetch(apiUrl('/api/setup/install'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ component })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Installer failed (${response.status})`);
    setupHealthState = payload;
    setStatus(payload.message || 'Setup completed.');
  } catch (error) {
    setStatus(error?.message || 'Setup failed.');
    alert(error?.message || 'Setup failed.');
  } finally {
    setupHealthBusy = false;
    await refreshSetupHealth();
  }
}

function setSetupPanelOpen(open) {
  const panel = $('setupPanel');
  if (!panel) return;
  panel.hidden = !open;
  $('setupHealthBtn')?.setAttribute('aria-expanded', String(open));
  if (open) refreshSetupHealth();
}

function bindSetupHealth() {
  $('setupHealthBtn')?.addEventListener('click', () => setSetupPanelOpen($('setupPanel')?.hidden !== false));
  $('setupCloseBtn')?.addEventListener('click', () => setSetupPanelOpen(false));
  $('setupRefreshBtn')?.addEventListener('click', refreshSetupHealth);
  $('setupInstallAllBtn')?.addEventListener('click', () => runSetupInstall('all'));
  $('setupHealthGrid')?.addEventListener('click', event => {
    const action = event.target.closest('[data-setup-install]')?.dataset.setupInstall;
    if (action) runSetupInstall(action);
  });
}

window.addEventListener('storage', event => {
  if (event.key === WATCHFUSION_MODEL_STATUS_KEY && $('setupPanel')?.hidden === false) renderSetupHealth();
});

bindSetupHealth();
window.watchFusionSetupHealth = Object.freeze({
  refresh: refreshSetupHealth,
  open: () => setSetupPanelOpen(true),
  install: runSetupInstall
});
