/**
 * DSH Phone Chat — PC gateway (MVP)
 *
 * Phone  <->  this gateway  <->  Aurabot phone-bridge module (127.0.0.1)
 *
 * The gateway only talks to the Aurabot module's loopback HTTP/SSE endpoint.
 * It never talks to QQ.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const sea = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sea') : null
const ROOT = process.cwd()
const DATA_DIR = process.env.DSH_PHONE_DATA || path.join(os.homedir(), '.dsh', 'phone-chat')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const MEDIA_DIR = path.join(DATA_DIR, 'media')
const STT_SCRIPT = path.join(DATA_DIR, 'stt.ps1')
const STICKER_DIR = path.join(os.homedir(), '.dsh', 'plugins-data', 'aurabot', 'stickers')
const DIARY_FILE = path.join(os.homedir(), '.dsh', 'plugins-data', 'aurabot', 'diary.json')
const BRIDGE_TOKEN_FILE = path.join(
  os.homedir(),
  '.dsh',
  'plugins-data',
  'aurabot',
  'modules-data',
  'phone-bridge',
  'token',
)

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(MEDIA_DIR, { recursive: true })
installSttScript()

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function saveSessions() {
  const now = Date.now()
  const out = {}
  for (const [token, expires] of sessions) if (Number(expires) > now) out[token] = Number(expires)
  try { writeJson(SESSIONS_FILE, out) } catch (error) { console.warn('[session] save failed:', error.message) }
}

function randomCode() {
  return String(crypto.randomInt(100000, 999999))
}

const config = readJson(CONFIG_FILE, null) || {
  port: 8787,
  accessCode: randomCode(),
  bridgeUrl: 'http://127.0.0.1:37901',
  bridgeTokenFile: BRIDGE_TOKEN_FILE,
  autoStartDsh: true,
  dshExe: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH NEXT', 'DSH NEXT.exe'),
  createdAt: new Date().toISOString(),
}
if (!config.accessCode) config.accessCode = randomCode()
if (!config.bridgeTokenFile) config.bridgeTokenFile = BRIDGE_TOKEN_FILE
if (config.autoStartDsh === undefined) config.autoStartDsh = true
if (!config.dshExe) config.dshExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH NEXT', 'DSH NEXT.exe')
writeJson(CONFIG_FILE, config)

let bridgeToken = ''
try {
  bridgeToken = fs.readFileSync(config.bridgeTokenFile, 'utf8').trim()
} catch {}

const sessions = new Map(Object.entries(readJson(SESSIONS_FILE, {}))) // token -> expiresAt
const switches = new Map() // one-time switch code -> { token, expiresAt }
const loginAttempts = new Map() // ip -> { at, count }
const phoneClients = new Set() // res
const messages = readJson(MESSAGES_FILE, [])
let bridge = { connected: false, lastError: '', lastAt: 0 }
let saveTimer = null

function saveMessagesSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeJson(MESSAGES_FILE, messages.slice(-500))
    } catch (error) {
      console.error('[history] save failed:', error.message)
    }
  }, 300)
}

function stickerList() {
  try {
    const index = readJson(path.join(STICKER_DIR, 'index.json'), { items: [] })
    return (index.items || [])
      .filter((item) => item && item.file && fs.existsSync(path.join(STICKER_DIR, item.file)))
      .sort((a, b) => Number(b.lastUsed || 0) - Number(a.lastUsed || 0))
      .slice(0, 80)
      .map((item) => ({
        id: String(item.md5 || item.file),
        file: String(item.file),
        name: String(item.name || '表情'),
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 5) : [],
      }))
  } catch {
    return []
  }
}

function findSticker(id) {
  return stickerList().find((item) => item.id === String(id) || item.file === String(id))
}

function diaryList() {
  const data = readJson(DIARY_FILE, { history: [] })
  const items = Array.isArray(data.history) ? data.history : []
  return items
    .filter((item) => item && item.text)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, 100)
    .map((item) => ({
      at: Number(item.at || 0),
      text: String(item.text || ''),
      ok: Boolean(item.ok),
      visibility: String(item.visibility || 'all'),
    }))
}

function decodeBase64File(src) {
  const s = String(src || '')
  if (!s.startsWith('base64://')) return null
  try {
    return Buffer.from(s.slice(9), 'base64')
  } catch {
    return null
  }
}

function mediaExt(buf) {
  if (!buf || buf.length < 4) return 'bin'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE') return 'wav'
  if (buf.slice(0, 4).toString('ascii') === 'OggS') return 'ogg'
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3'
  if (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) return 'mp3'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buf.slice(0, 2).toString('ascii') === '#!') return 'amr'
  return 'bin'
}

function saveMedia(buf) {
  const ext = mediaExt(buf)
  const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`
  fs.writeFileSync(path.join(MEDIA_DIR, file), buf)
  return { file, url: `/media/${file}` }
}

function mediaTypeOf(file) {
  const ext = path.extname(file).toLowerCase()
  return {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.amr': 'audio/amr', '.mp4': 'video/mp4',
  }[ext] || 'application/octet-stream'
}

function installSttScript() {
  let text = ''
  if (sea?.isSea()) {
    try { text = sea.getAsset('stt', 'utf8') } catch {}
  }
  if (!text) {
    try { text = fs.readFileSync(path.join(ROOT, 'stt.ps1'), 'utf8') } catch {}
  }
  if (text) fs.writeFileSync(STT_SCRIPT, text, 'utf8')
}

function wav16k(buf) {
  if (!buf || buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, buf.length - body) }
      break
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.rate) return null
  const frames = Math.floor(data.size / (2 * fmt.channels))
  const mono = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) sum += buf.readInt16LE(data.offset + (i * fmt.channels + c) * 2)
    mono[i] = Math.max(-32768, Math.min(32767, Math.round(sum / fmt.channels)))
  }
  if (fmt.rate === 16000) {
    const out = Buffer.alloc(44 + mono.length * 2)
    out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + mono.length * 2, 4); out.write('WAVE', 8, 'ascii')
    out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
    out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
    out.write('data', 36, 'ascii'); out.writeUInt32LE(mono.length * 2, 40)
    for (let i = 0; i < mono.length; i++) out.writeInt16LE(mono[i], 44 + i * 2)
    return out
  }
  const ratio = 16000 / fmt.rate
  const outLen = Math.max(1, Math.floor(mono.length * ratio))
  const out = Buffer.alloc(44 + outLen * 2)
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + outLen * 2, 4); out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii'); out.writeUInt32LE(outLen * 2, 40)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio
    const a = Math.floor(srcPos)
    const b = Math.min(mono.length - 1, a + 1)
    const t = srcPos - a
    const sample = Math.round(mono[a] * (1 - t) + mono[b] * t)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), 44 + i * 2)
  }
  return out
}

async function transcribeWav(file) {
  try {
    const src = fs.readFileSync(file)
    const prepared = wav16k(src) || src
    const temp = path.join(MEDIA_DIR, `stt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`)
    fs.writeFileSync(temp, prepared)
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STT_SCRIPT, '-Path', temp,
      ], { timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 })
      const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim() || '{}')
      return String(parsed.text || '').trim()
    } finally {
      try { fs.unlinkSync(temp) } catch {}
    }
  } catch (error) {
    console.warn('[stt]', error.message)
    return ''
  }
}

function addMessage(role, text, extra = {}) {
  const msg = {
    id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    role,
    text: String(text || '').trim(),
    at: Date.now(),
    ...extra,
  }
  if (!msg.text && !(msg.media && msg.media.length)) return null
  messages.push(msg)
  if (messages.length > 500) messages.splice(0, messages.length - 500)
  saveMessagesSoon()
  broadcast('message', msg)
  return msg
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of phoneClients) {
    try {
      res.write(payload)
    } catch {}
  }
}

function parseCookies(header = '') {
  const out = {}
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function sessionToken(req) {
  const cookies = parseCookies(req.headers.cookie)
  return cookies.dsh_phone_session || ''
}

function authorize(req) {
  const token = sessionToken(req)
  const expires = sessions.get(token)
  if (!expires) return false
  if (Date.now() > expires) {
    sessions.delete(token)
    return false
  }
  return true
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function loginBlocked(req) {
  const ip = req.socket.remoteAddress || ''
  const row = loginAttempts.get(ip)
  if (!row) return false
  if (Date.now() - row.at > 60_000) {
    loginAttempts.delete(ip)
    return false
  }
  return row.count >= 8
}

function noteLoginFailure(req) {
  const ip = req.socket.remoteAddress || ''
  const row = loginAttempts.get(ip)
  if (!row || Date.now() - row.at > 60_000) loginAttempts.set(ip, { at: Date.now(), count: 1 })
  else row.count += 1
}

function lanUrls() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address, url: `http://${item.address}:${config.port}/` })
    }
  }
  return out
}

function endpointInfo(req) {
  const urls = lanUrls()
  const local = urls.find((x) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address) && !x.address.startsWith('100.'))
  const remote = urls.find((x) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(x.address))
  const bare = (url) => String(url || '').replace(/\/$/, '')
  return {
    local: bare(local?.url),
    remote: bare(remote?.url),
    current: `http://${req.headers.host || ''}`,
    localName: local?.name || '',
    remoteName: remote?.name || '',
  }
}

function oneBotParts(segments) {
  const arr = Array.isArray(segments) ? segments : []
  const parts = []
  const media = []
  let hasVoice = false
  for (const seg of arr) {
    const type = seg?.type
    const data = seg?.data || {}
    if (type === 'text') {
      parts.push(String(data.text || ''))
    } else if (type === 'image' || type === 'mface') {
      const isSticker = type === 'mface' || String(data.sub_type ?? data.subType ?? '') === '1' || Boolean(data.emoji_id || data.emojiId)
      const buf = decodeBase64File(data.file)
      if (buf) {
        const saved = saveMedia(buf)
        media.push({ type: isSticker ? 'sticker' : 'image', url: saved.url })
      } else if (typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
        media.push({ type: isSticker ? 'sticker' : 'image', url: data.url })
      } else {
        parts.push(isSticker ? '[表情]' : '[图片]')
      }
    } else if (type === 'record') {
      const buf = decodeBase64File(data.file)
      if (buf) {
        const saved = saveMedia(buf)
        media.push({ type: 'audio', url: saved.url })
      } else {
        hasVoice = true
      }
    } else if (type === 'face') {
      parts.push('[表情]')
    } else if (type === 'at') {
      parts.push(`@${data.qq || ''}`)
    } else if (type === 'reply') {
      /* quote handled by Aurabot */
    }
  }
  let text = parts.join('').trim()
  if (!text && hasVoice) text = '[语音]'
  return { text, media }
}

function bridgeHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-phone-token': bridgeToken,
  }
}

async function bridgeInbound(payload) {
  if (!bridgeToken) throw new Error('Aurabot phone-bridge token 不存在')
  const res = await fetch(`${config.bridgeUrl}/inbound`, {
    method: 'POST',
    headers: bridgeHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`bridge HTTP ${res.status}`)
  return res.json()
}

async function bridgeLoop() {
  if (!bridgeToken) {
    bridge = { connected: false, lastError: 'Aurabot phone-bridge token 不存在', lastAt: Date.now() }
    setTimeout(bridgeLoop, 3000)
    return
  }
  try {
    const res = await fetch(`${config.bridgeUrl}/events?token=${encodeURIComponent(bridgeToken)}`, {
      headers: { accept: 'text/event-stream' },
    })
    if (!res.ok || !res.body) throw new Error(`bridge HTTP ${res.status}`)
    bridge = { connected: true, lastError: '', lastAt: Date.now() }
    broadcast('bridge', bridge)
    try {
      await fetch(`${config.bridgeUrl}/arm`, { method: 'POST', headers: bridgeHeaders(), signal: AbortSignal.timeout(5000) })
    } catch {}

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        let event = 'message'
        const dataLines = []
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (event === 'message' && dataLines.length) {
          try {
            const payload = JSON.parse(dataLines.join('\n'))
            if (payload.type === 'out') {
              const parsed = oneBotParts(payload.message)
              if (parsed.text || parsed.media.length) {
                addMessage('assistant', parsed.text, { media: parsed.media, via: 'aurabot' })
              }
            }
          } catch (error) {
            console.warn('[bridge] bad event:', error.message)
          }
        }
      }
    }
  } catch (error) {
    bridge = { connected: false, lastError: String(error.message || error), lastAt: Date.now() }
    broadcast('bridge', bridge)
  }
  setTimeout(bridgeLoop, 2000)
}

function ensureDsh({ quiet = false } = {}) {
  if (!config.autoStartDsh) return
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DSH NEXT.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    if (out.toLowerCase().includes('dsh next.exe')) {
      if (!quiet) console.log('[dsh] already running')
      return
    }
  } catch {}
  if (!fs.existsSync(config.dshExe)) {
    console.log('[dsh] executable not found:', config.dshExe)
    return
  }
  try {
    console.log('[dsh] starting:', config.dshExe)
    const child = spawn(config.dshExe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
  } catch (error) {
    console.error('[dsh] start failed:', error.message)
  }
}

function htmlPage() {
  if (sea?.isSea()) {
    try {
      return sea.getAsset('index.html', 'utf8')
    } catch (error) {
      console.error('[ui] sea asset missing:', error.message)
    }
  }
  const file = path.join(ROOT, 'public', 'index.html')
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return '<!doctype html><meta charset="utf-8"><h1>DSH Phone Chat</h1><p>public/index.html missing.</p>'
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const switchCode = url.searchParams.get('switch')
    if (switchCode) {
      const row = switches.get(switchCode)
      switches.delete(switchCode)
      if (row && row.expiresAt > Date.now() && sessions.has(row.token)) {
        res.writeHead(302, {
          location: '/',
          'set-cookie': `dsh_phone_session=${row.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
    }
    const html = htmlPage()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && pathname === '/apk') {
    try {
      let buf
      if (sea?.isSea()) buf = Buffer.from(sea.getAsset('apk'))
      else buf = fs.readFileSync(path.join(ROOT, 'public', 'dafeiyu-chat.apk'))
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-disposition': 'attachment; filename="dafeiyu-chat.apk"',
        'content-length': buf.length,
        'cache-control': 'no-store',
      })
      res.end(buf)
    } catch (error) {
      json(res, 404, { ok: false, error: 'APK not bundled' })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const ok = authorize(req)
    json(res, ok ? 200 : 401, {
      ok,
      bridge,
      user: ok ? '主人' : null,
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    if (loginBlocked(req)) return json(res, 429, { ok: false, error: '尝试次数太多，稍后再试' })
    try {
      const body = JSON.parse(await readBody(req))
      if (String(body.code || '') !== config.accessCode) {
        noteLoginFailure(req)
        return json(res, 401, { ok: false, error: '访问码不对' })
      }
      const token = crypto.randomBytes(24).toString('base64url')
      sessions.set(token, Date.now() + 30 * 24 * 3600 * 1000)
      saveSessions()
      res.setHeader('set-cookie', `dsh_phone_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`)
      json(res, 200, { ok: true })
    } catch {
      json(res, 400, { ok: false, error: 'bad request' })
    }
    return
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = sessionToken(req)
    sessions.delete(token)
    saveSessions()
    res.setHeader('set-cookie', 'dsh_phone_session=; Path=/; HttpOnly; Max-Age=0')
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && pathname === '/api/endpoints') {
    if (!authorize(req)) return json(res, 401, { ok: false })
    json(res, 200, { ok: true, ...endpointInfo(req) })
    return
  }

  if (req.method === 'POST' && pathname === '/api/switch') {
    if (!authorize(req)) return json(res, 401, { ok: false })
    try {
      const body = JSON.parse(await readBody(req))
      const info = endpointInfo(req)
      const target = body.to === 'remote' ? info.remote : info.local
      if (!target) return json(res, 404, { ok: false, error: '没有找到这个连接地址' })
      const token = sessionToken(req)
      const code = crypto.randomBytes(18).toString('base64url')
      switches.set(code, { token, expiresAt: Date.now() + 60_000 })
      json(res, 200, { ok: true, url: `${target}/?switch=${encodeURIComponent(code)}` })
    } catch (error) {
      json(res, 400, { ok: false, error: error.message })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/stickers') {
    if (!authorize(req)) return json(res, 401, { ok: false })
    json(res, 200, { ok: true, stickers: stickerList() })
    return
  }

  if (req.method === 'GET' && pathname.startsWith('/stickers/')) {
    try {
      const name = decodeURIComponent(pathname.slice('/stickers/'.length))
      const sticker = findSticker(name)
      if (!sticker) {
        res.writeHead(404)
        res.end()
        return
      }
      const file = path.join(STICKER_DIR, sticker.file)
      const buf = fs.readFileSync(file)
      res.writeHead(200, {
        'content-type': mediaTypeOf(sticker.file),
        'content-length': buf.length,
        'cache-control': 'public, max-age=3600',
      })
      res.end(buf)
    } catch {
      res.writeHead(404)
      res.end()
    }
    return
  }

  if (req.method === 'GET' && pathname.startsWith('/media/')) {
    try {
      const name = path.basename(decodeURIComponent(pathname.slice('/media/'.length)))
      const file = path.join(MEDIA_DIR, name)
      const buf = fs.readFileSync(file)
      res.writeHead(200, {
        'content-type': mediaTypeOf(name),
        'content-length': buf.length,
        'cache-control': 'public, max-age=3600',
      })
      res.end(buf)
    } catch {
      res.writeHead(404)
      res.end()
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/diary') {
    if (!authorize(req)) return json(res, 401, { ok: false })
    json(res, 200, { ok: true, items: diaryList() })
    return
  }

  if (req.method === 'GET' && pathname === '/api/history') {
    if (!authorize(req)) return json(res, 401, { ok: false })
    json(res, 200, { ok: true, messages: messages.slice(-200), bridge })
    return
  }

  if (req.method === 'POST' && pathname === '/api/send') {
    if (!authorize(req)) return json(res, 401, { ok: false })
    try {
      const body = JSON.parse(await readBody(req))
      let text = String(body.text || '').trim()
      const payload = { text }
      const media = []

      if (body.stickerId) {
        const sticker = findSticker(body.stickerId)
        if (!sticker) return json(res, 404, { ok: false, error: 'sticker not found' })
        const file = path.join(STICKER_DIR, sticker.file)
        const buf = fs.readFileSync(file)
        payload.sticker = { name: sticker.name, base64: buf.toString('base64') }
        media.push({ type: 'sticker', url: `/stickers/${encodeURIComponent(sticker.file)}` })
      }

      if (body.voice) {
        const raw = String(body.voice).replace(/^data:audio\/[^;]+;base64,/i, '')
        const buf = Buffer.from(raw, 'base64')
        if (!buf.length) return json(res, 400, { ok: false, error: 'empty voice' })
        const saved = saveMedia(buf)
        media.push({ type: 'audio', url: saved.url })
        const transcript = await transcribeWav(path.join(MEDIA_DIR, saved.file))
        if (transcript) {
          console.log(`[stt] ${transcript}`)
          text = text ? `${text}\n${transcript}` : transcript
        } else if (!text) {
          text = '[语音]'
        }
      }

      if (!text && media.length === 0) return json(res, 400, { ok: false, error: 'empty' })
      payload.text = text
      const msg = addMessage('user', text, { media })
      try {
        await bridgeInbound(payload)
      } catch (error) {
        addMessage('assistant', `消息没送到 Aurabot：${error.message}`)
        return json(res, 502, { ok: false, error: error.message, message: msg })
      }
      json(res, 200, { ok: true, message: msg })
    } catch (error) {
      json(res, 400, { ok: false, error: error.message })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    if (!authorize(req)) return json(res, 401, { ok: false })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, bridge })}\n\n`)
    phoneClients.add(res)
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n') } catch {}
    }, 20000)
    req.on('close', () => {
      clearInterval(heartbeat)
      phoneClients.delete(res)
    })
    return
  }

  // The optional Android WebView shell polls these DSH-remote-access endpoints
  // for notifications. We do not expose DSH notifications here, so answer
  // "nothing pending" and keep the shell quiet without a 404 loop.
  if (req.method === 'GET' && pathname === '/__remote_access__/notify') {
    const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait')) || 0))
    const reply = () => {
      if (res.writableEnded || res.destroyed) return
      json(res, 200, {
        ok: true,
        rev: 1,
        at: Date.now(),
        boot: 'dsh-phone-chat',
        enabled: false,
        enabledFinish: false,
        onlyWhenWindowHidden: true,
        desktop: { known: false, visible: false, at: 0 },
        phone: null,
        pending: [],
        finish: null,
      })
    }
    if (wait > 0) {
      const timer = setTimeout(reply, wait * 1000)
      req.on('close', () => clearTimeout(timer))
    } else {
      reply()
    }
    return
  }

  if (pathname === '/__remote_access__/presence' || pathname === '/__remote_access__/cache') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && pathname === '/admin') {
    const remote = req.socket.remoteAddress || ''
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!local) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('admin is local-only')
      return
    }
    const rows = lanUrls().map((x) => `<li><a href="${x.url}">${x.url}</a> <small>${x.name}</small></li>`).join('')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>DSH Phone Chat</title>
      <style>body{font-family:system-ui;margin:40px;line-height:1.7;background:#0f1218;color:#e8edf5}a{color:#7fb5ff}code{background:#1c2330;padding:2px 6px;border-radius:4px}</style>
      <h1>DSH Phone Chat</h1>
      <p>访问码：<code>${config.accessCode}</code></p>
      <p>手机地址（同一 Wi-Fi）：</p><ul>${rows || '<li>未找到局域网地址</li>'}</ul>
      <p>桥接：${bridge.connected ? '已连接' : '未连接'} ${bridge.lastError ? `（${bridge.lastError}）` : ''}</p>
      <p>把这行地址和访问码填进手机 App，或在手机浏览器打开。</p>`)
    return
  }

  json(res, 404, { ok: false, error: 'not found' })
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use — DSH Phone Chat is probably already running.`)
    process.exit(0)
  }
  console.error('[http]', error)
  process.exit(1)
})

server.listen(config.port, '0.0.0.0', () => {
  console.log(`DSH Phone Chat gateway http://127.0.0.1:${config.port}/`)
  for (const item of lanUrls()) console.log(`  phone: ${item.url} (${item.name})`)
  console.log(`  access code: ${config.accessCode}`)
  console.log(`  bridge token: ${bridgeToken ? 'loaded' : 'MISSING'}`)
  ensureDsh()
  bridgeLoop()
  setInterval(() => {
    if (!bridge.connected) ensureDsh({ quiet: true })
  }, 30000).unref()
})
