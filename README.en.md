# Dafeiyu Phone Chat

A phone chat frontend for **DSH Desktop + Aurabot** — no QQ involved.

It keeps the same Aurabot persona, memory, mood, sticker library and diary, and exposes them through a local gateway + mobile PWA/WebView.

## Features

- No QQ / OneBot / SnowLuma in the message path
- Same DSH/Aurabot session, persona and memory
- Material 3-style mobile chat UI with SSE
- Stickers, voice messages (Windows Chinese SAPI), diary viewer
- Local / Tailscale switch inside the app
- DSH plugin: enabling it installs the Aurabot bridge and starts the gateway

## Architecture

```text
Phone / browser
  │ HTTP + SSE (LAN or Tailscale)
  ▼
DSH-Phone-Chat gateway (Node, :8787)
  │ 127.0.0.1 + token
  ▼
Aurabot phone-bridge module (:37901)
  ▼
DSH session (Aurabot persona / memory / diary)
```

## Install as a DSH plugin

Requirements: Windows 10/11, DSH Desktop, Aurabot (`dsh-aurabot-qq`, tested with 1.1.24).

```powershell
dsh plugin --profile desktop add github:whywhy1/dsh-phone-chat
```

Enable **Dafeiyu Phone Chat** in the plugin list, then restart DSH.

The plugin:

1. installs `aurabot-module/phone-bridge` into `%USERPROFILE%\.dsh\plugins-data\aurabot\modules\phone-bridge`;
2. starts `server.mjs` on port 8787 using DSH's bundled Node;
3. stops the gateway it started when DSH exits or the plugin is disabled.

## Run manually

```powershell
git clone https://github.com/whywhy1/dsh-phone-chat.git
cd dsh-phone-chat
node server.mjs
```

Then open `http://<LAN-IP>:8787/`. The access code is generated in:

```text
%USERPROFILE%\.dsh\phone-chat\config.json
```

Set your own code after the first run:

```powershell
node scripts/set-code.mjs "your-strong-code"
```

No access code is shipped in the repository; every install generates its own.

APK: `http://<LAN-IP>:8787/apk`, or `public/dafeiyu-chat.apk`.

## Tailscale

Install Tailscale on both devices with the same account, then open:

```text
http://100.x.x.x:8787/
```

No public port forwarding is required. The chat header has a **Connection** menu to switch between LAN and Tailscale.

## Build the standalone EXE

```powershell
cd build
npm install
npm run build
```

Output: `dist/DSH-Phone-Chat.exe` (Node 24+, Windows x64).

## Security

- Do not expose port 8787 to the public internet.
- Use LAN or your own Tailscale network only.
- The access code grants DSH control; keep it private.
- Never commit `config.json`, `sessions.json`, tokens, chat history, or diaries.

## License

MIT for this repository. Third-party notices: [THIRD_PARTY.md](./THIRD_PARTY.md).
