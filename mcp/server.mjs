#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * WorkBuddy 转接头 / server.mjs —— 把 whale_craft 变成 MCP 服务器
 * ============================================================================
 * 一句话：**DSH 插件 ↔ MCP 的胶水层**。它不改插件一行代码，只用 `host-shim.mjs` 喂一个假宿主
 * 把 apply() 跑起来，然后按 MCP（stdio / JSON-RPC 2.0）把工具暴露给 WorkBuddy。
 *
 * 与 DSH 版的差别（都是宿主能力缺失，不是功能退化实现）：
 *   · 没有看门狗 → **不能被动唤醒**。只有被调用时才会动，挂机时不会自己接话；
 *   · 没有 MC/MC+ 模式 → 工具面固定（就是下面 ALLOW 这份）；
 *   · 没有设置页 → 配置走环境变量（见 mcp/README.md）。
 *
 * 协议要点（写给自己和后来人）：
 *   · stdout **只能**有 JSON-RPC，一个对象一行；任何 console.log 都要改道 stderr，
 *     否则客户端会看到"非法 JSON"并整体崩掉 —— 所以下面第一件事就是劫持 console；
 *   · stdin 关闭 = 客户端退出 → 先尽力优雅下线，再退出进程；
 *   · 工具调用**串行**（同一个 bot，并发动作会互相打架），通知类消息不排队。
 *
 * 用法：
 *   node mcp/server.mjs            # 正常跑（MCP stdio）
 *   node mcp/server.mjs --selftest # 只装载插件、打印工具表，用于 CI/排错
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import readline from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGIN_ENTRY = join(ROOT, 'index.js')

/* ───────────────────────── ① 环境与日志 ───────────────────────── */

const env = process.env
const STATE_DIR = String(env.WHALE_CRAFT_STATE_DIR ?? '').trim() || join(homedir(), '.workbuddy', 'whale_craft')
const AGENT_ID = String(env.WB_AGENT_ID ?? '').trim() || 'workbuddy'
const CWD = String(env.WB_CWD ?? '').trim() || process.cwd()
const BOT_NAME = String(env.WB_BOT_NAME ?? '').trim()
const FULL_DESC = String(env.WB_TOOL_DESC ?? '').toLowerCase() === 'full'
const DEBUG = env.WB_DEBUG === '1' || env.WB_DEBUG === 'true'

// ⚠️ 必须在 import 插件之前设好：core.mjs 的 DEFAULTS 是模块级常量
env.WHALE_CRAFT_STATE_DIR = STATE_DIR
if (!env.MC_LOG) env.MC_LOG = join(STATE_DIR, 'logs', 'whale-craft.log')

const say = (...a) => process.stderr.write(`[whale-craft-mcp] ${a.join(' ')}\n`)
const debug = (m) => { if (DEBUG) say(m) }

// 🔴 stdout 是协议通道：所有 console.* 一律改道 stderr（插件/依赖偶尔会打日志）
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[k] = (...a) => process.stderr.write(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n')
}

/* ───────────────────────── ② 工具面 ───────────────────────── */

/**
 * 暴露给 WorkBuddy 的工具。
 * 只收"纯游戏内 + 不依赖 DSH 宿主服务"的那些；顺序 = tools/list 里的顺序（连接放最前，
 * 让模型第一眼看到入口）。
 */
const ALLOW = [
  'mc_connect', 'mc_status', 'mc_context', 'mc_players', 'mc_inventory', 'mc_events',
  'mc_scan', 'mc_map', 'mc_height', 'mc_entities',
  'mc_move', 'mc_act', 'mc_dig', 'mc_build', 'mc_give', 'mc_sequence',
  'mc_say', 'mc_command', 'mc_disconnect',
  'mc_ping', 'mc_lan', 'mc_accounts', 'mc_capabilities', 'mc_kit_rules',
  'mc_kit_image',      // 只有装得上 sharp 才暴露（见 buildToolList）
]

/** 刻意不暴露的工具 + 原因（排错时一眼能对上） */
const HIDDEN = {
  mc_watch: '看门狗控制：MCP 没有被动唤醒通道',
  mc_config: '看门狗参数：同上',
  mc_stop: '需要宿主 sessionController 停 LLM',
  mc_kit_express: '需要宿主 webServer 发布分享地址',
  mc_kit_fs: '文件操作由 WorkBuddy 自己的工具承担',
  mc_admin_config: 'DSH 全局配置管理，MCP 无对应物',
  mc_debug_sessions: '多会话诊断，MCP 单实例',
  mc_debug_diag: '诊断信息里有一半是宿主提示词注入状态',
}

/** 描述压缩：tools/list 每轮都进上下文，长描述很贵（默认压到 ~600 字，WB_TOOL_DESC=full 可关） */
const DESC_MAX = 600

function shortDesc (text) {
  const s = String(text ?? '').trim()
  if (FULL_DESC || s.length <= DESC_MAX) return s
  let out = ''
  for (const line of s.split('\n')) {
    if (out.length + line.length + 1 > DESC_MAX) break
    out += (out ? '\n' : '') + line
  }
  if (!out) out = s.slice(0, DESC_MAX)
  return out + '…'
}

/** 参数表 → MCP 认的 JSON Schema（插件的 parameters 已经是 schema，只补默认值） */
function schemaOf (tool) {
  const p = tool?.parameters
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  const out = { ...p }
  if (!out.type) out.type = 'object'
  if (!out.properties) out.properties = {}
  if (!Object.hasOwn(out, 'additionalProperties')) out.additionalProperties = false
  return out
}

/** 工具返回值 → MCP text（小结果美化，大结果紧凑：省 token） */
function render (value) {
  if (value === undefined) return 'null'
  if (typeof value === 'string') return value
  let compact
  try { compact = JSON.stringify(value) } catch { return String(value) }
  if (compact === undefined) return String(value)
  if (compact.length <= 900) {
    try { return JSON.stringify(value, null, 2) } catch { return compact }
  }
  return compact
}

/* ───────────────────────── ③ 启动 ───────────────────────── */

const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' }
})()

const { loadPluginTools } = await import(pathToFileURL(join(HERE, 'host-shim.mjs')).href)

/** 预置一个指定名字的离线账户（WB_BOT_NAME；只在账户库里没有同名离线账户时新建） */
async function seedBotName (name) {
  if (!name) return
  if (!/^[\w\u4e00-\u9fa5.]{1,32}$/.test(name)) {
    say(`WB_BOT_NAME="${name}" 不合法（中英文/数字/下划线/点，≤32 字），忽略`)
    return
  }
  try {
    const { AccountStore } = await import(pathToFileURL(join(ROOT, 'src', 'accounts.mjs')).href)
    const store = new AccountStore({ dir: STATE_DIR })
    store.ensureDefaults()
    const hit = store.list().find((a) => a.type === 'offline' && a.name === name)
    if (hit) { store.update(hit.innerID, { default: true }); return }
    const created = store.add({ type: 'offline', name })
    store.update(created.innerID, { default: true })
    say(`已新建离线账户 ${name}（${created.uuid ?? 'uuid 按名字派生'}）并设为默认`)
  } catch (e) {
    say(`预置账户失败（继续用默认账户）：${e?.message ?? e}`)
  }
}

await seedBotName(BOT_NAME)

/** 图像能力：sharp 装得上才暴露 mc_kit_image（否则一调就报"引擎不可用"，不如不暴露） */
let imageReady = false
try {
  const img = await import(pathToFileURL(join(ROOT, 'src', 'image.mjs')).href)
  imageReady = img.imageEngineAvailable()
  if (!imageReady) debug(`图像引擎不可用：${img.imageEngineError()}`)
} catch (e) { debug(`图像模块载入失败：${e?.message ?? e}`) }

const harness = await loadPluginTools({
  pluginEntry: PLUGIN_ENTRY,
  config: {},
  debug: (m) => debug(m.replace(/^\[whale_craft [^\]]+\]\s*/, '')),
})

/** @type {Map<string, object>} 暴露出去的工具（保持 ALLOW 顺序） */
const exposed = new Map()
for (const name of ALLOW) {
  const tool = harness.tools.get(name)
  if (!tool) { debug(`插件的工具表里没有 ${name}（版本变化？）`); continue }
  if (name === 'mc_kit_image' && !imageReady) continue
  exposed.set(name, tool)
}

const toolList = [...exposed.entries()].map(([name, t]) => ({
  name,
  description: shortDesc(t.description),
  inputSchema: schemaOf(t),
}))

if (process.argv.includes('--selftest')) {
  say(`plugin=${PLUGIN_VERSION} state=${STATE_DIR}`)
  say(`tools=${exposed.size}（插件共 ${harness.tools.size} 个，隐藏 ${Object.keys(HIDDEN).length} 个）`)
  for (const [name, t] of exposed) say(`  ${name.padEnd(20)} desc=${String(t.description ?? '').length}`)
  harness.dispose()
  process.exit(0)
}

say(`插件 ${PLUGIN_VERSION} 已载入｜暴露 ${exposed.size} 个工具｜状态目录 ${STATE_DIR}`)

/* ───────────────────────── ④ JSON-RPC ───────────────────────── */

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n') }
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

/** 每次工具调用的 exec：插件要 agent.id（会话实例）+ signal（可中断） */
let abortCtl = new AbortController()
const execFor = () => ({
  agent: { id: AGENT_ID, session: { header: { cwd: CWD } } },
  signal: abortCtl.signal,
})

/** 工具串行队列：一个 bot，动作不能并发 */
let queue = Promise.resolve()

async function callTool (name, args) {
  const tool = exposed.get(name)
  if (!tool) throw new Error(`没有这个工具：${name}（可用：${[...exposed.keys()].join('/')}）`)
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new Error('arguments 必须是一个对象')
  }
  const out = await tool.execute(args ?? {}, execFor())
  return render(out)
}

const INSTRUCTIONS = [
  '这个服务器提供一个 Minecraft Java 版机器人（mineflayer），它能自己进服、走路、挖方、搭方、说话。',
  '开始玩之前先 mc_connect（地址形如 host 或 host:port，版本自动探测），连上后会等区块加载完再返回。',
  '进服后先用 mc_status / mc_context 看自己在哪、什么模式；用 mc_scan / mc_map / mc_height 看周围。',
  '动手优先用 mc_act / mc_move / mc_dig / mc_build，而不是 mc_command（服务器指令是最后手段，走白名单）。',
  'mc_scan / mc_map 返回值很大，半径先给 8~16，需要更大范围就分几次看。',
  '这里没有"看门狗"：玩家说话不会自动叫醒你，需要你主动用 mc_events 读事件。',
].join('\n')

const HANDLERS = {
  initialize (params) {
    const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
    const known = ['2024-11-05', '2025-03-26', '2025-06-18']
    return {
      protocolVersion: known.includes(asked) ? asked : '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'whale_craft', version: PLUGIN_VERSION },
      instructions: INSTRUCTIONS,
    }
  },
  ping: () => ({}),
  'tools/list': () => ({ tools: toolList }),
  async 'tools/call' (params) {
    const name = String(params?.name ?? '')
    try {
      const text = await callTool(name, params?.arguments)
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      const msg = String(e?.message ?? e)
      const extra = [e?.hint, e?.needUserAction ? '（需要用户处理）' : ''].filter(Boolean).join('｜')
      debug(`工具 ${name} 失败：${msg}`)
      return { content: [{ type: 'text', text: extra ? `${msg}｜${extra}` : msg }], isError: true }
    }
  },
  'resources/list': () => ({ resources: [] }),
  'resources/templates/list': () => ({ resourceTemplates: [] }),
  'prompts/list': () => ({ prompts: [] }),
  'logging/setLevel': () => ({}),
  'completion/complete': () => ({ completion: { values: [] } }),
}

async function handle (msg) {
  if (!msg || typeof msg !== 'object') return fail(null, -32600, 'Invalid Request')
  const { id, method, params } = msg
  // 通知（没有 id）：只认 initialized / cancelled，一律不回包
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') debug('客户端已就绪')
    return
  }
  const fn = HANDLERS[method]
  if (!fn) return fail(id, -32601, `Method not found: ${method}`)
  try {
    const result = await fn(params)
    return ok(id, result)
  } catch (e) {
    return fail(id, -32603, String(e?.message ?? e))
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let closing = false

rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let msg
  try { msg = JSON.parse(text) } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  const batch = Array.isArray(msg) ? msg : [msg]
  const isCall = batch.some((m) => m?.method === 'tools/call')
  // 工具调用排队；其余（initialize/list）立即处理
  if (isCall) queue = queue.then(() => Promise.all(batch.map(handle))).catch((e) => say(`队列异常：${e?.message ?? e}`))
  else for (const m of batch) void handle(m)
})

/** 客户端断开 / 进程被杀：尽力优雅下线，别把角色留在服务器里 */
async function shutdown (why) {
  if (closing) return
  closing = true
  say(`正在退出（${why}）`)
  try { abortCtl.abort() } catch {}
  const tool = exposed.get('mc_disconnect')
  if (tool) {
    const timer = new Promise((r) => setTimeout(r, 2500))
    await Promise.race([
      tool.execute({ reason: `MCP 退出（${why}）` }, execFor()).catch(() => {}),
      timer,
    ])
  }
  try { harness.dispose() } catch {}
  process.exit(0)
}

rl.on('close', () => void shutdown('stdin 关闭'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (e) => say(`未处理的拒绝（已忽略，不退出）：${e?.message ?? e}`))
process.on('uncaughtException', (e) => say(`未捕获异常（已忽略，不退出）：${e?.message ?? e}`))
