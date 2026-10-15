# droidpanel

A lightweight web dashboard for Android app development. It runs on your PC, opens in your browser, and talks to your phone over **USB or Wi-Fi** using `adb`.

- **Zero dependencies**: plain Node.js (≥ 20) and vanilla JS. No build step and no `node_modules`.
- **Light on your PC**: the screen mirror sends the phone's H.264 stream straight to your browser, which decodes it with WebCodecs (usually GPU-accelerated). Node only relays bytes.
- **Local only**: it binds to `127.0.0.1` and refuses requests from other websites (see [Security](#security)).

## Features

| Area | What you get |
|---|---|
| **Connect** | USB devices · Wi-Fi pairing by **QR code** or **pairing code** · connect by IP · **USB → Wi-Fi** in one click · auto-discovery via mDNS |
| **Mirror** | Live screen in the browser · real-time touch, swipe, scroll · keyboard typing · **Ctrl+V pastes your PC clipboard** · device clipboard syncs back · back/home/recents/volume/power/rotate · 3 quality presets · *lite mode* (screenshots) when scrcpy isn't installed |
| **Capture** | **One-click screenshot → clipboard** (`Ctrl+Shift+S`) · save PNG · screen recording to MP4 |
| **Logcat** | Live stream · filter by **app package** (follows restarts) · level · search/regex with highlights · pause · clear · save |
| **Apps** | Search installed packages · version and install info · launch / restart / force-stop / clear data / uninstall · open App info · **download the APK** · **drag-and-drop APK install** |
| **Build & Run** | Add Flutter, native Android (Gradle) or React Native projects · `flutter run` with **hot reload / hot restart** buttons · build debug/release · install · launch · one-click *stop → build → install → launch* · live build log |
| **Dev toggles** | Layout bounds · show taps · pointer location · GPU overdraw · animations off · dark mode · large font · don't keep activities · stay awake |
| **Tools** | **Port reverse** (`adb reverse`, so the app can reach `localhost:4000` on your PC) · open deep links · send text · push files to Downloads · ADB shell with history · device info (battery, storage, IP, Android version…) |

## Requirements

- **Node.js 20+**
- **adb** ([Android SDK platform-tools](https://developer.android.com/tools/releases/platform-tools)) on your `PATH`, or set `ADB=/path/to/adb`
- **scrcpy** (optional, recommended): live mirroring uses the `scrcpy-server` file that comes with any [scrcpy](https://github.com/Genymobile/scrcpy) install. Without it, the mirror falls back to screenshot mode.
- A Chromium-based browser (Chrome, Edge, Brave) or Firefox 130+ for live mirroring
- For Build & Run: `flutter`, or a Gradle wrapper (`gradlew`) in your project

## Quick start

```bash
git clone https://github.com/jubairmoaj/droidpanel.git
cd droidpanel
node bin/droidpanel.mjs          # opens http://localhost:4321
```

Or install the `droidpanel` command globally:

```bash
npm install -g .
droidpanel --port 4321 --no-open
```

| Option | Default | |
|---|---|---|
| `--port` | `4321` | HTTP port (or `PORT` env) |
| `--host` | `127.0.0.1` | Bind address. Keep it local. |
| `--no-open` | | Don't open the browser |

| Env var | |
|---|---|
| `ADB` | Path to the adb binary |
| `SCRCPY_SERVER` | Path to `scrcpy-server` if it isn't found automatically |
| `SCRCPY_VERSION` | Version of that server (needed only when the `scrcpy` binary isn't on `PATH`) |
| `DROIDPANEL_HOME` | Where projects are saved (default `~/.config/droidpanel`) |

## Connecting a phone

**USB**: enable *Developer options* (tap *Build number* 7 times), turn on *USB debugging*, plug in, and accept the prompt on the phone.

**Wi-Fi (Android 11+)**: click **＋ Connect device**, then either:
- **QR**: on the phone open *Developer options → Wireless debugging → Pair device with QR code* and scan the code shown in droidpanel. It pairs and connects automatically.
- **Pairing code**: enter the IP:port and 6-digit code from *Pair device with pairing code*, then connect to the IP:port on the main *Wireless debugging* screen.
- **USB → Wi-Fi**: with the phone on USB, one click runs `adb tcpip 5555` and connects over Wi-Fi, so you can unplug the cable.

The phone and PC must be on the same network.

## Mirror controls

| Input | Action |
|---|---|
| Click / drag | Tap / swipe (multi-step, real time) |
| Mouse wheel | Scroll |
| Right-click | Back (or wake the screen) |
| Middle-click | Home |
| Typing | Sent to the focused field on the phone |
| `Ctrl+V` | Paste your PC clipboard on the phone |
| `Ctrl+Shift+S` | Screenshot → clipboard |

Copying text on the phone puts it on your PC clipboard automatically.

## How it works

```
Browser ── HTTP/SSE/WebSocket ──► Node (droidpanel) ── adb ──► phone
   ▲                                    │
   └──── raw H.264 (fetch stream) ◄─────┘◄── scrcpy-server (on phone)
```

- **Mirror**: droidpanel pushes `scrcpy-server` to the phone, starts it with `adb shell app_process`, and pipes the video socket into an HTTP response. The browser parses scrcpy's packet framing and decodes it with `VideoDecoder`. Input is sent back as scrcpy control messages over a small built-in WebSocket.
- **Logcat** is Server-Sent Events, batched every 150 ms. The page keeps at most 4,000 lines in the DOM.
- **Projects** are stored in `~/.config/droidpanel/config.json`. Builds run as child processes, and their output is streamed to the page.

## Security

droidpanel can run shell commands on your phone and build tools on your PC, so it locks itself down:

- It binds to `127.0.0.1` by default.
- It rejects requests whose `Host` header isn't localhost, which blocks DNS-rebinding attacks.
- Every state-changing request must carry an `x-droidpanel: 1` header. Browsers won't let other websites send it without a CORS preflight, and droidpanel never approves one.
- The WebSocket checks `Origin`.

Don't expose it on a public network with `--host 0.0.0.0`.

## Project layout

```
bin/droidpanel.mjs   CLI entry: flags, start server, open browser
src/server.mjs       HTTP routes, security guard, static files, logcat SSE
src/adb.mjs          adb helpers: devices, wireless, toggles, apps, capture
src/mirror.mjs       scrcpy-server session + control socket
src/projects.mjs     project detection, saved config, build/run job runner
src/ws.mjs           minimal WebSocket (server side)
src/util.mjs         exec, body parsing, quoting, misc
public/              the web UI (index.html, style.css, app.js, mirror.js, api.js)
```

`npm run dev` restarts on file changes. `npm run check` syntax-checks every file.

## License

MIT
