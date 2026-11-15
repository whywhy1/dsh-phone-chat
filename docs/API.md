# API 参考

所有接口默认在 `http://<host>:8787`。

## 鉴权

- `POST /api/login` → `{ "code": "..." }`
- 成功后 Set-Cookie：`dsh_phone_session=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
- 之后的 `/api/*` 带 cookie。
- 会话保存在 `~/.dsh/phone-chat/sessions.json`，重启网关不会掉登录。
- `GET /api/me` 检查登录：200 `{ok:true,user:"主人",bridge:{...}}` 或 401。

## 消息对象

```json
{
  "id": "1790000000000-ab12cd",
  "role": "user",
  "text": "你好",
  "at": 1790000000000,
  "media": [
    { "type": "sticker", "url": "/stickers/manual-xxx.png" },
    { "type": "audio", "url": "/media/1790000000000-abc.mp3" }
  ],
  "via": "aurabot"
}
```

`media[].type`：`image` / `sticker` / `audio`。

## 聊天

### GET /api/history

200：

```json
{ "ok": true, "messages": [ ... ], "bridge": { "connected": true } }
```

### POST /api/send

文字：

```json
{ "text": "你好" }
```

表情：

```json
{ "stickerId": "a01c3ba92584c72ca47f16d63a3432d6" }
```

语音（base64 WAV 或 data URL）：

```json
{ "voice": "UklGR..." }
```

也允许 `text` + `stickerId` 同时发。

200：

```json
{ "ok": true, "message": { ... } }
```

网关先落历史、广播 SSE，再转给 Aurabot。

### GET /api/events

`text/event-stream`，事件：

```text
event: ready
data: {"ok":true,"bridge":{"connected":true}}

event: bridge
data: {"connected":true,"lastError":"","lastAt":...}

event: message
data: { ...消息对象... }
```

前端同时渲染 `user` / `assistant`，并用 `id` 去重。

## 表情

### GET /api/stickers

200：

```json
{
  "ok": true,
  "stickers": [
    { "id": "md5", "file": "manual-xxx.png", "name": "端着满碗白米饭", "tags": ["吃饭"] }
  ]
}
```

### GET /stickers/:file

直接返回图片，不要求 cookie。只允许 `index.json` 里出现过的文件名。

## 媒体

### GET /media/:file

返回 `~/.dsh/phone-chat/media/` 下的图片/音频。随机文件名，不要求 cookie。

## 日记

### GET /api/diary

200：

```json
{
  "ok": true,
  "items": [
    { "at": 1794645287434, "text": "11月14日 ...", "ok": false, "visibility": "all" }
  ]
}
```

来源：`~/.dsh/plugins-data/aurabot/diary.json`，按 `at` 倒序，最多 100 条。

### POST /api/diary/write

让 Aurabot 现写一篇空间日记。网关转发到 phone-bridge，最长等 180 秒。

```json
{}
```

返回：

```json
{
  "ok": false,
  "text": "11月15日 ...",
  "message": "send_qzone_msg 失败：连不上 QQ 网关",
  "visibility": "self",
  "local": true
}
```

- `ok:true`：已发到 QQ 空间。
- `ok:false` 但 `text` 有内容：日记已写进本地 `diary.json`，只是 QQ 空间没发出去；手机日记本会显示“只存在本地”。

## 本地/外网切换

### GET /api/endpoints

```json
{
  "ok": true,
  "local": "http://192.168.1.100:8787",
  "remote": "http://100.64.0.10:8787",
  "current": "http://192.168.1.100:8787",
  "localName": "WLAN",
  "remoteName": "Tailscale"
}
```

- local：第一个 192.168/10/172.16-31 地址
- remote：第一个 100.64.0.0/10（Tailscale）地址

### POST /api/switch

```json
{ "to": "local" }
```

200：

```json
{ "ok": true, "url": "http://192.168.1.100:8787/?switch=一次性code" }
```

前端跳转该 URL；目标网关：

- 校验 60 秒内的一次性 code
- 设置目标 origin 的 `dsh_phone_session` cookie
- 302 到 `/`

不需要重新输访问码。

## 其他

### GET /apk

返回 `public/dafeiyu-chat.apk`，Content-Type `application/vnd.android.package-archive`。

### GET /admin

只允许 loopback，显示访问码、局域网地址、桥接状态。

### GET /__remote_access__/notify

兼容第三方 WebView 壳的前台通知轮询，返回空的 `pending/finish`，避免 404。

---

# Aurabot phone-bridge 模块

监听 `127.0.0.1:37901`；token 文件：

```text
~/.dsh/plugins-data/aurabot/modules-data/phone-bridge/token
```

请求头：`x-phone-token: <token>`；SSE 可用 `?token=`。

### GET /health

```json
{ "ok": true, "bridge": "phone-bridge", "ownerQQ": "...", "chatId": "private:...", "active": true }
```

### POST /arm

由网关在连接时调用，24 小时内拦截 Aurabot 往主人私聊的发送：

```json
{ "ok": true, "phoneActiveUntil": 179... }
```

### GET /events?token=...

```text
event: ready
data: {...}

event: message
data: { "type": "out", "chatId": "private:...", "message": [OneBot 段], "note": "", "at": 179... }
```

`message` 是 Aurabot 最终要发给 QQ 的 OneBot 段数组；网关负责：

- `text` → 文字
- `image` / `mface` → 图片/表情（base64 落盘）
- `record` → 语音（base64 落盘，MP3）

### POST /inbound

```json
{ "text": "你好" }
{ "sticker": { "name": "开心", "base64": "..." } }
{ "voice": "UklGR..." }
{ "text": "配文", "sticker": { ... } }
```

模块构造 OneBot 私聊事件后调用 `api.core.hub.onMessage(event)`。

- `sticker` → `mface` 段
- `voice` → `record` 段；模块 patch `onebot.call('get_record')` 返回 base64，让 Aurabot 的本地识别链路能拿到音频。
- 网关在发送语音前会用 `stt.ps1` 转成文字，通常只发 `text`，不会把原始音频转给 Aurabot。

### 兼容性

- 按 Aurabot **1.1.24** 测试。
- 使用 `api.core.hub.onMessage`、`api.on('send')`、`api.core.onebot.call` 的 patch。
- 模块会 `onebot.stop()` 并替换 `onebot.start` 为空函数，防止 QQ 重连。
- 卸载模块/停用后恢复原 `onebot.call/start`。
