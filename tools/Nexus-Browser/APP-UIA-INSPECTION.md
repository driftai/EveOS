# App UIA Inspection Workflow

Use this workflow before changing selectors, geometry heuristics, or reply parsing for a
Windows desktop application.

## Live information grab

From `tools/Nexus-Browser`:

```powershell
npm run diagnose:app-ui -- --app "ChatGPT" --contains "NOVA_" --include-offscreen
```

Useful options:

- `--app <text>`: required window title/process query.
- `--contains <text>`: repeatable text filter; prefer narrow unique markers.
- `--include-offscreen`: include virtualized/offscreen accessibility nodes.
- `--depth <n>`: inspect depth, default 12.
- `--max <n>`: maximum matching nodes printed, default 120.

The report includes HWND/PID/title, the authoritative window frame, total UIA element
count, and matching nodes with control type, text, selector, absolute rectangle, and
relative x/y/width/height ratios.

## Coordinate rule

UIA rectangles are desktop-absolute. Do not compute relative positions from a target
object that contains only HWND/PID/title. If the inspect tree exposes a root `Window`
node, its rectangle is the authoritative frame.

## Diagnostic order

1. Put a unique marker in the live application and leave it visible.
2. Run the UIA info grab with `--contains <marker>`.
3. Confirm the marker appears and record its type/selector/rectangle.
4. Compare user/input and assistant/output positions using relative geometry.
5. Only then modify provider-specific correlation rules.
6. Add a regression fixture copied from the real live shape.
7. Run `npm run smoke:app-ui-info` plus the provider qualification gate.

Do not infer UIA tree order from visual order. Do not infer control type from appearance.
Do not broaden selectors until the live accessibility evidence requires it.

## Deterministic smoke

```powershell
npm run smoke:app-ui-info
```

The smoke reproduces a window whose target metadata omits x/y while its UIA nodes use
absolute desktop coordinates. It fails if the tooling stops recovering the root Window
origin or computes incorrect relative geometry.
