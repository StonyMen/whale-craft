# WorkBuddy 转接头（MCP）

把 **whale_craft** 从「DSH 插件」变成「MCP 服务器」，让 WorkBuddy（或任何 MCP 客户端）也能开一台
Minecraft 机器人：进服、走路、挖方、搭方、说话、看地形。

**不需要安装 DSH**，也不需要 `@deepseek-ai/*` 那些包 —— 它们是插件的 optional peer，
插件内部有内置兜底（见 `src/tool-def.mjs`）。

---

## 它怎么工作的

```
WorkBuddy ──MCP(stdio, JSON-RPC)──> mcp/server.mjs
                                      ├─ mcp/host-shim.mjs：喂一个假宿主 ctx，跑插件的 apply()
                                      └─ src/core.mjs：McBot（纯 Node + mineflayer，零 DSH 依赖）
                                            └── Minecraft 服务器
```

- `mcp/host-shim.mjs`：插件的入口是 `apply(ctx, config)`，靠 `ctx.tools.register` 把工具挂给宿主。
  这里给一个**最小假 ctx**（`get()` 一律 undefined、`inject()` 不回调、`webServer` 收下就丢），
  `apply()` 照常跑完，注册表被截下来 → 34 个工具。
- `mcp/server.mjs`：实现 MCP 的 `initialize` / `tools/list` / `tools/call`，并**不改插件一行代码**。
  插件升级后重跑即可拿到新工具。

**为什么不能直接装**：DSH 是 cordis 插件（宿主进程内注册工具），WorkBuddy 只认 MCP（独立进程说协议）。
两边没有共同接口，所以必须有这一层。

---

## 启用

1. 装依赖（只要 `mineflayer` + `vec3`）：

   ```bash
   npm install --omit=optional
   ```

2. 在 `~/.workbuddy/mcp.json` 里登记（Windows 下 `command` 建议写 node 的**绝对路径**，
   避免 GUI 进程的 PATH 里没有 node）：

   ```json
   {
     "mcpServers": {
       "minecraft": {
         "command": "C:/Program Files/nodejs/node.exe",
         "args": ["E:/MinecraftData/whale-craft/mcp/server.mjs"],
         "env": {
           "WHALE_CRAFT_STATE_DIR": "C:/Users/Stone/.workbuddy/whale_craft",
           "WB_BOT_NAME": "DeepSeek"
         }
       }
     }
   }
   ```

3. 在 WorkBuddy 的「连接器 / MCP」页面**信任**这个服务器（新加的服务器默认不生效）。
4. 验证：`node tools/check-mcp.mjs`（纯协议自检，不连游戏），或 `node mcp/server.mjs --selftest`（只看工具表）。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WHALE_CRAFT_STATE_DIR` | `~/.workbuddy/whale_craft` | 账户库、配置、日志、实例锁都放这（与 DSH 的 `~/.dsh/whale_craft` **隔离**） |
| `WB_BOT_NAME` | 空（用默认账户 `DeepSeek`） | 指定机器人的游戏名；账户库里没有同名离线账户就新建并设为默认 |
| `WB_AGENT_ID` | `workbuddy` | 会话实例 id（锁文件 + 日志前缀） |
| `WB_CWD` | 进程 cwd | 给插件当会话工作区（记忆目录 `.whale-craft` 落在它下面） |
| `WB_TOOL_DESC` | `compact` | `full` = 不压缩工具描述（默认压到 ~600 字，省上下文） |
| `WB_DEBUG` | 关 | `1` = 把插件日志转到 stderr |
| `MC_LOG` | `<state>/logs/whale-craft.log` | 插件日志路径 |
| `WHALE_CRAFT_STATE_DIR` 指向 `~/.dsh/whale_craft` | — | 可复用 DSH 里已配好的账户；⚠️ 但 DSH 与 MCP **同时**连服会抢同一把实例锁 |

---

## 暴露的工具（24 个）

| 分类 | 工具 |
|---|---|
| 连接 | `mc_connect` `mc_disconnect` `mc_accounts` `mc_ping` `mc_lan` |
| 感知 | `mc_status` `mc_context` `mc_players` `mc_inventory` `mc_events` `mc_entities` `mc_scan`（方块）`mc_map`（地形图）`mc_height`（地势图） |
| 行动 | `mc_move` `mc_act` `mc_dig` `mc_build` `mc_give` `mc_sequence` `mc_say` `mc_command` |
| 信息 | `mc_capabilities` `mc_kit_rules` `mc_kit_image`（仅当能解析到 `sharp`） |

**刻意不暴露**（依赖 DSH 宿主设施，在这边没有对应物）：

| 工具 | 原因 |
|---|---|
| `mc_watch` `mc_config` | 看门狗：MCP 没有"主动唤醒模型"的通道 |
| `mc_stop` | 需要宿主 `sessionController` 去停 LLM |
| `mc_kit_express` `mc_kit_fs` | 依赖宿主 `webServer` 发布分享地址；文件操作 WorkBuddy 自己有 |
| `mc_admin_config` `mc_debug_sessions` `mc_debug_diag` | DSH 专属配置 / 多会话诊断 / 提示词注入状态 |

---

## 与 DSH 版的差别

| | DSH 版 | MCP 版 |
|---|---|---|
| 主动唤醒 | 看门狗盯着事件，被叫/受击/捡物/心跳就 `steer` 唤醒模型 | **没有**。只有被调用才动；想知道谁说话得主动 `mc_events` |
| 模式隔离 | MC / MC+ 两套 preset，工具面收窄、文件 jail | 没有。工具面固定为上面 24 个 |
| 提示词 | `RULES.md` + 版本硬提示自动注入 | 没有。靠 MCP `initialize.instructions` 里那几行，或项目规则文件补 |
| 设置界面 | 连接弹窗 / 账户 / 开关 / 状态条 / 强制停止 | 没有。改配置 = 改环境变量或 `accounts.json` |
| 多会话 | 每会话一个 bot | 单进程单 bot（不会互相抢） |
| 记忆 | `<工作区>/.whale-craft/` 约定 | 一样（`WB_CWD` 决定放哪），但工具由 WorkBuddy 提供 |

token 上通常**更省**：没有看门狗"自动开新轮"这个放大器，也不注入那两段提示词（约 2900 字）。
代价是"你得先开口"。

---

## 排错

| 现象 | 看这里 |
|---|---|
| 客户端里工具列表是空的 | `node mcp/server.mjs --selftest` 能不能打印 24 个工具；起不来会先在 stderr 报错 |
| 服务器启动失败 | WorkBuddy 的连接器页面通常有 stderr 摘要；也可手动 `node mcp/server.mjs` 看输出 |
| 进服被踢 | `<state>/logs/whale-craft.log` + 服务端日志。26.x + ViaBackwards 的 tick 问题已在 v0.2.0-beta.4 修（见 CHANGELOG） |
| 想换成别的名字 | 设 `WB_BOT_NAME`（离线服）；皮肤站账号目前只能在 DSH 侧维护，或直接改 `accounts.json` |
| 图像工具没出现 | 没装 `sharp`（optional）。`npm install sharp` 后重启 MCP 进程 |

---

## 给维护者：协议实现要点

- **stdout 只能有 JSON-RPC**（一行一个对象）。启动第一件事就是把 `console.*` 改道 stderr，
  否则插件的任何一句日志都会让客户端判成"非法 JSON"。
- 工具调用**串行排队**（同一个 bot，并发动作会打架）；`initialize` / `tools/list` 不排队。
- 每个工具调用的 `exec` 要有 `agent.id`（插件按它建会话实例）和 `signal`（可中断）。
- 返回值走插件的 `lossless()`（`asTool` 已包），这边只做 小结果美化 / 大结果紧凑。
- stdin 关闭 = 客户端退出：先 `mc_disconnect`（2.5s 上限），再释放插件、退出进程。
