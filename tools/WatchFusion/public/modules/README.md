# Browser Modules

This directory contains focused browser-side modules. Keep `public/app.js` as a thin composition root.

Planned responsibilities are documented in `../MODULARIZATION-MAP.md`:
state, storage, room API, transport/reconnect, YouTube player lifecycle, playback synchronization, UI, and share-link/network helpers.

Do not create a new large catch-all module. New functionality must have a clear owner and stay below the 450-line source ceiling.