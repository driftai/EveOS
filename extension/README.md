# EveOS Official Extension

This root-level Manifest V3 extension is the browser-wide EveOS hub. It does not replace specialized companions such as Nexus Browser or WatchFusion Media Link. It discovers those companions through the versioned `eveos.extension.v1` message contract, summarizes their safe capabilities, checks registered EveOS localhost services, and opens each tool from one persistent side panel.

## Install locally

Open `chrome://extensions` or `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select this `extension` directory. Clicking the toolbar action opens the EveOS Extension Hub side panel.

Companion discovery is optional. Chrome/Edge asks before granting the `management` permission, which the hub uses only to enumerate installed extension names and IDs and probe the EveOS connector contract. The hub does not read browsing history, page contents, provider conversations, cookies, or credentials.

## Connector protocol

A future EveOS companion should listen on `chrome.runtime.onMessageExternal` for `{ channel: "eveos.extension.v1", version: 1 }` and support:

- `describe`: return its stable connector ID, display name, safe capability labels, dashboard URL, and non-sensitive status.
- `status`: return current non-sensitive availability.
- `open`: open its own local dashboard or extension-owned UI.

Companions remain responsible for their own permissions, content scripts, authenticated sessions, and lifecycle. The hub deliberately does not absorb those privileges.
