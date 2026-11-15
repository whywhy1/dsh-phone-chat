/**
 * dsh-plugin-dafeiyu-phone-chat
 *
 * 在 DSH 里一键启动“大肥鱼手机聊天”网关：
 *   - 把 aurabot-module/phone-bridge 安装到 Aurabot 的用户模块目录
 *   - 用 DSH 自带的 Node 启动 server.mjs
 *   - DSH 退出/禁用插件时停掉自己启动的网关
 *
 * 网关地址默认 http://<本机局域网IP>:8787/，访问码自动生成在
 * %USERPROFILE%\.dsh\phone-chat\config.json。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = 8787
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const MODULE_SRC = path.join(ROOT, 'aurabot-module', 'phone-bridge')
const MODULE_DST = path.join(DSH_HOME, 'plugins-data', 'aurabot', 'modules', 'phone-bridge')

export const name = 'dafeiyu-phone-chat'
export const inject = []

function log(ctx, level, text) {
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') logger[level](text)
  else if (level === 'error') console.error(`[dafeiyu-phone-chat] ${text}`)
  else console.log(`[dafeiyu-phone-chat] ${text}`)
}

function copyModule(ctx) {
  try {
    if (!fs.existsSync(MODULE_SRC)) {
      log(ctx, 'warn', `找不到 Aurabot 模块源：${MODULE_SRC}`)
      return
    }
    fs.mkdirSync(path.dirname(MODULE_DST), { recursive: true })
    fs.cpSync(MODULE_SRC, MODULE_DST, { recursive: true, force: true })
    log(ctx, 'info', `Aurabot 手机桥模块已安装：${MODULE_DST}`)
  } catch (error) {
    log(ctx, 'warn', `安装 Aurabot 模块失败：${error.message}`)
  }
}

function nodeRuntime() {
  const resources = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources')
  const candidates = [
    process.env.DSH_NODE,
    process.env.DSH_NODE_PATH,
    path.join(resources, 'runtime', 'x64', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(path.dirname(process.execPath), 'resources', 'runtime', 'x64', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { exe: candidate, env: {} }
    } catch {}
  }
  // Electron 自带 Node 模式；比找不到 Node 时直接失败要好。
  return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export function apply(ctx) {
  copyModule(ctx)

  let child = null
  let disposed = false
  let restartTimer = null

  async function start() {
    if (disposed) return
    if (await portOpen(PORT)) {
      log(ctx, 'info', `检测到 ${PORT} 已有网关在运行，插件不重复启动`)
      return
    }
    const node = nodeRuntime()
    child = spawn(node.exe, [path.join(ROOT, 'server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, ...node.env, DSH_PHONE_PLUGIN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log(ctx, 'info', `大肥鱼手机聊天网关已启动（PID ${child.pid}，端口 ${PORT}）`)

    const relay = (stream, level) => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) if (line.trim()) log(ctx, level, line.trim())
      })
    }
    relay(child.stdout, 'info')
    relay(child.stderr, 'warn')

    child.once('error', (error) => {
      log(ctx, 'error', `网关启动失败：${error.message}`)
      child = null
    })
    child.once('exit', (code, signal) => {
      child = null
      if (disposed) return
      log(ctx, 'warn', `网关退出（code=${code}, signal=${signal}），5 秒后重试`)
      restartTimer = setTimeout(() => void start(), 5000)
    })
  }

  function dispose() {
    disposed = true
    if (restartTimer) clearTimeout(restartTimer)
    if (child && !child.killed) {
      try { child.kill() } catch {}
      log(ctx, 'info', '网关已停止')
    }
  }

  void start()
  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose)
  return dispose
}
