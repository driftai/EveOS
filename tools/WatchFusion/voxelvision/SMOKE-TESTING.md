# VoxelVision Smoke Testing

`npm run --silent verify` is intentionally quiet: one summary line on success, bounded failure context on error, and a complete machine-readable artifact at `test-results/voxelvision-verify.json`.

Use the narrowest affected smoke while developing. Use the full verification command once before commit/push.

```powershell
node scripts/depth-cache-smoke.mjs
npm run --silent verify
npm run --silent verify:verbose # only when detailed passing output is genuinely needed
```

Passing suites must not dump unchanged tensors, DOM, JSON responses, or per-assertion logs. A failing suite should identify a stable test ID and keep terminal context below 40 lines; larger evidence belongs in the ignored artifact directory. This makes terminal output useful to people without spending model context on repeated success noise.
