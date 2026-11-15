#!/usr/bin/env node
/**
 * 设置本机手机聊天访问码。
 *
 * 用法：
 *   node scripts/set-code.mjs "my-strong-code"
 *
 * 需要先启动过一次网关，让 ~/.dsh/phone-chat/config.json 生成。
 * 改完重启网关（或禁用/启用 DSH 插件）生效。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const code = String(process.argv[2] || '').trim()
if (code.length < 6 || code.length > 64) {
  console.error('访问码长度需要 6–64 个字符。')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const configPath = path.join(dshHome, 'phone-chat', 'config.json')

if (!fs.existsSync(configPath)) {
  console.error(`找不到 ${configPath}`)
  console.error('先启动一次网关（或启用 DSH 插件），再运行本脚本。')
  process.exit(1)
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
config.accessCode = code
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
console.log(`访问码已更新：${configPath}`)
console.log('重启网关 / 重新启用 DSH 插件后生效。')
