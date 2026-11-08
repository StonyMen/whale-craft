// -*- coding: utf-8 -*-
/**
 * 常驻桥接（workbuddy bridge）——给"没有 MCP 信任 / 想跨轮次保活"的场景用
 * ============================================================================
 * 为什么有它：
 *   MCP 服务器（mcp/server.mjs）的生命周期绑在宿主会话上，且新加的 server 要先在界面
 *   点「信任」才会被拉起。想在**信任之前**就能操作机器人、或者让 bot 跨对话轮次一直在线，
 *   就需要一个自己能管住的常驻进程。
 *
 * 做法：和 MCP 版共用同一个 host-shim（插件代码零改动），只是把 transport 从 stdio
 * 换成 **本地 HTTP**（只绑 127.0.0.1），调用方用 curl 就能跑工具。
 *
 *   GET  /health          → 进程与 bot 概况
 *   GET  /tools           → 工具清单（名字 + 首行说明）
 *   POST /call            → {"name":"mc_status","args":{}}  →  {"ok":true,"text":"..."}
 *   POST /shutdown        → 优雅下线并退出
 *
 * 环境变量：
 *   BRIDGE_PORT       监听端口（默认 18614）
 *   BRIDGE_HOST       监听地址（默认 127.0.0.1，**不要**改成 0.0.0.0）
 *   WHALE_CRAFT_STATE_DIR / WB_AGENT_ID / WB_BOT_NAME / WB_DEBUG  同 MCP 版
 *   BRIDGE_AUTOCONNECT  启动后自动连（形如 127.0.0.1:25565）
 * ============================================================================
 */
import { createServer } from 'node:http'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGIN_ENTRY = join(ROOT, 'index.js')

const env = process.env
const PORT = Number(env.BRIDGE_PORT ?? 18614)
const HOST = String(env.BRIDGE_HOST ?? '127.0.0.1')
const STATE_DIR = String(env.WHALE_CRAFT_STATE_DIR ?? '').trim() || join(homedir(), '.workbuddy', 'whale_craft')
const AGENT_ID = String(env.WB_AGENT_ID ?? '').trim() || 'workbuddy'
const CWD = String(env.WB_CWD ?? '').trim() || ROOT
const BOT_NAME = String(env.WB_BOT_NAME ?? '').trim()
const AUTOCONNECT = String(env.BRIDGE_AUTOCONNECT ?? '').trim()
const DEBUG = env.WB_DEBUG === '1' || env.WB_DEBUG === 'true'

mkdirSync(STATE_DIR, { recursive: true })
const BRIDGE_LOG = join(STATE_DIR, 'bridge.log')
const say = (m) => {
  const line = `[bridge ${new Date().toISOString().slice(11, 19)}] ${m}\n`
  process.stderr.write(line)
  try { appendFileSync(BRIDGE_LOG, line) } catch {}
}
const debug = (m) => { if (DEBUG) say(`debug: ${m}`) }

const ALLOW = [
  'mc_connect', 'mc_status', 'mc_context', 'mc_players', 'mc_inventory', 'mc_events',
  'mc_scan', 'mc_map', 'mc_height', 'mc_entities',
  'mc_move', 'mc_act', 'mc_dig', 'mc_build', 'mc_give', 'mc_sequence',
  'mc_say', 'mc_command', 'mc_disconnect',
  'mc_ping', 'mc_lan', 'mc_accounts', 'mc_capabilities', 'mc_kit_rules',
]

function render (value) {
  if (value === undefined) return 'null'
  if (typeof value === 'string') return value
  let compact
  try { compact = JSON.stringify(value) } catch { return String(value) }
  if (compact === undefined) return String(value)
  return compact
}

/* ───────────────── 启动：预置账户 → 载入插件 → 拿工具表 ───────────────── */

async function seedBotName (name) {
  if (!name) return
  if (!/^[\w\u4e00-\u9fa5.]{1,32}$/.test(name)) { say(`WB_BOT_NAME="${name}" 不合法，忽略`); return }
  try {
    const { AccountStore } = await import(pathToFileURL(join(ROOT, 'src', 'accounts.mjs')).href)
    const store = new AccountStore({ dir: STATE_DIR })
    store.ensureDefaults()
    const hit = store.list().find((a) => a.type === 'offline' && a.name === name)
    if (hit) { store.update(hit.innerID, { default: true }); return }
    const created = store.add({ type: 'offline', name })
    store.update(created.innerID, { default: true })
    say(`已新建离线账户 ${name} 并设为默认`)
  } catch (e) { say(`预置账户失败（继续用默认）：${e?.message ?? e}`) }
}

await seedBotName(BOT_NAME)

const { loadPluginTools } = await import(pathToFileURL(join(HERE, '..', 'mcp', 'host-shim.mjs')).href)
const harness = await loadPluginTools({
  pluginEntry: PLUGIN_ENTRY,
  config: {},
  debug: (m) => debug(m.replace(/^\[whale_craft [^\]]+\]\s*/, '')),
})

const exposed = new Map()
for (const name of ALLOW) {
  const tool = harness.tools.get(name)
  if (!tool) { debug(`插件工具表里没有 ${name}`); continue }
  exposed.set(name, tool)
}
say(`插件已载入：暴露 ${exposed.size}/${harness.tools.size} 个工具｜state=${STATE_DIR}`)

/* ───────────────── 工具调用（串行队列，一个 bot 不能并发） ───────────────── */

let abortCtl = new AbortController()
const execFor = () => ({
  agent: { id: AGENT_ID, session: { header: { cwd: CWD } } },
  signal: abortCtl.signal,
})

let queue = Promise.resolve()
let busy = null

async function callTool (name, args) {
  const tool = exposed.get(name)
  if (!tool) throw new Error(`没有这个工具：${name}（可用：${[...exposed.keys()].join('/')}）`)
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new Error('args 必须是一个对象')
  }
  const run = async () => {
    busy = name
    try { return render(await tool.execute(args ?? {}, execFor())) } finally { busy = null }
  }
  const p = queue.then(run, run)
  queue = p.catch(() => {})
  return p
}

/* ───────────────── HTTP ───────────────── */

function readBody (req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        busy,
        stateDir: STATE_DIR,
        tools: exposed.size,
        uptimeSec: Math.round(process.uptime()),
        botName: BOT_NAME || null,
      })
    }
    if (req.method === 'GET' && url.pathname === '/tools') {
      return json(res, 200, {
        ok: true,
        tools: [...exposed.entries()].map(([name, t]) => ({
          name,
          summary: String(t.description ?? '').split('\n')[0].slice(0, 160),
          parameters: t.parameters ?? null,
        })),
      })
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      const raw = await readBody(req)
      let body
      try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }) }
      const name = String(body?.name ?? '')
      if (!name) return json(res, 400, { ok: false, error: '缺少 name' })
      try {
        const text = await callTool(name, body?.args)
        return json(res, 200, { ok: true, name, text })
      } catch (e) {
        return json(res, 200, { ok: false, name, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      json(res, 200, { ok: true, bye: true })
      setTimeout(() => shutdown('shutdown 请求'), 100)
      return
    }
    return json(res, 404, { ok: false, error: `未知路由 ${req.method} ${url.pathname}` })
  } catch (e) {
    try { json(res, 500, { ok: false, error: String(e?.message ?? e) }) } catch {}
  }
})

/* ───────────────── 自动连服（可选） ───────────────── */

async function autoConnect (addr) {
  try {
    say(`自动连接 ${addr} …`)
    const text = await callTool('mc_connect', { address: addr })
    say(`自动连接完成：${text.slice(0, 300)}`)
  } catch (e) {
    say(`自动连接失败：${e?.message ?? e}`)
  }
}

/* ───────────────── 收尾 ───────────────── */

let closing = false
async function shutdown (why) {
  if (closing) return
  closing = true
  say(`收尾：${why}`)
  try {
    const st = await callTool('mc_status', {})
    if (/"online":\s*true/.test(st) || /online.*true/.test(st)) await callTool('mc_disconnect', { reason: 'bridge 关闭' })
  } catch (e) { debug(`下线失败（忽略）：${e?.message ?? e}`) }
  try { harness.dispose() } catch {}
  try { server.close() } catch {}
  setTimeout(() => process.exit(0), 300)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (e) => say(`未处理的 rejection（已忽略）：${e?.message ?? e}`))
process.on('uncaughtException', (e) => say(`未捕获异常（已忽略）：${e?.message ?? e}`))

server.listen(PORT, HOST, () => {
  say(`监听 http://${HOST}:${PORT}｜pid=${process.pid}`)
  if (AUTOCONNECT) autoConnect(AUTOCONNECT)
})
