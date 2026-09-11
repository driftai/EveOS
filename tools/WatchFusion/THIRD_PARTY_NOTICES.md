# WatchFusion Third-Party Notices

WatchFusion is an EveOS integration that builds on and interoperates with upstream open-source projects. This file records the upstream projects that are most directly relevant to the WatchFusion media/watch-party wrapper.

## WatchParty

- Upstream: https://github.com/howardchung/watchparty
- Author / copyright notice: Copyright (c) 2020 Howard Chung
- Upstream license: MIT License

WatchFusion's synchronized watch-party behavior was built from and adapted around concepts and code originating in Howard Chung's WatchParty project. The upstream MIT license and copyright notice apply to upstream-derived portions.

## Nuvio

- Historical repository URL used by earlier WatchFusion documentation: https://github.com/NuvioMedia/NuvioWeb
- Current canonical Smart TV / web repository used by WatchFusion setup: https://github.com/NuvioMedia/NuvioTVSmart
- Upstream license: GNU General Public License v3.0 (GPL-3.0)

Nuvio is **not vendored as tracked EveOS source**. WatchFusion installs or uses a user-provided Nuvio tree under `nuvio/` (or `NUVIO_PATH`), and that runtime tree is excluded from EveOS Git tracking except for the placeholder `nuvio/.gitkeep`. Nuvio remains governed by its upstream license.

## VoxelVision

VoxelVision is maintained as an EveOS/WatchFusion component under `tools/WatchFusion/voxelvision/`. Its source/provenance and any applicable third-party notices should be preserved alongside that component; this notice does not assign a new license to third-party material inside VoxelVision.

## License scope

The EveOS repository's own license does not replace licenses that apply to third-party or upstream-derived code. When redistributing WatchFusion or an installed Nuvio build, review the applicable upstream license files and notices as well as EveOS's own license.
