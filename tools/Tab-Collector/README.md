# EveOS Tab Collector

Load `extension/` inside this tool as an unpacked Chrome/Edge extension, or use **Tab URLs** in EveOS Bridge. Both packages assemble the same source files.

Press **Collect this window** to list all readable tab URLs in tab-strip order. Duplicates and internal/file URLs are retained; other windows are excluded. Copy, save a `.txt` file, or clear the result. Nothing is collected on startup or saved between popup sessions.

The standalone extension requests only `tabs`, which Chrome requires to read URLs across sites. It has no AI, host access, content injection, storage, analytics, network requests, or remote fonts. The connector shares only a capability description and opens the local collector UI; it never exposes collected URLs to another extension. Existing Nexus/WatchFusion functionality in Bridge retains its separate network and permission behavior.

URLs can contain sensitive query strings or private page names. Copy/export is explicit; keep exported lists out of repositories and public chats unless you intend to share them.
