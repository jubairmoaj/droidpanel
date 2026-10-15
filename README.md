# droidpanel

A lightweight web dashboard for Android app development. It runs on your PC, opens in your browser, and talks to your phone over **USB or Wi-Fi** using `adb`.

- **No runtime dependencies**: the server is plain Node.js (≥ 20). The UI is React + TypeScript, built once with Vite into static files.
- **Light on your PC**: the screen mirror sends the phone's H.264 stream straight to your browser, which decodes it with WebCodecs (usually GPU-accelerated). Node only relays bytes.
- **Local only**: it binds to `127.0.0.1` and refuses requests from other websites (see [Security](#security)).
- **Or hosted**: run it on a server with `--web` and use it from any computer with just a browser. The browser talks to the phone over USB itself, so nothing is installed or running on that computer (see [Hosted mode](#hosted-mode-vps)).

## Features

| Area | What you get |
|---|---|
| **Connect** | USB devices · Wi-Fi pairing by **QR code** or **pairing code** · connect by IP · **USB → Wi-Fi** in one click · auto-discovery via mDNS |
| **Mirror** | Live screen in the browser · real-time touch, swipe, scroll · keyboard typing · **Ctrl+V pastes your PC clipboard** · device clipboard syncs back · back/home/recents/volume/power/rotate · 3 quality presets · *lite mode* (screenshots) when scrcpy isn't installed |
| **Capture** | **One-click screenshot → clipboard** (`Ctrl+Shift+S`) · save PNG · screen recording to MP4 |
| **Logcat** | Live stream · filter by **app package** (follows restarts) · level · search/regex with highlights · pause · clear · save |
| **Network** | See every API call your app makes: method, status, URL, timing, request/response headers and bodies (pretty JSON) · filter by URL and status · copy as cURL · works with HTTPS, no proxy or certificates. Add the tiny debug-only logger from [`public/snippets`](public/snippets) (Dio for Flutter, OkHttp for native) |
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
npm install && npm run build     # builds the UI into dist/
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

## Hosted mode (VPS)

`droidpanel --web` serves the dashboard from a server. Open the URL in Chrome, Edge or Brave on any computer,
plug the phone into **that** computer, and click **Connect device → Choose phone**. The page speaks the ADB
protocol to the phone over [WebUSB](https://developer.mozilla.org/docs/Web/API/WebUSB_API) and decodes the mirror
on the GPU, so the computer runs no adb, Node or scrcpy, and the server only serves static files.

| Works in hosted mode | Desktop app only |
|---|---|
| Mirror (live, with touch/keys/clipboard), screenshot, recording · Logcat · Network · Apps (launch/stop/clear/uninstall, APK download, drag-and-drop install) · Dev toggles · Deep links · Send text · Push files · Shell · Device info · **Build & Run with hot reload** (with the PC helper, below) | Port reverse · Wi-Fi pairing and connect |

```bash
# on the server (or use the Dockerfile / docker-compose.yml, which build the UI for you)
git clone https://github.com/jubairmoaj/droidpanel.git && cd droidpanel
npm install && npm run build
node bin/droidpanel.mjs --web --host 127.0.0.1 --port 4321
```

On first start it downloads the pinned `scrcpy-server` (checksum-verified) into `~/.config/droidpanel`, unless
scrcpy is installed or `SCRCPY_SERVER` + `SCRCPY_VERSION` are set.

WebUSB only works on **HTTPS**, so put it behind a reverse proxy. With [Caddy](https://caddyserver.com) (automatic certificates):

```
panel.example.com {
    reverse_proxy 127.0.0.1:4321
}
```

To keep it running, a systemd unit such as:

```ini
# /etc/systemd/system/droidpanel.service
[Service]
ExecStart=/usr/bin/node /opt/droidpanel/bin/droidpanel.mjs --web --host 127.0.0.1 --port 4321
Restart=always
User=droidpanel

[Install]
WantedBy=multi-user.target
```

**On the computer you open it from:**

- Only one program can use the phone's USB debugging at a time. If the page says the phone is busy, stop the local
  adb server (`adb kill-server`) and close Android Studio or scrcpy.
- The first time, the phone asks **Allow USB debugging?** for the browser's key. Tick *Always allow*. The key is kept
  in that browser's storage, and the phone reconnects automatically whenever it's plugged in.
- Windows needs the phone's USB driver (Google USB Driver or the manufacturer's). macOS and Linux work as is, but
  on Linux your user must be able to access the device (if `adb devices` works without sudo, so does this).

### Build & Run from the hosted panel (PC helper)

Builds can't run inside a browser, so Build & Run uses a small helper on the PC where your code is:

```bash
npx -y github:jubairmoaj/droidpanel agent --origin https://panel.example.com
# or, from a clone:  node bin/droidpanel.mjs agent --origin https://panel.example.com
```

Then open **Build & Run → Connect**, add your app with **Browse…** (opens your PC's folder picker), and use
run / hot reload / rebuild / build debug or release / install / launch / stop as in the desktop app. Hot reload on
save works too. The helper idles until you click a task; the build itself uses the PC's Flutter / Gradle as usual.

How it reaches the phone: the browser owns the USB connection, so the helper starts a stand-in adb server
(port 5038) and points Flutter and Gradle at it. Every adb command they run is tunnelled through the page's
WebUSB connection, so the mirror and logcat keep working while you build. `adb reverse` isn't available this way.

The helper only accepts requests from the `--origin` you give it, listens on `127.0.0.1` only, and checks the
`Host` header. The browser may ask to let the site access apps on this device: allow it.

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

Hosted mode (`--web`) is different: the server has no adb and no API, only static files, so exposing it is safe.
Each visitor can only reach the phone plugged into their own computer, after picking it in the browser's USB
chooser and approving the key on the phone. The page is served with a strict Content-Security-Policy.

## Project layout

```
bin/droidpanel.mjs      CLI: desktop server, --web (hosted), agent (PC helper)
src/server.mjs          desktop mode: HTTP API over the local adb, static UI, logcat SSE
src/adb.mjs, mirror.mjs adb helpers and scrcpy session (desktop mode)
src/projects.mjs        project detection and the build/run job runner
src/project-routes.mjs  Build & Run API, shared by the server and the agent
src/web.mjs             hosted mode: static server + scrcpy-server download
src/agent.mjs           PC helper for hosted Build & Run
src/relay.mjs           stand-in adb server that tunnels adb through the browser's WebUSB
shared/device.js        device commands and parsers used by both modes
ui/                     the web UI (Vite root)
  src/App.tsx           shell: top bar, device picker, tabs
  src/DevicePane.tsx    mirror (fit-to-screen), controls, quick Build bar
  src/tabs/*.tsx        Overview, Apps, Logcat, Network, Build & Run, Tools
  src/core/             framework-free engine: ADB over WebUSB (adb/), hosted backend
                        and agent bridge (web/), api.js, mirror.js
dist/                   built UI (npm run build), served by both servers
```

`npm run dev:ui` starts Vite with hot reload, proxying `/api` to a desktop `droidpanel` on :4321.
`npm run check` syntax-checks the server and type-checks the UI.

## License

MIT
