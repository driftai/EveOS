# WatchFusion Third-Party Notices

WatchFusion is an EveOS integration that builds on and interoperates with upstream open-source projects. This file records the upstream projects that are most directly relevant to the WatchFusion media/watch-party wrapper.

## WatchParty

- Upstream: https://github.com/howardchung/watchparty
- Author / copyright notice: Copyright (c) 2020 Howard Chung
- Upstream license: MIT License

WatchFusion's synchronized watch-party behavior was built from and adapted around concepts and code originating in Howard Chung's WatchParty project. The upstream MIT license and copyright notice apply to upstream-derived portions.

### WatchParty MIT License

Copyright (c) 2020 Howard Chung

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Nuvio

- Historical repository URL used by earlier WatchFusion documentation: https://github.com/NuvioMedia/NuvioWeb
- Current canonical Smart TV / web repository used by WatchFusion setup: https://github.com/NuvioMedia/NuvioTVSmart
- Upstream license: GNU General Public License v3.0 (GPL-3.0)

Nuvio is **not vendored as tracked EveOS source**. WatchFusion installs or uses a user-provided Nuvio tree under `nuvio/` (or `NUVIO_PATH`), and that runtime tree is excluded from EveOS Git tracking except for the placeholder `nuvio/.gitkeep`. Nuvio remains governed by its upstream license.

## VoxelVision

VoxelVision is maintained as an EveOS/WatchFusion component under `tools/WatchFusion/voxelvision/`. Its source/provenance and any applicable third-party notices should be preserved alongside that component; this notice does not assign a new license to third-party material inside VoxelVision.

## License scope

The EveOS repository's own license does not replace licenses that apply to third-party or upstream-derived code. When redistributing WatchFusion or an installed Nuvio build, review the applicable upstream license files and notices as well as EveOS's own license.
