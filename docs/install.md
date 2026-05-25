# Installation

> Back to the [README](../README.md).

This guide covers a full Hyprmnesia install from source on Windows, macOS, and
Linux, including platform-specific dependencies, permissions, and a smoke test
to confirm everything works.

## Contents
- [Prerequisites](#prerequisites)
- [Install from a GitHub Release](#install-from-a-github-release)
- [Clone and install dependencies](#clone-and-install-dependencies)
- [Platform-specific setup](#platform-specific-setup)
  - [macOS](#macos)
  - [Windows](#windows)
  - [Linux (Debian/Ubuntu)](#linux-debianubuntu)
- [Build a release binary](#build-a-release-binary)
- [Verify](#verify)
- [Troubleshooting](#troubleshooting)

## Prerequisites

| Tool | Why |
| --- | --- |
| [Bun](https://bun.sh) | JS/TS runtime used by the CLI, TUI, and daemon |
| Rust toolchain (`cargo`) | Builds the native helpers (`tray/`, `ocr/`, `asr/`, and `sck/` on macOS) |
| Git | Cloning the repository |

Platform-specific extras are listed in the [Platform-specific setup](#platform-specific-setup)
section below — install those *before* the build step.

## Install from a GitHub Release

Alpha installers are published from GitHub Releases when a `vX.Y.Z` tag is
pushed. They are unsigned for now, so Windows and macOS may show security
warnings until signing/notarization is added.

### Windows

Download `hyprmnesia-<version>-windows-x64.msi` from the release and run it. The
MSI installs Hyprmnesia for the current user under
`%LocalAppData%\Programs\Hyprmnesia`, adds a Start Menu shortcut, and appends the
install directory to the user `PATH`.

### macOS

Download `hyprmnesia-<version>-macos-<arch>.pkg` and install it. The package
places files in `/usr/local/hyprmnesia` and creates `/usr/local/bin/hpm`.

Because the package is unsigned in alpha, you may need to approve it through
*System Settings -> Privacy & Security* after the first launch.

### Linux (Debian/Ubuntu)

Download `hyprmnesia-<version>-linux-x64.deb` and install it:

```sh
sudo apt install ./hyprmnesia-<version>-linux-x64.deb
```

The DEB installs into `/opt/hyprmnesia` and creates `/usr/bin/hpm`. A portable
`.tar.gz` is also attached for non-Debian systems or manual testing.

## Clone and install dependencies

```sh
git clone https://github.com/hyprmnesia/hyprmnesia.git
cd hyprmnesia
bun install
```

`bun install` only fetches JS dependencies. The Rust helpers are compiled later
during `bun run build` (or on first `dev` invocation that needs them).

## Platform-specific setup

### macOS

**Requirements:** macOS 13 or later (ScreenCaptureKit).

- OCR uses Tesseract on macOS. Install it before starting capture:

  ```sh
  brew install tesseract
  ```

- Screen capture and system-audio capture are handled by the native helper
  `hpm-sck`, built from `sck/`. **No BlackHole or loopback driver is required.**
- On first run, macOS prompts for **Screen Recording** permission in
  *System Settings → Privacy & Security*. Grant it to the terminal hosting
  `hpm` (or to the bundled `hpm` itself once shipped as an app).
- macOS also prompts for **Microphone** access the first time mic capture
  starts; allow it for the same host.

If the permission dialog never appears, see [Troubleshooting](#troubleshooting).

### Windows

**System-audio capture** has two backends, selected by
`capture.audio.system.backend` in the config (or the "System backend" row in the
TUI settings):

- **`wasapi`** (preferred) — a bundled native helper (`hpm-wasapi`) captures the
  render endpoint via WASAPI loopback. It taps the engine mix, so it keeps
  capturing **even when Windows output is muted or its volume is 0** — the common
  case for a memory app where you want to silence your speakers but still
  transcribe. No external driver is required; the helper ships in `dist/native/`.
- **`dshow`** (compatibility fallback) — records the `virtual-audio-capturer`
  DirectShow device from the
  [Screen Capturer Recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases)
  package. This device follows the audible output, so **muting Windows silences
  the capture**.
- **`auto`** (default) — uses `wasapi` when the helper is present, otherwise
  falls back to `dshow` (and logs a warning that capture will follow mute).

The selected backend and device are recorded in the daemon log's `started` event
so you can confirm which path is active.

- To use `dshow`, install Screen Capturer Recorder from the link above.
- To skip system audio entirely, launch Hyprmnesia with `--no-system-audio`.
- If WASAPI loopback still follows mute on your hardware/driver stack, route the
  app's audio into a virtual audio cable/sink and capture that device via
  `backend: dshow` with an explicit `device` name.

Microphone and screen capture work out of the box on Windows.

### Linux (Debian/Ubuntu)

Install the system packages used by the native tray, screen capture, and audio
capture:

```sh
sudo apt install libxdo-dev imagemagick ffmpeg tesseract-ocr
```

- **`libxdo-dev`** — required to link the Rust tray helper (`tray/`).
- **`imagemagick`** — provides the `import` command that `screenshot-desktop`
  invokes under the hood.
- **`ffmpeg`** — needed for mic and system-audio capture. The bundled
  `ffmpeg-static` binary lacks PulseAudio / PipeWire support, so on Linux
  Hyprmnesia uses the *system* `ffmpeg`. Debian/Ubuntu builds enable `libpulse`
  by default; `pipewire-pulse` provides the PA socket on modern desktops.
- **`tesseract-ocr`** - provides OCR for screenshots.

**Session requirement:** screen capture currently requires an **Xorg** session —
`import` is X11-only. Wayland support is tracked in
[#8](https://github.com/hyprmnesia/hyprmnesia/issues/8). To switch sessions, log
out and pick "Ubuntu on Xorg" (or your distro's equivalent) at the login
screen.

## Build a release binary

```sh
bun run build         # produces dist/hpm
./dist/hpm --help     # smoke test the binary
```

`dist/hpm` is the user-facing entry point. Native helpers are built
automatically into `dist/native/` and should not be launched directly.

## Verify

Once built, confirm the daemon starts, runs, and stops cleanly:

```sh
./dist/hpm start          # launch tray + background daemon
./dist/hpm status         # should report "running" with a PID
./dist/hpm logs -n 20     # tail the most recent NDJSON events
./dist/hpm stop           # stop the daemon when you're done
```

Captured data lives under `~/.hyprmnesia/`. See the [README](../README.md#daemon-model)
for the list of files the daemon writes there.

## Troubleshooting

**macOS — `hpm-sck` exits immediately or no capture happens.**
Re-check *System Settings → Privacy & Security → Screen Recording*. The
permission must be granted to the host process that launched `hpm` (often your
terminal app, e.g. Terminal.app, iTerm, Ghostty). Quit and relaunch the
terminal after granting permission.

**Windows — system audio is silent.**
First check the daemon log's `started` event for the `system` source to see which
backend is active.

- If `backend: "wasapi"` and audio is still silent, the helper may not be
  capturing — confirm `dist/native/hpm-wasapi.exe` exists (built by
  `bun run build`) and check the log for an `hpm-wasapi ... exited` error.
- If `backend: "dshow"`, capture follows the Windows output: unmute the output,
  or switch `capture.audio.system.backend` to `wasapi`. Confirm the dshow device
  is registered with:

  ```sh
  ffmpeg -list_devices true -f dshow -i dummy
  ```

  If `virtual-audio-capturer` doesn't appear, re-run the Screen Capturer Recorder
  installer.

As a last resort, launch Hyprmnesia with `--no-system-audio`.

**Linux — screen capture fails on a fresh login.**
You are most likely on a Wayland session. Log out and pick the Xorg variant of
your desktop at the login screen, then try again.

**Linux — Rust build fails with a missing `xdo.h`.**
`libxdo-dev` is not installed. Run `sudo apt install libxdo-dev` and rebuild.

**Linux — `ffmpeg` cannot find a PulseAudio source.**
Make sure either PulseAudio or `pipewire-pulse` is running. `pactl info` should
print a server name.

**macOS/Linux - screenshots are captured but OCR text is empty.**
Confirm Tesseract is installed with `tesseract --version`. If it is installed in
a custom location, set `processing.ocr.options.binary` in
`~/.hyprmnesia/config.yaml` to the absolute binary path.
