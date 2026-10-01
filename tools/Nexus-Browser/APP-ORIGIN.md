# App-Origin Targets

App-Origin is Nexus Browser's desktop-application target class. It is separate from
Online-Origin browser tabs and Local-Origin terminal/CLI sessions.

The first provider is **ChatGPT App** on Windows.

## Why this is separate from ChatGPT App Mirror

ChatGPT App Mirror reuses an authenticated `chatgpt.com` browser conversation. It is
still an Online-Origin target.

App-Origin drives the actual running desktop application:

```text
Nexus Base Mode
      |
      | localhost WebSocket
      v
App-Origin controller
      |
      | Microsoft winapp CLI / Windows UI Automation
      v
ChatGPT Windows app
      |
      +--> composer text entry
      +--> Send invocation
      +--> accessible response observation
      |
      v
Nexus transcript
```

This first pass does not use a private ChatGPT API and does not require a browser tab.

## Windows automation transport

The ChatGPT adapter treats the composer and Send control as dynamic controls rather
than fixed selectors. It scores editable controls by ChatGPT semantics plus their
position/size near the bottom of the app, rejects sidebar/search fields, and only
accepts a Send candidate when it is explicitly send-like or geometrically adjacent to
the selected composer. This prevents a generic top navigation arrow from being invoked
as Send. If programmatic `set-value` is unavailable, Nexus explicitly focuses the
verified composer before using keyboard input, so it fails closed rather than typing
into whichever window happens to be foreground.

The adapter uses Microsoft's `winapp ui` automation surface. Nexus prefers UI
Automation patterns:

1. discover the running ChatGPT window;
2. inspect its accessibility tree;
3. identify the ChatGPT composer;
4. use `set-value` when the compose control supports it;
5. invoke the app's Send control;
6. fall back to targeted keyboard input only when programmatic value-setting is not
   available;
7. observe accessible response text until it is stable and generation has stopped.

The App-Origin target is published as:

- target class: `app-origin`
- target type: `desktop-app`
- provider: `chatgpt-desktop`
- provider name: `ChatGPT App`
- transport: `windows-uia-winapp`
- session origin: `existing-app`

## Required helper

Microsoft winapp CLI must be installed on the Windows host:

```powershell
winget install Microsoft.winappcli --source winget
```

Then restart Nexus Browser so the server inherits the updated PATH.

Nexus exposes a clear Base Mode diagnostic instead of silently falling back to a
browser provider when the helper is missing.

## Base Mode qualification

App-Origin is intentionally Base Mode-only in the first pass. Dex refuses App-Origin
dispatch until direct app input and reply capture are qualified on the real ChatGPT
Windows UI.

Recommended live sequence:

1. Open the ChatGPT Windows app and a disposable Eve test chat.
2. Start/restart Nexus Browser.
3. In Base Mode select **App-Origin Targets**.
4. Press **Refresh apps**.
5. Connect **ChatGPT App**.
6. Send a unique short message from the Nexus composer.
7. Verify the text appears in the native ChatGPT app and submits once.
8. Wait for the native app response.
9. Verify Nexus receives the response as `response_partial` and then
   `response_final`.
10. Press **Capture latest** and verify it returns the same assistant response.
11. Repeat once with the ChatGPT app partially occluded.
12. If `set-value` is unsupported, verify the keyboard fallback focuses only the
   ChatGPT compose surface and does not type into another app.

## Failure evidence

If the first live test fails, run:

```powershell
cd C:\Users\alvin\Documents\Workspace\RoughProjDeving\EveOS\tools\Nexus-Browser
node .\scripts\app-origin-doctor.js
```

The doctor reports helper availability, detected windows, whether the composer and Send
control are exposed, and the App-Origin diagnostics without dumping conversation text.

Useful failure codes include:

- `APP_BRIDGE_HELPER_MISSING`
- `APP_TARGET_NOT_FOUND`
- `APP_COMPOSER_NOT_FOUND`
- `APP_INPUT_FAILED`
- `APP_SEND_FAILED`
- `APP_PROMPT_UNCONFIRMED`
- `APP_RESPONSE_TIMEOUT`

The existing ChatGPT App Mirror remains available as an independent Online-Origin
fallback and as a comparison surface during qualification.
