/**
 * Build the Windows single-file EXE.
 *
 * Requirements:
 *   - Node.js 24+ (must run with node, not Electron)
 *   - `npm install` (or pnpm install) in this build directory
 *   - Windows x64 (postject / SEA output is the running Node executable)
 *
 * Usage:
 *   cd build
 *   npm install
 *   npm run build
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'

if (process.versions.electron) {
  throw new Error('请用真实的 Node.js 24+ 运行此脚本，不要用 Electron 的 RunAsNode。')
}

const buildDir = import.meta.dirname
const root = path.resolve(buildDir, '..')
const dist = path.join(root, 'dist')
const serverBundle = path.join(buildDir, 'server.cjs')
const seaConfig = path.join(buildDir, 'sea.generated.json')
const seaBlob = path.join(buildDir, 'sea-prep.blob')
const exe = path.join(dist, 'DSH-Phone-Chat.exe')
const postjectCli = path.join(buildDir, 'node_modules', 'postject', 'dist', 'cli.js')

for (const required of [
  path.join(root, 'server.mjs'),
  path.join(root, 'public', 'index.html'),
  path.join(root, 'public', 'dafeiyu-chat.apk'),
  path.join(root, 'stt.ps1'),
  postjectCli,
]) {
  if (!fs.existsSync(required)) throw new Error(`缺少文件：${required}`)
}

fs.mkdirSync(dist, { recursive: true })

console.log('[1/4] bundle server.mjs -> server.cjs')
buildSync({
  entryPoints: [path.join(root, 'server.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: serverBundle,
  logLevel: 'info',
})

console.log('[2/4] generate Node SEA blob')
fs.writeFileSync(seaConfig, JSON.stringify({
  main: 'build/server.cjs',
  output: 'build/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {
    'index.html': 'public/index.html',
    apk: 'public/dafeiyu-chat.apk',
    stt: 'stt.ps1',
  },
}, null, 2))
execFileSync(process.execPath, [`--experimental-sea-config=${seaConfig}`], {
  cwd: root,
  stdio: 'inherit',
})

console.log('[3/4] copy Node executable')
fs.copyFileSync(process.execPath, exe)

console.log('[4/4] inject SEA blob')
execFileSync(process.execPath, [
  postjectCli,
  exe,
  'NODE_SEA_BLOB',
  seaBlob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' })

console.log(`done: ${exe}`)
