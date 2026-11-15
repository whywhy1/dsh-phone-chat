# 大肥鱼手机聊天 · Dafeiyu Phone Chat

> 不经过 QQ，把 **DSH / Aurabot** 的大肥鱼装进手机。  
> 本地网关 + PWA/WebView + 表情包 + 语音 + 空间日记 + Tailscale 远程。

<p align="center">
  <img src="./icon.svg" width="96" alt="大肥鱼手机聊天">
</p>

一个给 **DSH Desktop + Aurabot** 用的手机聊天前端。它不是又一个通用聊天机器人平台，而是把本机 DSH 会话里的大肥鱼人格、记忆、心情、表情库和日记，直接接到手机上；QQ / OneBot / SnowLuma 都不参与。


## 特性

- **不经 QQ**：Aurabot 的主人私聊走本机 phone-bridge，模块加载后会停掉 QQ 网关并阻止重连。
- **人格/记忆不变**：仍然是 DSH 里的 Aurabot 会话，不是另起一个模型。
- **手机聊天 UI**：Material 3 风格、PWA/WebView 自适应、SSE 实时消息。
- **表情包**：读取 Aurabot 自己的 `stickers/index.json`，双向收发。
- **语音**：手机发 WAV，电脑用 Windows 中文语音识别转文字；Aurabot 的语音消息直接在手机播放。
- **空间日记**：手机里翻她写的 `diary.json`，区分“已发到空间 / 只存在本地”；日记本里点「让她写一篇」可以让她现写一篇（QQ 关着时只存本地，不会发到 QQ 空间）。
- **本地/外网切换**：App 内一键在局域网 IP 和 Tailscale IP 之间切换，自动带登录态。
- **远程**：Tailscale 私有网络，不需要把 8787 映射到公网。
- **DSH 插件**：启用插件后自动安装 Aurabot 手机桥并启动网关。

## 架构

```text
手机 App / 浏览器
        │  HTTP + SSE（局域网或 Tailscale）
        ▼
DSH-Phone-Chat 网关（Node，默认 8787）
        │  127.0.0.1 HTTP + token
        ▼
Aurabot phone-bridge 用户模块（37901）
        │  hub.onMessage / send hook
        ▼
DSH 会话（aurabot-private + 大肥鱼人格/记忆/心情/表情/日记）
```

QQ / OneBot 不在链路里。

## 一键安装（DSH 插件）

前置条件：

- Windows 10/11
- [DSH Desktop](https://github.com/deepseek-ai)（本仓库按 DSH 0.2.x 的插件 bundle 格式编写）
- Aurabot 插件 `dsh-aurabot-qq`（本仓库按 **1.1.24** 测试）

安装命令：

```powershell
dsh plugin --profile desktop add github:whywhy1/dsh-phone-chat
```

然后在 DSH 插件列表里启用 **大肥鱼手机聊天**，重启 DSH。

插件启用后会做三件事：

1. 把 `aurabot-module/phone-bridge` 安装到 `%USERPROFILE%\.dsh\plugins-data\aurabot\modules\phone-bridge`；
2. 用 DSH 自带的 Node 启动 `server.mjs`，监听 `8787`；
3. DSH 退出或插件停用时，停掉它自己启动的网关。

> 如果 `dsh` 不在 PATH，用 DSH Desktop 的插件市场安装 npm 包名 `dsh-plugin-dafeiyu-phone-chat`（发布后），或在 DSH 安装目录里运行对应的 `dsh` CLI。

### 手动安装（不用插件）

```powershell
git clone https://github.com/whywhy1/dsh-phone-chat.git
cd dsh-phone-chat
node server.mjs
```

再把 `aurabot-module\phone-bridge` 复制到：

```text
%USERPROFILE%\.dsh\plugins-data\aurabot\modules\phone-bridge
```

## 第一次打开

启动后访问：

```text
http://<电脑局域网IP>:8787/
```

访问码在：

```text
%USERPROFILE%\.dsh\phone-chat\config.json
```

首次运行会自动生成，类似：

```json
{
  "port": 8787,
  "accessCode": "your-access-code"
}
```

仓库**不内置**访问码，每个安装实例自己生成。想自己指定，在仓库目录运行：

```powershell
node scripts/set-code.mjs "your-strong-code"
```

或者在 DSH 插件安装目录里找到 `scripts/set-code.mjs` 运行。改完重启网关 / 重新启用插件生效。

手机和电脑在同一 Wi-Fi 时用局域网地址；外网用 Tailscale 地址。

### APK

浏览器打开：

```text
http://<电脑IP>:8787/apk
```

或直接使用仓库里的：

```text
public/dafeiyu-chat.apk
```

这是一个第三方 WebView 壳（见 `THIRD_PARTY.md`），里面的聊天页由服务端 `public/index.html` 提供。改 UI 不需要重打 APK。

## Tailscale 远程

1. 电脑和手机安装 Tailscale，登录同一账号；
2. 电脑会得到 `100.x.x.x`；
3. 手机访问 `http://100.x.x.x:8787/`；
4. 手机聊天页右上角「连接」可在本地/外网之间切换。

不需要在路由器上把 8787 映射到公网。

> 手机浏览器直接按麦克风需要 HTTPS；走 Tailscale HTTP 时，语音按钮会退化为“选录音文件”。APK 壳本身也没有 `RECORD_AUDIO` 权限。

## 构建 Windows EXE（可选）

插件模式不需要 EXE；想做成单文件分发时：

```powershell
cd build
npm install
npm run build
```

输出：

```text
dist/DSH-Phone-Chat.exe
```

要求 Node.js 24+。EXE 约 90 MB，未签名，Windows SmartScreen 可能提示。

## 目录

```text
dsh-phone-chat/
├─ index.js                  # DSH Host 插件入口：装模块、拉起网关
├─ cordis.patch.yml          # DSH bundle patch
├─ server.mjs                # 网关：登录/消息/SSE/表情/语音/日记/连接切换
├─ public/index.html         # 手机聊天 UI
├─ public/dafeiyu-chat.apk   # 第三方 WebView 壳
├─ aurabot-module/phone-bridge/index.mjs
├─ stt.ps1                   # Windows SAPI 中文语音识别
├─ build/                    # Node SEA 打包脚本
├─ docs/API.md               # 接口与数据格式
├─ README.en.md
├─ LICENSE
└─ THIRD_PARTY.md
```

## 安全

- 网关默认只监听 `8787`；**不要**把 8787 直接映射到公网。
- 只用局域网或自己的 Tailscale 网络。
- 访问码自动生成；建议改成 8 位以上。
- 这个入口等于电脑上的 DSH 操作权限，只给自己用。
- 密码、token、`config.json`、`sessions.json`、聊天记录、日记都不要提交到 Git。

## 已知限制

- Aurabot 的 `hub.onMessage` / `send` hook 是半内部接口；升级 Aurabot 后需要回归测试一条文字消息。
- 当前 APK 是 WebView 壳，不是原生 Material 3；要做原生 App 可保留 `docs/API.md` 的协议，用 Kotlin/Compose 重写。
- 语音识别是 Windows 自带 SAPI，适合短句；要更好可换 Vosk / SenseVoice / Whisper。
- 消息存储是 JSON，最多 500 条；没有多设备已读/端到端加密。
- 没有 CI/自动发布；`npm publish` 前请自己改 `repository`/`homepage`。

## License

自有代码 MIT。第三方 APK、Aurabot 的许可见 [THIRD_PARTY.md](./THIRD_PARTY.md)。
