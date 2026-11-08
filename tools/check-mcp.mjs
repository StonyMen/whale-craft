// -*- coding: utf-8 -*-
/**
 * tools/check-mcp.mjs —— 转接头协议自检（**不连游戏**，纯 MCP 往返）
 * ============================================================================
 * 覆盖：
 *   ① 进程能起来、stdout 只有 JSON-RPC（没有杂日志污染）；
 *   ② initialize 返回协议版本 / tools 能力 / serverInfo / instructions；
 *   ③ tools/list 的工具数、必填字段、inputSchema 形状；
 *   ④ tools/call 真跑两个不需要进服的工具（mc_capabilities / mc_status），返回 text content；
 *   ⑤ 未知工具 → isError（不是崩进程）；未知方法 → -32601；
 *   ⑥ 关掉 stdin → 进程正常退出（0）。
 * 用法：node tools/check-mcp.mjs
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER = join(ROOT, 'mcp', 'server.mjs')
const stateDir = mkdtempSync(join(tmpdir(), 'wc-mcp-'))

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✅ ${name}`) } else { fail++; console.log(`❌ ${name}${extra ? `｜${extra}` : ''}`) }
}

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, WHALE_CRAFT_STATE_DIR: stateDir, WB_BOT_NAME: 'MCP_Check', WB_DEBUG: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map()
let nextId = 1
let stderrText = ''
let badLine = null

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { badLine = line.slice(0, 120); continue }
    const waiter = pending.get(msg.id)
    if (waiter) { pending.delete(msg.id); waiter(msg) }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => { stderrText += d })

const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))

function request (method, params, timeoutMs = 20000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时：${method}`)) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

const textOf = (res) => res?.result?.content?.[0]?.text ?? ''
const jsonOf = (res) => { try { return JSON.parse(textOf(res)) } catch { return null } }

try {
  // ① initialize
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'check-mcp', version: '1' },
  })
  ok('initialize 有 result', Boolean(init?.result))
  ok('protocolVersion 合法', ['2024-11-05', '2025-03-26', '2025-06-18'].includes(init?.result?.protocolVersion))
  ok('声明 tools 能力', Boolean(init?.result?.capabilities?.tools))
  ok('serverInfo.name = whale_craft', init?.result?.serverInfo?.name === 'whale_craft')
  ok('带 instructions', String(init?.result?.instructions ?? '').includes('mc_connect'))
  notify('notifications/initialized')

  // ③ tools/list
  const list = await request('tools/list', {})
  const tools = list?.result?.tools ?? []
  ok('tools/list 非空', tools.length >= 20, `实际 ${tools.length}`)
  const names = tools.map((t) => t.name)
  ok('包含核心工具', ['mc_connect', 'mc_status', 'mc_move', 'mc_act', 'mc_scan', 'mc_say'].every((n) => names.includes(n)))
  ok('不暴露 DSH 专属工具', !names.some((n) => ['mc_watch', 'mc_config', 'mc_admin_config', 'mc_kit_express'].includes(n)))
  ok('每个工具都有三条必填字段', tools.every((t) => t.name && typeof t.description === 'string' && t.inputSchema && typeof t.inputSchema === 'object'))
  ok('inputSchema 都是 object', tools.every((t) => t.inputSchema.type === 'object'))
  ok('mc_connect 的 address 是必填', (() => {
    const t = tools.find((x) => x.name === 'mc_connect')
    return Array.isArray(t?.inputSchema?.required) && t.inputSchema.required.includes('address')
  })())
  ok('描述已压缩（≤620 字）', tools.every((t) => t.description.length <= 620))

  // ④ 真调两个工具
  const caps = await request('tools/call', { name: 'mc_capabilities', arguments: {} })
  const capsJson = jsonOf(caps)
  ok('mc_capabilities 能跑', Boolean(capsJson?.plugin?.name === 'whale_craft'), textOf(caps).slice(0, 120))
  ok('mc_capabilities 报出版本范围', Array.isArray(capsJson?.game?.testedVersions) && capsJson.game.testedVersions.length > 0)

  const st = await request('tools/call', { name: 'mc_status', arguments: {} })
  const stJson = jsonOf(st)
  ok('mc_status 能跑且离线', stJson?.online === false, textOf(st).slice(0, 120))

  // ⑤ 错误路径
  const badTool = await request('tools/call', { name: 'no_such_tool', arguments: {} })
  ok('未知工具返回 isError', badTool?.result?.isError === true)
  const badMethod = await request('no/such/method', {})
  ok('未知方法返回 -32601', badMethod?.error?.code === -32601)

  // ⑥ stdout 纯净
  ok('stdout 没有非 JSON 行', badLine === null, String(badLine))

  child.stdin.end()
  const { code } = await exited
  ok('关闭 stdin 后正常退出', code === 0, `exit=${code}`)
  ok('stderr 里有启动信息', stderrText.includes('已载入'), stderrText.slice(0, 120))
} catch (e) {
  fail++
  console.log(`❌ 自检异常：${e.message}`)
  child.kill()
} finally {
  try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
  console.log(`\n结果：${pass} ✅ / ${fail} ❌`)
  process.exit(fail ? 1 : 0)
}
