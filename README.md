# hyprmnesia

[![CI](https://github.com/hyprmnesia/hyprmnesia/actions/workflows/ci.yml/badge.svg)](https://github.com/hyprmnesia/hyprmnesia/actions/workflows/ci.yml)
[![Release](https://github.com/hyprmnesia/hyprmnesia/actions/workflows/release.yml/badge.svg)](https://github.com/hyprmnesia/hyprmnesia/actions/workflows/release.yml)

> Personal memory of everything you've seen and heard, queryable via MCP.

Hyprmnesia is a simple local-first desktop capture tool. It records screen snapshots,
microphone audio, system audio, and active-window context so an assistant like Claude, Codex or Openclaw can recall what happened on your machine. Everything stays under
`~/.hyprmnesia/`: no upload, no telemetry.

**Status: alpha.** Windows, macOS and Ubuntu with X11 are supported; other Linux and Wayland is being built in.

## Contents

- [What it captures](#what-it-captures)
- [Quickstart](#quickstart)
- [Usage](#usage)
- [MCP server](#mcp-server)
- [Replay](#replay)
- [Tray app](#tray-app)
- [Daemon model](#daemon-model)
- [TUI keybindings](#tui-keybindings)
- [Flags](#flags)
- [Configuration](#configuration)
- [Release process](#release-process)
- [Architecture](#architecture)
- [Platform support](#platform-support)
- [Roadmap](#roadmap)
- [License](#license)

## What It Captures

- **Screenshots** every N seconds, default 5s, with OCR hooks
- **Microphone audio** in chunks, default 30s, with transcription hooks
- **System audio** in chunks, with transcription hooks
- **Active window context**: app name, title, and browser URL when available,
  stored on both screenshots and audio chunks

## Quickstart

```sh
git clone https://github.com/hyprmnesia/hyprmnesia.git
cd hyprmnesia
bun install
bun run src/cli.ts            # launch tray + background daemon
```

To produce a release binary:

```sh
bun run build
./dist/hpm
```

Each platform has its own prerequisites (macOS Screen Recording permission,
Windows dshow driver, Linux apt packages, Xorg-only session, …).

**→ See the full [installation guide](docs/install.md) for per-OS setup and
verification steps.**

## Usage

During development:

```sh
bun run src/cli.ts            # launch tray and start the background daemon
bun run src/cli.ts start      # same as above
bun run src/cli.ts tui        # open the TUI
bun run src/cli.ts logs       # tail the daemon log (default: last 10 + follow)
bun run src/cli.ts stop       # stop the daemon
bun run src/cli.ts quit       # quit the tray icon only
bun run src/cli.ts status     # print daemon status
bun run src/cli.ts status --json
bun run src/cli.ts mcp        # run the read-only MCP stdio server
bun run src/cli.ts replay     # open the local browser replay viewer
```

After building:

```sh
bun run build                 # produces dist/hpm
./dist/hpm                    # launch tray and start the background daemon
./dist/hpm start              # same as above
./dist/hpm tui                # open the TUI
./dist/hpm logs -n 50         # show last 50 log lines + follow
./dist/hpm quit               # quit the tray icon only
./dist/hpm status --json
./dist/hpm mcp                # read-only MCP stdio server
./dist/hpm replay             # open the local browser replay viewer
```

`dist/hpm` is the user-facing entrypoint. Native helpers are built
automatically into `dist/native/` and should not be launched directly.

## MCP Server

Hyprmnesia exposes a local **read-only** MCP server over stdio. It reads
`~/.hyprmnesia/index.db`, never starts the tray, never starts the daemon, and
does not write migrations, reindex data, delete captures, or return screenshot
/ audio bytes by default.

Example MCP client config:

```json
{
  "command": "hpm",
  "args": ["mcp"]
}
```

During development:

```sh
bun run src/cli.ts mcp
bun run src/cli.ts mcp --db ~/.hyprmnesia/index.db
bun run src/cli.ts mcp --transport http --bind 127.0.0.1 --port 37373
```

Default MCP config:

```yaml
mcp:
  transport: stdio # stdio | http
  bind: 127.0.0.1
  port: 37373
```

`stdio` is the default transport for desktop MCP clients. `http` is available
for local integrations at `POST /mcp`; until MCP auth lands, Hyprmnesia refuses
non-local HTTP binds such as `0.0.0.0`.

Available tools:

| Tool | Purpose |
| --- | --- |
| `search` | FTS search over OCR text, window context, and transcript segments |
| `recent_activity` | grouped recent screen/audio activity for "what was I doing?" questions |
| `timeline` | chronological non-empty chunks for a required `from` / `to` range |
| `recall` | full chunk details plus linked transcript segments |
| `get_transcript_segment` | one precise transcript segment, optionally with its parent chunk |

Common filters are `from`, `to`, `source` (`screen`, `mic`, `system`), `app`,
`limit`, and `offset`. Times can be ISO strings or epoch milliseconds; ISO
strings without a timezone are interpreted in the user's local timezone. Results
include both UTC fields (`utc_*` / legacy `iso_*`) and local fields (`local_*`
+ `timezone`); agents should use `local_*` when answering the user.
`timeline` and `recent_activity` hide chunks with no text and no transcript by
default; pass `include_empty: true` for raw debugging. `recent_activity` also
returns best-effort URL metadata: native `window_url` when available, otherwise
an OCR-derived `url_candidate` marked low-confidence. `recall` only includes
local `blob_path` metadata when `include_blob` is true; v1 does not stream
screenshots or audio through MCP.

## Replay

`hpm replay` spins up a short-lived local HTTP server on `127.0.0.1` (random
port, base64url token in the URL) and opens it in your default browser. The
page is a small player that replays a captured time window: screenshots act as
the video stream, transcripts render as subtitles, mic and system audio play
as separate tracks you can toggle.

Pick a range from the preset list (`last 5/15/30/60 min`, `today`, or `custom`)
or pass it on the command line:

```sh
hpm replay
hpm replay --from "2026-05-21T10:00:00" --to "2026-05-21T11:00:00"
hpm replay --from 1747816800000 --to 1747820400000
hpm replay --no-open                # print the URL only, no browser launch
hpm replay --db ~/.hyprmnesia/index.db
```

The server is read-only, bound to localhost, and auto-shuts down after 15s of
inactivity once the browser tab has been opened (Ctrl-C to stop earlier in
`--no-open` mode). It can also be opened directly from the tray
(`Open Replay...`).

## Tray App

The tray app lives next to the system clock and supervises the capture daemon.
Launch it with `hpm` or `hpm start`; both commands ensure the tray and daemon
are alive. The tray reflects state changes via the icon color, tooltip, and OS
notifications.

Tray menu:

- `Open TUI`: opens a visible terminal and runs `hpm tui` (attached to the daemon)
- `Open Replay...`: opens the local browser replay viewer
- `Start daemon`: starts background captures
- `Stop daemon`: stops background captures
- `Open log folder`: opens `~/.hyprmnesia/`
- `Enable launch at login` / `Disable launch at login`
- `Quit Hyprmnesia`: removes the tray icon only; it does not stop captures

`hpm quit` performs the same tray-only quit from the CLI. `hpm stop` stops the
daemon and does not launch or relaunch the tray.

## Daemon Model

The daemon is a detached `hpm _capture` process controlled by local files:

- `~/.hyprmnesia/daemon.pid`: running daemon PID
- `~/.hyprmnesia/daemon.log`: daemon NDJSON log (one event per line)
- `~/.hyprmnesia/daemon.log.1`: rotated copy when the active log exceeds 10 MB
- `~/.hyprmnesia/daemon.err.log`: Windows daemon stderr log
- `~/.hyprmnesia/daemon.start.lock`: start lock to prevent duplicate daemons
- `~/.hyprmnesia/levels.json`: latest mic/system RMS, refreshed every 100 ms
- `~/.hyprmnesia/tray.lock`: tray single-instance lock

`hpm start` is guarded by a start lock, so concurrent invocations converge on
one running daemon instead of spawning duplicates.

## TUI Keybindings

| Key | Action |
| --- | --- |
| `x` | start the daemon if stopped, stop it if running |
| `r` | refresh status |
| `c` | open settings |
| `l` | open/close readable logs |
| `q` / Ctrl-C | quit the TUI (daemon keeps running) |

The TUI attaches to a running daemon: it tails `daemon.log` for events and
polls `levels.json` for the audio meters. It can also open with no daemon; use
`x` to start captures from inside the TUI.
When audio transcription is enabled, the TUI shows live Parakeet transcript
segments for both microphone and mixer/system audio while durable WAV chunks are
still being recorded.

In Settings:

- arrows navigate and adjust numeric/enum values
- Enter edits text/number fields or cycles boolean/enum fields
- `a` restarts the daemon to apply saved capture/engine changes
- MCP transport, bind, and port are editable there too; they apply to the next `hpm mcp`
- Esc or `c` closes settings

## Flags

```sh
--config <path>           config file, default ~/.hyprmnesia/config.yaml
--data-dir <path>         where to store blobs and the index
--screen-interval <ms>    screen capture interval
--audio-chunk <ms>        chunk duration for mic and system audio
--mic-device <name>       override mic device
--system-device <name>    override system audio device
--no-screen               disable screen capture
--no-audio                disable both audio streams
--no-mic                  disable mic only
--no-system-audio         disable system audio only
```

## Configuration

Default YAML config is created automatically at `~/.hyprmnesia/config.yaml`
when Hyprmnesia starts. Existing `config.json` files are still read and migrated
into YAML if no YAML file exists.

```yaml
capture:
  screen:
    enabled: true
    interval_ms: 5000
    monitor: primary
    format: png
  audio:
    sample_rate: 16000
    echo_suppression:
      enabled: true
      system_threshold_db: -45
      mic_margin_db: 6
      hold_ms: 500
    mic:
      enabled: true
      device: default
      chunk_ms: 30000
    system:
      enabled: true
      device: default
      chunk_ms: 30000
processing:
  ocr:
    engine: auto
    options:
      lang: eng
  transcription:
    engine: parakeet
    options:
      model: parakeet-tdt-0.6b-v3
      live:
        enabled: true
        min_segment_ms: 750
        target_segment_ms: 4000
        max_segment_ms: 6000
        silence_ms: 700
        rms_gate: 0.003
storage:
  path: ~/.hyprmnesia/data
mcp:
  transport: stdio
  bind: 127.0.0.1
  port: 37373
```

OCR engines: `auto`, `native`, `tesseract`, `noop`.
Transcription engines: `parakeet`, `noop`. Old `auto` / `whisper` configs are
treated as Parakeet for compatibility; `whisper-cli` is no longer used in the
normal runtime path.
Parakeet model: `parakeet-tdt-0.6b-v3`. The ASR helper auto-downloads the model
to the Hugging Face cache on first use; capture continues while it is loading,
but audio recorded before the model is ready is not transcribed.

`capture.audio.echo_suppression` is a transcript guard for speaker bleed: when
system audio is active, mic frames are only sent to ASR if the mic is clearly
louder than the mixer. It reduces duplicated speaker text in the mic transcript;
it is not full acoustic echo cancellation of the saved mic WAV.

## Release Process

Hyprmnesia uses Changesets for version bumps and changelog generation.

```sh
bun run changeset          # describe a user-visible change
bun run version-packages   # locally apply pending changesets, if needed
```

On `main`, GitHub Actions opens a "Version Packages" PR when pending changesets
exist. After that PR is merged, push a matching tag to publish installers:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds Windows, macOS, and Linux artifacts, then attaches
MSI, PKG, DEB, portable archives, and `SHA256SUMS` to the GitHub Release.
Installers are unsigned in alpha; code signing/notarization is tracked
separately. See [docs/release.md](docs/release.md) for the full release
checklist.

## Architecture

```text
hpm
|-- tray controller (native helper in dist/native)
|   |-- starts/stops daemon through hpm commands
|   |-- opens TUI in a terminal
|
|-- tui (Ink + React)
|   |-- remote daemon controller
|   |-- tails logs and levels
|
|-- daemon
    |-- hpm _capture
    |-- Orchestrator -> EventBus -> captures
        |-- screen (screenshot-desktop; hpm-sck on macOS)
        |-- audio  (ffmpeg mic; hpm-sck system audio on macOS)
        |          -> PCM stream -> hpm-asr Parakeet worker
        |-- active window
        `-- blob store / index
```

Captures emit typed events on a shared event bus. The orchestrator tracks
status, the TUI subscribes for live updates, and the headless logger writes JSON
logs.

## Platform Support

|                | Windows                                | macOS                                  | Linux (TODO)                  |
| -------------- | -------------------------------------- | -------------------------------------- | ----------------------------- |
| Screen capture | OK                                     | OK (ScreenCaptureKit, macOS 13+)       | OK (X11), Wayland TBD         |
| Mic            | OK (dshow)                             | OK (avfoundation)                      | OK (pulse)                    |
| System audio   | needs Screen Capturer Recorder         | OK (ScreenCaptureKit, no driver)       | `@DEFAULT_MONITOR@` via pulse |
| Window context | OK                                     | OK + URL                               | OK on X11, none on Wayland    |

See the [installation guide](docs/install.md) for the exact setup steps per OS.

## License

Hyprmnesia is licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later).
See [LICENSE](LICENSE) for the full text.

In plain language:

- You are free to use, modify and redistribute Hyprmnesia.
- If you redistribute it (binary or source), your modifications must also be released under the AGPL.
- If you run a modified version as a network service (SaaS, hosted dashboard, etc.), users of that service must be able to obtain the corresponding source code.

This license was chosen deliberately: Hyprmnesia is a continuous capture tool
(screen, audio, OCR, transcripts). The AGPL keeps any derivative — including
hosted surveillance products — open and inspectable.
