# Power Station — Shelly EM Gen3 Dashboard

Real-time energy monitoring dashboard for **Shelly EM Gen3** (2-channel) devices. Tracks grid import/export with solar panels, displays live power flow with an animated gauge, and stores up to 365 days of history.

![Dashboard Screenshot](https://img.shields.io/badge/status-active-brightgreen) ![Electron](https://img.shields.io/badge/electron-31.x-blue) ![Node](https://img.shields.io/badge/node-18%2B-green)

## Screenshots

| Cyber (default) | Plasma | Solar |
|:---:|:---:|:---:|
| ![Cyber](Cyber.png) | ![Plasma](Plasma.png) | ![Solar](Solar.png) |

| Arctic | Matrix |
|:---:|:---:|
| ![Arctic](Artic.png) | ![Matrix](Matrix.png) |

## Features

- **Live power gauge** — Animated canvas gauge with particles, glow effects, and smooth needle interpolation
- **Bi-directional tracking** — Negative watts = solar export, positive = grid import
- **5 color themes** — Cyber, Plasma, Solar, Arctic, Matrix (persisted in localStorage)
- **Device health** — Frequency, temperature, WiFi RSSI, uptime, firmware version with update badge
- **Energy stats** — Today/7D/30D import & export from Shelly's native energy counters (Wh)
- **24h telemetry chart** — Min/max/avg power with 1-minute resolution
- **Dual storage** — SQLite (365 days, on Linux/Pi) with JSON fallback (on Windows)
- **Desktop app** — Electron with frameless window, system tray, widget mode (420x460 always-on-top)
- **Pi kiosk** — Runs headless on Raspberry Pi 5, serves dashboard via Chromium in app mode
- **Auto-migration** — Existing `readings.json` data migrates to SQLite on first run

## Architecture

```
Shelly EM Gen3 (WiFi)
       |
       v  HTTP polling (2s)
   server.js (Express + WebSocket)
       |
       +---> SQLite / JSON storage
       +---> REST API (/api/stats, /api/history, /api/settings)
       +---> WebSocket (live data broadcast)
       |
       v
   Frontend (public/index.html)
       |
       +---> Electron app (Windows .exe)
       +---> Chromium kiosk (Raspberry Pi)
       +---> Any browser (http://host:3000)
```

The Windows Electron app connects to a remote Pi server first, falling back to a local embedded server if unreachable.

## Quick Start

### Requirements

- Node.js 18+ 
- A Shelly EM Gen3 device on your local network

### Run in browser

```bash
npm install
SHELLY_IP=192.168.1.XX npm run server
```

Open `http://localhost:3000` in your browser.

### Run as Electron app (Windows)

```bash
npm install
npm start
```

### Build portable .exe

```bash
npm run build
# Output: dist/PowerStation-1.0.0-portable.exe
```

## Deploy on Raspberry Pi

The Pi runs only the server (no Electron needed) with SQLite for long-term storage.

### 1. Install

```bash
# On the Pi
mkdir ~/powerstation
# Copy server.js, public/, package.json (from pi/ folder)
cd ~/powerstation
npm install
```

`better-sqlite3` compiles natively on Linux ARM64. If it fails, the server falls back to JSON storage automatically.

### 2. Systemd service

```bash
sudo tee /etc/systemd/system/powerstation.service << 'EOF'
[Unit]
Description=PowerStation - Shelly EM Gen3 Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/powerstation
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=SHELLY_IP=192.168.1.XX

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now powerstation
```

### 3. Chromium kiosk (optional)

To display the dashboard on a screen connected to the Pi:

```bash
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/powerstation.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=PowerStation Dashboard
Exec=chromium-browser --app=http://localhost:3000 --start-maximized --no-first-run
X-GNOME-Autostart-enabled=true
EOF
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SHELLY_IP` | `10.0.0.22` | IP address of your Shelly EM device |
| `PORT` | `3000` | Server port |
| `PI_HOST` | `10.0.0.57` | Pi server IP (Electron app only) |
| `PI_PORT` | `3000` | Pi server port (Electron app only) |
| `SHELLY_DATA_DIR` | `./` or `%APPDATA%` | Data storage directory |

## Shelly Compatibility

Tested with **Shelly EM Gen3** (2-channel). Also supports via fallback:

- Shelly Pro 3EM (Gen2, 3-phase)
- Shelly EM / EM3 (Gen1)

## Themes

Click the theme button in the top-right corner to cycle through:

| Theme | Accent | Vibe |
|-------|--------|------|
| **Cyber** | Cyan/Teal | Default sci-fi cockpit |
| **Plasma** | Violet/Magenta | Electric neon |
| **Solar** | Amber/Orange | Fire & energy |
| **Arctic** | Ice Blue/White | Frost terminal |
| **Matrix** | Green | Hacker terminal |

## Keyboard Shortcuts (Electron)

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+E` | Show/hide window |
| `Ctrl+Alt+W` | Toggle widget mode |
| `F5` / `Ctrl+R` | Reload page |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stats` | GET | Energy stats (today/week/month import & export) |
| `/api/history` | GET | 24h power history (1-min buckets) |
| `/api/settings` | GET/POST | Alert threshold config |
| `ws://host:3000` | WebSocket | Live power data (2s interval) |

## License

MIT
