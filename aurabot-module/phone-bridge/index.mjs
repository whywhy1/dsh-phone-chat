/**
 * Aurabot "phone bridge" user module.
 *
 * It is deliberately small: Aurabot remains the brain, this module only
 * translates between a local phone gateway (127.0.0.1 HTTP/SSE) and Aurabot's
 * own chat hub. No QQ / OneBot connection is used for phone messages.
 *
 * Exposed on loopback only:
 *   GET  /health
 *   GET  /status
 *   GET  /events?token=...        (SSE, outgoing messages)
 *   POST /inbound                 (incoming phone message, x-phone-token)
 *
 * The phone-facing public server (LAN / remote) is a separate EXE.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = 37901
const HOST = '127.0.0.1'
const PHONE_ACTIVE_MS = 24 * 60 * 60 * 1000

function readJsonBody(req, limit = 2 * 1024 * 1024) {
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
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export default {
  id: 'phone-bridge',
  name: '手机聊天桥',
  version: '0.1.0',
  api: 1,
  description: '把 Aurabot 的私聊接到本地手机网关（不经过 QQ）',

  async setup(api) {
    const cfg = api.config()
    const ownerQQ = String(cfg.ownerQQ || '').trim()
    if (!ownerQQ) throw new Error('Aurabot 还没配置 ownerQQ，无法建立手机私聊')
    const chatId = `private:${ownerQQ}`
    const tokenFile = path.join(api.dataDir(), 'token')
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true })
    let token = ''
    try { token = fs.readFileSync(tokenFile, 'utf8').trim() } catch {}
    if (!token) {
      token = crypto.randomBytes(24).toString('base64url')
      fs.writeFileSync(tokenFile, token, { mode: 0o600 })
    }

    const hub = api.core.hub
    if (!hub || typeof hub.onMessage !== 'function') {
      throw new Error('Aurabot hub.onMessage 不可用（版本不兼容）')
    }

    const clients = new Set()
    let phoneActiveUntil = 0
    let inboundCount = 0
    let outboundCount = 0

    const broadcast = (payload) => {
      const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`
      for (const res of clients) {
        try { res.write(data) } catch {}
      }
    }

    const active = () => Date.now() < phoneActiveUntil

    // Aurabot's OneBot client is not connected in phone mode. Its private-chat
    // typing indicator would otherwise retry 1s+3s+5s before every reply.
    const onebot = api.core.onebot
    const originalOnebotCall = onebot && typeof onebot.call === 'function' ? onebot.call.bind(onebot) : null
    if (onebot && originalOnebotCall) {
      onebot.call = (action, params, opts) => {
        if (active() && action === 'set_input_status') return Promise.resolve({ ok: true })
        if (active() && action === 'get_record' && typeof params?.file === 'string' && params.file.startsWith('base64://')) {
          return Promise.resolve({ base64: params.file.slice(9) })
        }
        return originalOnebotCall(action, params, opts)
      }
    }
    // Phone-only mode: keep Aurabot's QQ gateway from reconnecting while this
    // module is loaded. The module is the transport now.
    const originalOnebotStart = onebot && typeof onebot.start === 'function' ? onebot.start.bind(onebot) : null
    if (onebot && originalOnebotStart) {
      onebot.start = () => {}
      try { onebot.stop?.() } catch {}
    }

    // All Aurabot outgoing messages pass through here. Only intercept the
    // phone owner's private chat, and only after a phone message recently
    // arrived, so a future real QQ connection is not silently swallowed.
    api.on('send', (message, meta) => {
      if (!active()) return
      if (meta?.chatId !== chatId) return
      outboundCount += 1
      broadcast({
        type: 'out',
        chatId,
        message,
        note: meta.note || '',
        at: Date.now(),
      })
      return null // suppress OneBot/QQ send
    })

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
      const supplied = req.headers['x-phone-token'] || url.searchParams.get('token') || ''
      const authorized = supplied === token

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          bridge: 'phone-bridge',
          version: '0.1.0',
          ownerQQ,
          chatId,
          hubOnMessage: typeof hub.onMessage,
          clients: clients.size,
          active: active(),
          inboundCount,
          outboundCount,
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        if (!authorized) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        sendJson(res, 200, {
          ok: true,
          ownerQQ,
          chatId,
          active: active(),
          phoneActiveUntil,
          clients: clients.size,
          inboundCount,
          outboundCount,
          aurabot: {
            enabled: Boolean(cfg.enabled),
            dryRun: Boolean(cfg.dryRun),
            gateway: cfg.gateway,
          },
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        if (!authorized) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, ownerQQ, chatId })}\n\n`)
        clients.add(res)
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n') } catch {}
        }, 15000)
        req.on('close', () => {
          clearInterval(heartbeat)
          clients.delete(res)
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/arm') {
        if (!authorized) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        phoneActiveUntil = Date.now() + PHONE_ACTIVE_MS
        sendJson(res, 200, { ok: true, phoneActiveUntil })
        return
      }

      if (req.method === 'POST' && url.pathname === '/inbound') {
        if (!authorized) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        try {
          const body = await readJsonBody(req)
          const text = String(body.text || '').trim()
          const images = Array.isArray(body.images) ? body.images.slice(0, 9) : []
          const sticker = body.sticker && typeof body.sticker === 'object' ? body.sticker : null
          const voice = typeof body.voice === 'string' ? body.voice : ''
          if (!text && images.length === 0 && !sticker?.base64 && !voice) {
            return sendJson(res, 400, { ok: false, error: 'empty message' })
          }

          const message = []
          if (text) message.push({ type: 'text', data: { text } })
          for (const image of images) {
            if (image && typeof image === 'object' && image.url) {
              message.push({ type: 'image', data: { file: String(image.url) } })
            }
          }
          if (sticker?.base64) {
            const name = String(sticker.name || '表情').slice(0, 20)
            message.push({
              type: 'mface',
              data: {
                summary: `[${name}]`,
                file: `base64://${String(sticker.base64)}`,
                sub_type: 1,
              },
            })
          }
          if (voice) {
            message.push({ type: 'record', data: { file: `base64://${voice}` } })
          }

          const now = Date.now()
          phoneActiveUntil = now + PHONE_ACTIVE_MS
          inboundCount += 1
          const event = {
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            self_id: 10000,
            user_id: Number(ownerQQ),
            message_id: now,
            message,
            raw_message: text,
            time: Math.floor(now / 1000),
            sender: {
              user_id: Number(ownerQQ),
              nickname: String(cfg.ownerName || '主人'),
              card: String(cfg.ownerName || '主人'),
            },
          }
          const what = [
            text ? `文字 ${text.slice(0, 40)}` : '',
            images.length ? `${images.length} 图` : '',
            sticker?.base64 ? `表情「${String(sticker.name || '表情').slice(0, 20)}」` : '',
            voice ? '语音' : '',
          ].filter(Boolean).join(' + ')
          api.log.info(`手机消息进入 Aurabot：${what}`)
          // Do not block the phone request on a full agent turn.
          hub.onMessage(event).catch((error) => api.log.error('hub.onMessage 失败：', error.message))
          sendJson(res, 200, { ok: true, accepted: true, chatId })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error.message || error) })
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(PORT, HOST, () => resolve())
    })
    api.log.info(`手机桥已监听 http://${HOST}:${PORT}（owner=${ownerQQ}，token=${tokenFile}）`)

    api.onDispose(() => {
      for (const res of clients) {
        try { res.end() } catch {}
      }
      clients.clear()
      if (onebot && originalOnebotCall) onebot.call = originalOnebotCall
      if (onebot && originalOnebotStart) onebot.start = originalOnebotStart
      try { server.close() } catch {}
    })

    return {
      port: PORT,
      tokenFile,
      status: () => ({ clients: clients.size, active: active(), inboundCount, outboundCount }),
    }
  },
}
