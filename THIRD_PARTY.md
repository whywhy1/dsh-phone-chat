# 第三方组件

## public/dafeiyu-chat.apk

这是一个 **WebView 外壳 APK**，来自：

- 项目：`dsh-plugin-remote-access`
- 作者：Mzy123l
- 来源：https://github.com/Mzy123l/dsh-plugin-remote-access
- 许可：MIT
- 本仓库只把它当作“能加载任意 HTTP 聊天页的 Android WebView 壳”，
  没有修改它的原生代码；应用名可能显示 DSH。
- 它自带的前台通知轮询是 DSH remote-access 协议；本网关用空的
  `/__remote_access__/notify` 兼容，不会发送 DSH 通知。

如果要发布自己的 APK，建议用 Kotlin/Jetpack Compose 或 Capacitor
重新打包，并保留本仓库 `docs/API.md` 的 HTTP/SSE 协议。

## Aurabot

- 项目：`dsh-aurabot-qq`
- 作者：accomplish07zrh-eng
- 来源：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq
- 许可：MIT
- 本仓库的 `aurabot-module/phone-bridge` 是独立用户模块，
  依赖 Aurabot 的模块 API；不包含 Aurabot 源码。

## Tailscale

- https://tailscale.com/
- 仅作为可选的远程组网方案，不包含其代码/客户端。

## Windows Speech API

- 使用 Windows 自带 `System.Speech`，不需要额外模型/许可。
