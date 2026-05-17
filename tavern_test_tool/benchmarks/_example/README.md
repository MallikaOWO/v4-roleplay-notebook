# _example benchmark

通用对照测试模板。**复制本目录、改名、改内容**就是一个新的 benchmark。

## 怎么用

1. `cp -r benchmarks/_example benchmarks/my-bench`
2. 编辑 `my-bench/conditions.json`：
   - `meta.name` / `description` 改成你的实验目标
   - `conditions.*` 改成你真实的对照变量。`idOrName` 用你预设里 prompt 的实际名字，`anchor` 用真实的子串
   - `profiles.*` 把 `profileName` 改成酒馆里实际的 connection profile 名（顶栏 API 切换的下拉项）
3. 在主 `../../README.md` 的 cheatsheet 里把 `cj` 换成你的 JSON 内容
4. Claude 跑 `__SNIPPET_run_matrix(cj, {models, conditions, runs})`

## conditions.json 字段速查

| 字段 | 必填 | 说明 |
|------|------|------|
| `meta.base_user_message_id` | ✓ | 每次重生成都从哪一楼开始（一般 1） |
| `meta.base_user_message_default` |  | 没指定 userMessage 的 condition 回退用 |
| `conditions.<key>.label` | ✓ | UI 显示名 |
| `conditions.<key>.presetMods[]` | ✓ | 预设修改数组，按序应用 |
| `conditions.<key>.userMessage` |  | 改写 #base_user_message_id 楼的用户消息 |
| `profiles.<key>.profileName` | ✓ | 酒馆 connection profile 实际名称 |
| `profiles.<key>.model_label` | ✓ | 落盘目录/报告用的代号 |

## presetMods 的 op 一览

| op | 用途 | 必填字段 |
|----|------|---------|
| `setEnabled` | 开关某条 prompt | `idOrName`, `enabled` |
| `replace` | 整段替换 content | `idOrName`, `content` |
| `append` | 在 content 末尾追加 | `idOrName`, `content` |
| `prepend` | 在 content 开头插入 | `idOrName`, `content` |
| `insertAfter` | 在 anchor 子串之后插入（不换行） | `idOrName`, `anchor`, `content` |
| `insertBefore` | 在 anchor 子串之前插入 | `idOrName`, `anchor`, `content` |
| `removeSubstr` | 删除 content 中的某段子串 | `idOrName`, `content` |

> `idOrName` 支持 UUID（精确）、name（精确）、name 包含匹配（emoji 名也行）。
> 找不到目标或 anchor 时直接抛错——这是有意的（防止你以为改成功了但实际 noop）。

## 设计原则

每个 condition 描述的是"相对于基线，需要做哪些临时修改"。
`runCell` 会自动 `snapshotPreset(restoreFrom)` → 应用 mods → 跑 → **自动 restore 回基线**，
所以你**不需要**为每条 condition 写"还原步骤"。多条 condition 之间是真·独立的。
