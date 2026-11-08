// -*- coding: utf-8 -*-
/**
 * WorkBuddy 转接头 / host-shim.mjs —— 用最小假宿主把 index.js 的 apply() 跑起来
 * ============================================================================
 * 为什么需要它：
 *   whale_craft 是 **DSH（cordis）插件**：入口导出 `apply(ctx, config)`，靠 `ctx.tools.register`
 *   把工具挂给宿主。WorkBuddy 只认 **MCP**，两边没有共同接口。
 *   但插件的游戏能力层（`src/core.mjs` 的 McBot）是纯 Node + mineflayer，**零 DSH 依赖**；
 *   `index.js` 里那 34 个工具也只是 `defineTool({...})` 的薄壳（`src/tool-def.mjs` 还有
 *   "拿不到宿主包就用内置实现"的兜底）。所以**不需要改插件**，只要喂一个假 ctx 让 apply()
 *   照常跑完，然后把注册表截下来即可。
 *
 * 假 ctx 的边界（刻意为之）：
 *   · `get(name)` 一律 undefined —— 宿主服务（credentials / agents / sessionController /
 *     workspaceRegistry / webRuntime）在 MCP 里不存在，插件自己的降级分支会接管；
 *   · `inject([...], cb)` **不回调** —— 否则会去碰凭据库与归档保护（都不该在这边发生）；
 *   · `effect(fn)` 立刻执行（拿它的 disposer），让插件认为生命周期已建立；
 *   · `webServer.register` 收下就丢 —— MC 设置页 / 分享路由在这里没有意义。
 *
 * 这个垫片**不改仓库里任何一行插件代码**；插件升级后重跑就能拿到新工具，不必跟着改。
 * ============================================================================
 */
import { pathToFileURL } from 'node:url'

/** 关掉宿主服务的空实现（保持形状，避免插件在某处 undefined.xxx 崩） */
const noop = () => {}

/**
 * 载入插件并捕获工具表。
 *
 * @param {object} o
 * @param {string} o.pluginEntry  插件入口（index.js 的绝对路径）
 * @param {object} [o.config]     传给 apply 的 config（默认只给 mentions）
 * @param {(msg:string)=>void} [o.debug] 调试输出（走 stderr；默认丢弃）
 * @returns {Promise<{tools: Map<string, object>, dispose: () => void}>}
 */
export async function loadPluginTools ({ pluginEntry, config = {}, debug = noop }) {
  /** @type {Map<string, object>} */
  const tools = new Map()
  const disposers = []

  const ctx = {
    // 宿主服务一律没有：插件会走它自己的降级分支（日志里能看到"宿主没有 xxx"）
    get: () => undefined,
    provide: noop,
    on: noop,
    off: noop,
    emit: noop,
    parallel: noop,
    // ⚠️ 不回调：credentials / workspaceRegistry 的 inject 一回调就会去碰 DSH 专属设施
    inject: noop,
    effect: (fn) => {
      try {
        const d = typeof fn === 'function' ? fn() : null
        if (typeof d === 'function') disposers.push(d)
      } catch (e) { debug(`effect 执行失败（忽略）：${e?.message ?? e}`) }
      return noop
    },
    logger: {
      info: (m) => debug(String(m ?? '')),
      warn: (m) => debug(String(m ?? '')),
      error: (m) => debug(String(m ?? '')),
      debug: noop,
      success: noop,
    },
    tools: {
      register: (tool) => {
        const name = String(tool?.name ?? '')
        if (!name) return noop
        if (tools.has(name)) debug(`工具重名，后者覆盖：${name}`)
        tools.set(name, tool)
        return noop
      },
      // 有的宿主版本用 ctx.tools.define/register 两种写法，留个安全的空口子
      define: noop,
      unregister: noop,
    },
    webServer: { register: () => noop, get: () => noop, post: () => noop },
    web: { register: noop },
    workspaceRegistry: undefined,
  }

  const mod = await import(pathToFileURL(pluginEntry).href)
  if (typeof mod.apply !== 'function') throw new Error(`插件入口没有导出 apply()：${pluginEntry}`)
  mod.apply(ctx, config)
  debug(`插件已载入，捕获工具 ${tools.size} 个`)

  return {
    tools,
    dispose: () => {
      for (const d of disposers.reverse()) { try { d() } catch {} }
    },
  }
}
