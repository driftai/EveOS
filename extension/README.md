# EveOS Bridge

One popup includes Nexus Browser/Dex, WatchFusion Media Link, and Tab URLs. Each tool also remains independently installable from its own extension directory.

## Install locally

Run `npm run build:eveos-extension` in EveOS. In `chrome://extensions` or `edge://extensions`, enable Developer mode and load this root `extension` directory. After an update, rebuild and press Reload on the extension card. Refresh existing provider tabs once so they receive the new content scripts. Once Nexus shows connected and WatchFusion links through EveOS, separate companions may be disabled or removed.

Click the EveOS Bridge toolbar button for the popup, then choose **Tools**, **WatchFusion**, or **Tab URLs**. No side panel or side-panel permission is used. WatchFusion's private pairing controls stay inside the popup; Nexus/Dex runs through the included Nexus transport. Opening Bridge on the playing source tab grants Chrome's required active-tab capture authority to EveOS itself; another extension is unnecessary. Optional embedded-player access enables probing cross-origin frames. Protected media and inaccessible/custom players still depend on the site's browser interfaces.

**Tab URLs** collects only the originating browser window when you press Collect. It preserves tab order and duplicates, supports Copy and `.txt` export, and clears on popup close. That module makes no AI calls, uploads, history writes, or remote-font requests. Bridge's separate Nexus/WatchFusion modules retain their own intentional transport behavior.

## One source, two packages

WatchFusion's **Open EveOS extension folder** action prepares the shared package automatically. The build command is also available for manual setup and updates; no companion installation is needed for the official package.

`modules.json` declares canonical tool sources, worker entries, and optional popup pages/labels. `manifest.base.json` owns the stable Bridge identity and shell. `tools/extensions/assemble.cjs` composes manifest permissions/content scripts and assembles unchanged assets into ignored `extension/modules/`. These are packaging artifacts, never another maintained implementation. A tool fix applies to both packages on the next build. The assembler verifies every declared content/popup asset and rejects unsafe paths or duplicate module IDs. Declared tool popup pages automatically appear as tabs; included tools open there rather than launching another panel.

`bridge-surfaces.css` supplies a shared presentation layer to same-origin included panels: rounded controls, compact spacing, keyboard focus, and slim themed scrollbars. It changes neither canonical standalone assets nor website content, permissions, or tool behavior. The browser still owns the popup's toolbar anchor and outer native frame.

The painted surface belongs to `#popupShell` and meets Chrome's rectangular frame directly, with a continuous low-contrast gradient and a faint top highlight. Rounded controls and content panels stay inside; avoid an inset bezel, black corner cutouts, or multiple perimeter outlines. Keep `html` and `body` backgrounds transparent so this single surface owns the finish. Browser checks inspect opaque, smoothly matched corner pixels and stable full-bleed geometry; they do not claim to reshape Chrome's native window border.

About/setup, Local services, Browser tools, their individual cards, and WatchFusion's setup drawer are collapsible. Their last expanded/collapsed choices persist as boolean-only `eveosBridgeExpandedV1:` keys in `chrome.storage.local`; refreshing status or reopening Bridge does not reset them. This is local UI state, not repository data, and contains no URLs, chats, pairing links, or room contents.

Opening Nexus explicitly starts its existing managed runtime when needed, verifies branded readiness, then opens or focuses its dashboard. Merely opening Bridge or refreshing status never starts a service. Local Control allows only the stable Bridge origin to call Nexus's Start route, from loopback without forwarded/share headers; other extension lifecycle operations remain forbidden. Standalone Nexus can open an already-running dashboard; startup remains in EveOS unless the approved Bridge performs it.

`npm run audit:eveos-extension` checks the composed manifest. Add `-- --assets` to verify local assembled files against their sources. New first-party tools add a module declaration and narrow connector rather than tool-specific logic in the hub.

Standalone directories: `tools/Nexus-Browser/extension`, `tools/WatchFusion/browser-extension`, and `tools/Tab-Collector/extension`.

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
