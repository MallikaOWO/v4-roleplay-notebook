# tavern_test_tool
用来在酒馆里批量测试提示词效果，好处是在酒馆界面内操作方便人类直观的调试，坏处是效率比较低（但我max用不完了）

把 SillyTavern 里的对照测试（改预设 → 切模型 → 触发生成 → 采样 → 还原）从纯手动 DOM 操作升级成半自动脚本调用，给 Claude 一组 AI 友好的 RPC 接口。

**人类只负责**：
1. 在 SillyTavern 里**装一次**酒馆助手脚本（`script/index.js`）
2. 跑测时**观察前端**确认输出真实（不是后台静默生成）
3. 必要时**手动确认**某些 UI 状态（如某些 connection profile 内部还需选模型档位）

**Claude 负责**：
- 通过 chrome MCP 调 `window.__TT.*` 函数
- 改预设、改楼层、切模型、触发生成、采样
- 拿到 JSON 后写本地 `.md`

---

## 目录结构

```
tavern_test_tool/
├── README.md                       本文件
├── script/
│   └── index.js                    酒馆助手脚本（粘贴到 酒馆助手 → 脚本库）
├── runner/
│   └── snippets.js                 Claude 在 chrome 控制台执行的代码片段
└── benchmarks/
    └── _example/                   通用模板（复制改名即新建 benchmark）
        ├── README.md
        └── conditions.json
```

---

## 安装步骤（人类做一次）

1. 在 SillyTavern 中打开 **扩展 → 酒馆助手 → 脚本库**
2. 新建一个 **全局脚本**（type=`global`），名字随意，例如 `tavern_test_tool`
3. 把 `script/index.js` 的全部内容粘贴进去
4. 启用该脚本
5. 看到右下角 toast：「`[__TT] tavern_test_tool 已就绪（window.__TT）`」即成功

验证一下，在浏览器控制台敲：
```js
await window.__TT.getCurrentConnectionProfile()
```
应返回当前连接配置名（如 `'deepseek'`）。

> ⚠️ 修改 `script/index.js` 后需要在酒馆助手里**关闭脚本再启用**，新版才生效。
> 验证当前页面跑的是哪一版：`window.__TT.regenerate.toString().includes('/trigger')` 为 `true` 是新版。

---

## Claude 怎么调用

Claude 通过 `mcp__claude-in-chrome__javascript_tool` 执行。每个会话开始**先 sanity**：

```js
await window.__TT?.getCurrentConnectionProfile()     // 验证 __TT 存在 + profile
window.__TT.getPresetSummary().prompts
  .map(p => ({ name: p.name, enabled: p.enabled, id: p.id }))  // 列预设条目
```

如果 `window.__TT` 不存在，让人类去 酒馆助手 → 脚本库 重新启用脚本。

### Cheatsheet

#### 1. 准备基线
```js
__TT.snapshotPreset('base');                                       // 把当前预设状态做快照
await __TT.setUserMessage({ messageId: 1, content: '<你的指令>' }); // 改 #1
await __TT.truncateAfter(1);                                       // 删 #2 之后所有楼
```

#### 2. 跑单个单元格（短生成，单次 MCP 调用能完成）

适合 < 40s 的模型（Haiku、Flash、GLM 系列等）：

```js
const r = await __TT.runCell({
  label: 'M-A-C1-01',
  profileName: 'your-profile-name',     // 不传则不切换 profile
  userMessage: '<可选：覆盖 #1 楼内容>',
  presetMods: [
    { idOrName: '某条 prompt', op: 'setEnabled', enabled: true },
    { idOrName: '另一条 prompt', op: 'insertAfter',
      anchor: '<已知子串>', content: '<要插入的文字>' },
  ],
  restoreFrom: 'base',                  // 跑完从该 snapshot 还原预设
  timeoutMs: 300000,                    // 5 分钟超时
});
// r = { label, ok, body, thinking, meta, meta_obj, elapsed_ms, body_len, thinking_len, ... }
```

#### 3. 跑长生成（V4 / Pro 模型 / 长 reasoning，单次 MCP 调用会超时）

Chrome DevTools Protocol（`javascript_tool` 底层）单次调用 **45s 强制超时**。
任何单格 > 45s 的生成（如 DeepSeek V4 reasoning_effort=max 实测 90-110s）必须 fire-and-forget：

**第一次调用：启动**
```js
window.__TT_pending = (async () => {
  try {
    window.__TT_result = await __TT.runCell({
      label: 'M-A-C1-01',
      profileName: 'your-profile-name',
      presetMods: [...],
      restoreFrom: 'base',
      timeoutMs: 300000,
    });
  } catch (e) { window.__TT_result = { ok: false, error: String(e) }; }
})();
'started';   // 立刻返回，CDP 不会超时
```

**等一段时间后另一次调用：取结果**
```js
window.__TT_result        // null = 还没好；有值 = 完成
// 或：
window.__TT.results['M-A-C1-01']
```

> Claude 端 wait 模式建议：先 sleep 一段（看模型典型耗时），然后探测 `window.__TT_result`，没好就再 sleep。
> `__TT.runCell` 内部已正确串了"启动等待 + 生成等待 + 采样 + 还原"，不要在外面再轮询 `duringGenerating`。

#### 4. 跑一整组（按某个 benchmark 的 conditions.json）

```js
// 先把 conditions.json 内容塞进控制台
const cj = /* 粘贴 benchmarks/<你的>/conditions.json 的内容 */;

// 单次调用：适合 runs=1 + 短生成模型
await window.__SNIPPET_run_matrix(cj, {
  models: ['M-A'],
  conditions: ['C1_baseline', 'C3_inject_after_anchor'],
  runs: 1,
  delayBetweenMs: 2000,
});

// 长生成：fire-and-forget 包一层
window.__TT_matrix_pending = (async () => {
  try {
    window.__TT_matrix_result = await window.__SNIPPET_run_matrix(cj, {
      models: ['M-A', 'M-B'],
      conditions: ['C1_baseline', 'C2_toggle_one_prompt', 'C3_inject_after_anchor'],
      runs: 5,
    });
  } catch (e) { window.__TT_matrix_result = { ok: false, error: String(e) }; }
})();
```

#### 5. 多轮 RP（长程会话）
```js
await window.__SNIPPET_long_rp({
  label: 'RP-001',
  turns: [
    '<第一轮用户输入>',
    '<第二轮用户输入>',
  ],
  timeoutMs: 300000,
});
```

#### 6. 拉结果供 Claude 落盘
```js
window.__SNIPPET_dump_results({ clear: false })
// 返回 { 'M-A-C1-01': {label, body, thinking, meta_obj, ...}, ... }
// Claude 用 read_console_messages 拉出来，自己写到 tests/<model>/<cond>/run_NN.md
```

---

## `window.__TT` API 一览

| 类别 | 方法 | 说明 |
|------|------|------|
| 元信息 | `getPresetSummary()` | 当前预设的 prompts 列表（id/name/enabled/role/length） |
|        | `getChatSummary({ rangeFromTail=6 })` | 最近 N 楼摘要 |
|        | `getCurrentConnectionProfile()` | 当前连接配置名 |
|        | `listConnectionProfiles()` | 所有连接配置名（解析 `/profile-list` JSON 输出） |
| 预设   | `snapshotPreset(label='default')` | 把 `in_use` 预设快照到内存 |
|        | `restorePreset(label)` | 从快照还原 |
|        | `patchPrompt({ idOrName, op, ... })` | op ∈ `setEnabled` / `replace` / `append` / `prepend` / `insertAfter` / `insertBefore` / `removeSubstr` |
|        | `applyPresetMods(modsArray)` | 批量 `patchPrompt` |
| 聊天   | `setUserMessage({ messageId, content })` | 改写指定楼层 |
|        | `truncateAfter(keepUntilId)` | 删除 `keepUntilId` 之后的所有楼 |
| 模型   | `switchConnectionProfile(name)` | `/profile <name>` |
| 生成   | `regenerate()` | 删最后一条 assistant 楼 → `/trigger`（基于上一楼 user 接续） |
|        | `sendUserMessage(content)` | 新建 user 楼并触发 AI 回复（多轮 RP） |
|        | `waitForGenerationEnd({ timeoutMs, startupTimeoutMs=8000 })` | 两段式轮询：先等启动，再等结束 |
|        | `abortGeneration()` | `/abort` |
|        | `getLastAssistantMessage()` | 返回 `{ body, thinking, meta, meta_obj, body_len, thinking_len, swipe_id, swipe_count }`；reasoning 多路 fallback |
| 一键   | `runCell(spec)` | 切模型 → truncate → 改 #1 → 应用 presetMods → `/trigger` → 等结束 → 采样 → 还原 |
|        | `nextTurn({ userText, timeoutMs })` | 多轮 RP 的一轮 |
| 数据   | `results` | `{ [label]: cellSummary }` |
|        | `snapshots` | `Map<label, presetSnapshot>` |

### `meta_obj` 字段（采样元数据）

```js
{
  api: 'deepseek',                  // ST 当前 connection 的 api
  model: 'deepseek-v4-pro',         // 实际生效的模型名
  token_count: <number>,            // 完整回复 token 数（含 reasoning）
  time_to_first_token: <ms>,        // 首 token 延迟
  reasoning_duration: <ms>,         // 思维链耗时
}
```

---

## 新建自己的 benchmark

```sh
cp -r benchmarks/_example benchmarks/my-bench
```

然后编辑 `benchmarks/my-bench/conditions.json`：
- `meta.name` / `description` 写实验目标
- `conditions.*` 写真实的对照变量（`idOrName` 用你预设里 prompt 的实际名字，`anchor` 用真实子串）
- `profiles.*` 把 `profileName` 改成酒馆里实际的 connection profile 名

详细字段说明见 `benchmarks/_example/README.md`。

---

## 设计权衡

**为什么不用静默 `generate()`？**
- 静默调用没法人类观察、流式输出看不到，调试反而费劲
- `/trigger` 走前端正常流程，所有现有的过滤器/正则/世界书都生效，跟人类操作完全等价

**为什么把条件定义放 JSON 而不是写死在脚本里？**
- 改 benchmark = 改 JSON，不动脚本，不需要重启脚本
- Claude 可以读 JSON 后自适应展开，不需要改脚本

**为什么 `patchPrompt({ op, anchor, content })` 而不是给一个 `replacePromptContent(newContent)`？**
- 现实的需求经常是"在某句之后插入一句"，不是"整段重写"
- `insertAfter` 比 "你自己拿到 content 再字符串拼接再 replace" 更不容易写错
- 还原靠 snapshot，不依赖 patch 的可逆性

**为什么用 chrome MCP `javascript_tool` 作为运行入口，而不是起 HTTP 后端？**
- 不需要再加一层进程
- 控制台输出天然就是 Claude 的"观察接口"，`read_console_messages` 配合 pattern 过滤够用
- 失败时人类直接在同一个控制台调试，零切换成本

---

## 已知限制 / 行为

| 项 | 说明 |
|---|---|
| CDP 单次调用 45s 超时 | 单格生成 > 45s 必须 fire-and-forget（见 §3） |
| `TavernHelper.eventOn` 等事件 API | 在 `window.parent.TavernHelper` **不存在**（只在脚本 iframe 内暴露） |
| 事件路径不可用 | `waitForGenerationEnd` 纯轮询 `builtin.duringGenerating()`，比事件慢 ~500ms（够用） |
| `appendInexistentScriptButtons` | 在 page-level 不存在，按钮注册会失败（被 try/catch 吞，不影响调用链） |
| `TH.getChatMessages` 字段位置 | `include_swipes:false` 时 reasoning 在 `extra.extra.reasoning`（**二级嵌套**）；`include_swipes:true` 时正文在 `swipes[swipe_id]`，reasoning 在 `swipes_info[swipe_id].extra.reasoning`。`getLastAssistantMessage` 内部已多路 fallback |
| `/regenerate` slash 命令 | 在某些 ST 版本不存在，已改用 `/trigger`（删最后一条 assistant → `/trigger` 让 AI 接续） |

---

## 后续可拓展点

- 给 `runCell` 加 `injects` 参数支持 `injectPrompts`（提示词注入，免改预设）
- 把"读 conditions.json"做成酒馆助手脚本的 `data` 字段，省去粘贴 JSON 这一步
- 写一个浮层进度表（按钮触发对应单元格、显示已跑/未跑/失败）
- `runCell` 增加 `expectations`（如 `body_len > 500`），失败自动重 roll N 次
