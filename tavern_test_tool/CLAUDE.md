### tavern_test_tool — Claude 操作指引

> 这里只补充实测踩过的坑和"基础文档没写"的细节，**避免和已有文档重复**：
>
> - 用户/Claude 任务全景、API 表、`__TT.*` cheatsheet → 见 [`README.md`](./README.md)
> - benchmark 字段定义 / `op` 一览 → 见 [`benchmarks/_example/README.md`](./benchmarks/_example/README.md)

---

#### 标准跑测流程（Claude 视角）

1. **Sanity** — 验证 `__TT` 存在 + 当前 profile/预设/角色与 `conditions.json._fixed_context` 对得上。
2. **Baseline** — `__TT.snapshotPreset('jb-base')` + `setUserMessage(#1)` + `truncateAfter(1)`。整个 benchmark 共用同一个 snapshot 名，每条 condition 的 `runCell` 都用 `restoreFrom: 'jb-base'`。
3. **跑 condition** — 长生成（V4/Pro/reasoning_effort=max，单格 60–235s）一律 fire-and-forget：
   ```js
   window.__JB_<cond>_pending = (async () => {
     try { window.__JB_<cond>_done = await __SNIPPET_run_matrix(cj, { models:['M-V4'], conditions:['Cx_xxx'], runs:10 }); }
     catch (e) { window.__JB_<cond>_done = { ok:false, error:String(e) }; }
   })();
   ```
   然后通过短探测拉 `window.__JB_<cond>_done`，没好就走 sleep notification 等下一轮。
4. **落盘** — 探测完成后用 `__JB_to_md(result, condKey, condLabel, presetName, charName)` 把每个 run 转 markdown 塞进 `window.__JB_md_buffer[<key>]`，**分段读出**再 `Write`。
5. **还原** — 所有 condition 跑完后 `await __TT.restorePreset('jb-base')`。

---

#### 实战踩坑清单

##### A. MCP `javascript_tool` 单字段显示 ~900 字符截断
- 长 .md（>1000 字）必须**分桶**：把 buffer 字符串切成 ~800 字一段，一次返回 `{a:..., b:..., c:..., d:..., e:..., f:..., g:...}` 7 个字段（甚至 a–i），Claude 端拼回去再 `Write`。
- 不要尝试 `return buffer` 整条返回 —— 会被截。
- 不要用 base64 编码绕（编完更长）。

##### B. `window.__JB_md_buffer` 是普通 Object，不是 Map
- 用 `Object.keys(buf)` / `buf[key] = ...`，**不要**用 `.keys()` / `.set()` —— 会报 `keys is not a function`。

##### C. `elapsed_ms` 在 `result` 根，不在 `meta_obj` 里
- `meta_obj = { api, model, token_count, time_to_first_token, reasoning_duration }`
- `elapsed_ms` 是 `runCell` 自己测的墙钟时间，挂在结果顶层。`__JB_to_md` 已正确处理；如果手写转换器，别把这个字段漏在 frontmatter 里写成 0。

##### D. `preset` 字段需要从外部传入
- `conditions.json` 里通常**不会**显式声明 `preset` 名（预设是 ST 当前 in_use 的，不是 JSON 控制的）。
- `__JB_to_md(...)` 的 `presetName` 参数必须 Claude 端手动从 `_fixed_context.loaded_preset_expected` 读出来传进去，**不要假设 `cs.preset` 字段存在**——它会是 `undefined`，写出来 frontmatter 的 `preset:` 就是空。

##### E. CDP 45s 强制超时
- 已在 README §3 详述。补充：用 fire-and-forget 时**`__TT.runCell` 内部已经串好启动→生成→采样→还原**，不要在外面再 `waitForGenerationEnd` / `duringGenerating` 轮询，会冲突。

##### F. 模型偶尔在 body 里输出 `<think>` 块
- V4 reasoning 走的是 `extra.reasoning`，但模型有时会**在 body 正文里**再生成一段 `<think>...</think>`（见 `jailbreak_test1/C3_jb3/run_08.md` body 开头）。
- 处理原则：**原样保留**，不要剥离 —— 这是模型实际输出的一部分，影响后续 condition 对比的字数和文风。

##### G. Stop hook + `/goal` 的工作节奏
- 设置 `/goal 跑完 NxM 次测试并写入结果` 后，goal 谓词没满足前**每次** assistant text 都会触发 stop hook。
- 应对：保持工具调用连贯（探测/写入/sleep），别在中间夹纯文字答复。长 benchmark（90+ 分钟）期间，sleep notification 会自动唤回继续轮询，不需要自己 polling。

##### H. profile 切换可能需要人工二次确认
- 某些 connection profile（如 GLM 系列）切完还需要在 UI 里再选模型档位。
- 应对：`runs=1` + 串行跑 + 切完后 sanity check 一次实际生效模型名。`jailbreak_test1` 全程只用 `deepseek` profile，没踩到这个坑。

---

#### 新 benchmark 流程（30 秒版）

```
cp -r benchmarks/_example benchmarks/<新名>
# 编辑 conditions.json：name / conditions / profiles / _fixed_context
# Claude 端：把 JSON 内容粘进控制台 const cj = {...}
# 跑 sanity → baseline → 各 condition fire-and-forget → dump → write → restore
```

如果是 **N≥5 的长生成 benchmark**，建议在 Claude 端先把 `__JB_to_md` 这种 helper 提前注入 `window`，dump 阶段直接调，**不要每次都重发完整代码字符串**（控制台输入也有长度限制，>10KB 容易截）。
