# EveOS Official Extension

One install includes Nexus Browser/Dex and WatchFusion Media Link. Each tool also remains independently installable from its own extension directory.

## Install locally

Run `npm run build:eveos-extension` in EveOS. In `chrome://extensions` or `edge://extensions`, enable Developer mode and load this root `extension` directory. After an update, rebuild and press Reload on the extension card. Refresh existing provider tabs once so they receive the new content scripts. Once Nexus shows connected and WatchFusion links through EveOS, separate companions may be disabled or removed.

Click the EveOS toolbar button on the playing source tab to connect WatchFusion with its private pairing link. Nexus/Dex runs through the included Nexus transport. **Extension Hub** opens the side panel. This click grants Chrome's required active-tab capture authority to EveOS itself; another extension is unnecessary. Optional embedded-player access enables probing cross-origin frames. Protected media and inaccessible/custom players still depend on the site's browser interfaces.

## One source, two packages

WatchFusion's **Open EveOS extension folder** action prepares the shared package automatically. The build command is also available for manual setup and updates; no companion installation is needed for the official package.

`modules.json` declares canonical tool sources and worker entries. `manifest.base.json` owns the official identity and shell. `tools/extensions/assemble.cjs` composes manifest permissions/content scripts and assembles unchanged assets into ignored `extension/modules/`. These are packaging artifacts, never another maintained implementation. A tool fix applies to both packages on the next build. The assembler verifies every declared content asset and rejects unsafe paths or duplicate module IDs.

`npm run audit:eveos-extension` checks the composed manifest. Add `-- --assets` to verify local assembled files against their sources. New first-party tools add a module declaration and narrow connector rather than tool-specific logic in the hub.

Standalone directories: `tools/Nexus-Browser/extension` and `tools/WatchFusion/browser-extension`.

## Connector protocol

Included modules and additional companions use the versioned `eveos.extension.v1` contract.

A future EveOS companion should listen on `chrome.runtime.onMessageExternal` for `{ channel: "eveos.extension.v1", version: 1 }` and support:

- `describe`: return its stable connector ID, display name, safe capability labels, dashboard URL, and non-sensitive status.
- `status`: return current non-sensitive availability.
- `open`: open its own local dashboard or extension-owned UI.
- `invoke`: run an optional declarative companion action exposed by `describe.actions`. The hub renders those actions generically and forwards them; the companion still owns the implementation and permissions.

Included tools register the same handler in-process. Standalone tools expose it through `chrome.runtime.onMessageExternal`, allowlisted to the stable official extension ID. Each module has its own ID even when several share the official extension identity.


## Standalone + hub rule

Every specialized companion remains a complete standalone extension. Included tools need no discovery permission. Additional companion discovery asks for optional `management` permission. Nexus owns authenticated provider transport and WatchFusion owns explicit media capture. Pairing tokens, selected targets, and browser state stay in local extension storage rather than the repository.

Automated package/browser checks cover worker boot, included tools, adapter registration, capture routing/cropping, room unload, and standalone behavior. Real account dispatch, browser-authorized capture clicks, physical speakers, protected third-party media, and a second physical LAN device require live evidence. A synthetic fixture never proves a particular third-party site works.
