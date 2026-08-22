import { CONFIG } from "./core/config.js";
import { createSettingsStore } from "./core/settings-store.js";
import { createWorldPortal } from "./world/world-portal.js";
import { WORLD_PORTAL_STATE_EVENT } from "./world/world-events.js";
import { createWorldAutosave } from "./world/world-autosave.js";
import { createScene } from "./scene/create-scene.js";
import { wireUi } from "./ui/controls.js";
import { createGeographyController } from "./ui/geography-controller.js";
import { createCountryGeographyController } from "./ui/country-geography-controller.js";
import { createWorldManager } from "./ui/world-manager.js";
import { createControlGroups } from "./ui/control-groups.js";
import { createLandmassPanel } from "./ui/landmass-panel.js";
import { createHeightmapForge } from "./heightmap/heightmap-forge-controller.js";
import { createOrogenLab } from "./refinement/orogen-lab-controller.js";
import { createCelestialManager } from "./ui/celestial-manager.js";
import { createEveGuidedMode } from "./eve/eve-guided-controller.js";
import { createRefinementMissionMode } from "./mission/refinement-mission-controller.js";
import { createMissionOrchestrator } from "./mission/eve-mission-orchestrator.js";
import { createOuterToolPort } from "./outer/outer-tool-port-controller.js";

// Outer tools are embedded in a same-origin frame, and they carry their own
// root-relative navigation. Orogen links home with href="/", which resolves to
// World Portal's own root rather than the tool's, so following it inside the
// embedded frame would load World Portal into itself: a second full instance
// with a second WebGL globe and a duplicated control panel.
//
// World Book also embeds World Portal intentionally, so iframe presence alone
// is not enough to identify recursion. World Book marks its Portal frame with
// ?embedded=world-book; only unmarked framed loads are treated as the nested
// outer-tool fallback.
const embedMode = new URLSearchParams(window.location.search).get("embedded");
const isNestedPortal = window.self !== window.top && embedMode !== "world-book";

if (isNestedPortal) {
  const notice = document.createElement("div");
  notice.className = "nested-portal-notice";
  const heading = document.createElement("h1");
  heading.textContent = "World Portal is already open";
  const body = document.createElement("p");
  body.textContent = "The embedded tool navigated back to World Portal. "
    + "Reopen the tool to continue where you were.";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Return to the tool";
  back.addEventListener("click", () => window.location.replace("outer/orogen/import.html"));
  notice.append(heading, body, back);
  document.body.replaceChildren(notice);
} else {

const settingsStore = createSettingsStore(CONFIG.defaults);
const persistedSettings = settingsStore.load();

const state = {
  ...persistedSettings,
  selectedContinentId: null,
  selectedCountryCode: null,
};

const portal = createWorldPortal(state);
const viewport = document.getElementById("viewport");
const loading = document.getElementById("loading");
const loadingDetail = document.getElementById("loadingDetail");
const errorPanel = document.getElementById("errorPanel");
const errorMessage = document.getElementById("errorMessage");

function setPanelHidden(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
  element.style.display = hidden ? "none" : "";
}

setPanelHidden(errorPanel, true);

try {
  await portal.initialize();
  const activeViewState = portal.getActiveViewState();
  if (Object.keys(activeViewState).length) Object.assign(state, activeViewState);
  else portal.updateActiveViewState(state);

  const sceneApi = await createScene(viewport, state, (fraction) => {
    if (loadingDetail) {
      loadingDetail.textContent =
        `Opening ${portal.getActiveWorld().name} in World Portal… ${Math.round(fraction * 100)}%`;
    }
  }, portal.getActiveSurface(), portal.getActiveWorld().metadata.celestialBodies);

  const uiApi = wireUi(state, sceneApi, {
    onResetSettings() {
      settingsStore.clear();
      window.location.reload();
    },
  });
  // wireUi assigns every section's stable key before the existing sections are
  // moved into groups. Moving nodes preserves their IDs and bound listeners.
  const syncControlGroups = createControlGroups(state);
  uiApi.addStateSync(syncControlGroups);
  sceneApi.applyState(state);

  const countryGeography = createCountryGeographyController(state, portal);
  const geography = createGeographyController(
    sceneApi, state, uiApi, countryGeography, portal,
  );
  const autosave = createWorldAutosave({ portal, state });
  const worldManager = createWorldManager({ portal, state, sceneApi, uiApi, autosave });
  const heightmapForge = createHeightmapForge({ portal, state, autosave });
  const celestialManager = createCelestialManager({ portal, sceneApi, autosave });
  const orogenLab = createOrogenLab({ portal, state, sceneApi, autosave });
  const landmassPanel = createLandmassPanel({
    portal, orogenLab, state, autosave,
  });
  if (landmassPanel) uiApi.addStateSync(landmassPanel.syncFromState);
  const missionOrchestrator = createMissionOrchestrator({
    portal, autosave, orogenLab, heightmapForge, sceneApi,
  });
  const eveGuided = createEveGuidedMode({
    portal, state, autosave, heightmapForge, orogenLab, missionOrchestrator, sceneApi,
  });
  const refinementMission = createRefinementMissionMode({
    portal, sceneApi, autosave, heightmapForge, orogenLab, eveGuided, missionOrchestrator,
  });
  // Outer tools are created last and never awaited: a missing or failed outer
  // tool must not affect world rendering, geography, Forge, or the Lab.
  let outerToolPort = null;
  try {
    outerToolPort = createOuterToolPort({ portal, orogenLab, autosave, sceneApi });
  } catch (error) {
    console.warn("Outer tool port unavailable:", error);
  }
  // Capture first-run section/group defaults after every UI factory has had a
  // chance to normalize state, without marking the active world as edited.
  portal.updateActiveViewState(state, { markDirty: false });
  settingsStore.saveNow(state);
  const persistState = (event) => {
    const key = event.detail?.key;
    const ownershipOnly = new Set([
      "activeWorldId", "worldLibrary", "activeWorldMetadata", "worldAssets",
      "worldSaveState", "worldSurface", "celestialSystem", "worldViewState",
    ]);
    if (key === "worldAssets") autosave.schedule("World-owned layers changed");
    else if (!ownershipOnly.has(key)) {
      portal.updateActiveViewState(state, { markDirty: true });
      autosave.schedule("World view settings changed");
    }
    settingsStore.scheduleSave(state);
  };
  window.addEventListener(WORLD_PORTAL_STATE_EVENT, persistState);
  setPanelHidden(loading, true);

  const developerApi = {
    portal,
    state,
    sceneApi,
    geography,
    countryGeography,
    worldManager,
    heightmapForge,
    celestialManager,
    orogenLab,
    landmassPanel,
    eveGuided,
    agentSkill: eveGuided.agentSkill,
    missionOrchestrator,
    refinementMission,
    outerToolPort,
    autosave,
    describe: portal.describe,
  };
  Object.defineProperties(developerApi, {
    world: { enumerable: true, get: () => portal.getActiveWorld() },
    worlds: { enumerable: true, get: () => portal.getWorlds() },
  });
  window.WorldPortal = developerApi;
} catch (error) {
  console.error(error);
  setPanelHidden(loading, true);

  if (errorPanel) errorPanel.hidden = false;
  if (errorMessage) {
    errorMessage.textContent = error?.message || String(error);
  }
}

}
