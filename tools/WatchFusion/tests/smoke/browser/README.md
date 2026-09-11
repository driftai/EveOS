# Playwright Browser Smoke Layer

Playwright end-to-end tests against the real WatchFusion UI.

Core scenarios: lobby render, room creation/join, host/viewer contexts, room-link navigation, chat, source loading and ready state, play/pause/seek synchronization, late join state, connection/reconnect behavior, and regression coverage preventing the old continuous 5-second forced-seek behavior.

Playwright launches and manages the local WatchFusion server. Screenshots and traces are captured on failures, while live YouTube dependence stays outside the deterministic baseline suite.
