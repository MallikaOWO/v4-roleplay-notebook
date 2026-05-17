// =============================================================================
//  tavern_test_tool / runner / snippets.js
//
//  这些不是要 require/import 的模块——是给 Claude 通过 chrome MCP 的
//  javascript_tool 复制粘贴到酒馆页面控制台里跑的片段。
//
//  每个片段都自带 IIFE，结果通过 console.log（或返回 Promise 的 then）
//  落到控制台输出，Claude 用 read_console_messages 拿到。
//
//  约定：跑之前必须先粘贴 ../script/index.js（或在 ST 里安装该脚本），
//        让 window.__TT 可用。
// =============================================================================

// ----------------------------------------------------------------------------
// 0. SANITY CHECK：__TT 已就绪？读出当前 profile + prompt 数 + 最后一楼
// ----------------------------------------------------------------------------
window.__SNIPPET_sanity = async () => {
  if (!window.__TT) return { ok: false, reason: 'window.__TT 未定义（脚本没加载）' };
  const presetSummary = __TT.getPresetSummary();
  const profile = await __TT.getCurrentConnectionProfile();
  const profiles = await __TT.listConnectionProfiles();
  const lastId = window.parent.TavernHelper.getLastMessageId();
  return {
    ok: true,
    version: __TT.version,
    profile,
    profiles,
    prompt_count: presetSummary.prompts.length,
    last_message_id: lastId,
    settings: presetSummary.settings,
  };
};

// ----------------------------------------------------------------------------
// 1. 预设摘要：核对 prompt 名称/UUID（用来填 conditions.json 的 idOrName）
// ----------------------------------------------------------------------------
window.__SNIPPET_preset_summary = () => {
  const s = __TT.getPresetSummary();
  // 只列名字 + 长度 + 是否启用，避免控制台被淹
  return s.prompts.map((p) => ({
    name: p.name,
    enabled: p.enabled,
    role: p.role,
    length: p.content_length,
    id: p.id,
  }));
};

// ----------------------------------------------------------------------------
// 2. 基线快照 + 改写 #1 到固定开场后的"等待用户填扩写要求"状态
// ----------------------------------------------------------------------------
window.__SNIPPET_baseline = async ({ userMessageId = 1, baseUserMessage = '（根据场景，扩写故事）', keepUntilId = 1 } = {}) => {
  __TT.snapshotPreset('base');
  await __TT.setUserMessage({ messageId: userMessageId, content: baseUserMessage });
  await __TT.truncateAfter(keepUntilId);
  return { ok: true, prompt_count: __TT.snapshots.get('base').prompts.length };
};

// ----------------------------------------------------------------------------
// 3. 跑单个单元格
// ----------------------------------------------------------------------------
//   用法（在控制台中执行）：
//     await window.__SNIPPET_run_cell({
//       label: 'M-V4-C3-01',
//       profileName: 'deepseek',
//       userMessage: '（根据场景，扩写故事）',
//       presetMods: [{ idOrName: '伪对话测试', op: 'insertAfter', anchor: '...', content: '...' }],
//     });
//   返回 {label, ok, body, thinking, meta, elapsed_ms, ...}
window.__SNIPPET_run_cell = (spec) => __TT.runCell(spec);

// ----------------------------------------------------------------------------
// 4. 跑一整组（按 conditions.json 中的 conditions + profiles 展开）
//
//   用法：
//     await window.__SNIPPET_run_matrix(conditionsJson, {
//       models: ['M-V4'],        // 选模型
//       conditions: ['C1','C3'], // 选条件
//       runs: 3,                 // 每格几次
//       delayBetweenMs: 2000,
//     });
//
//   注意 models 顺序：脚本会在切换 profile 时弹 toast 提示。如果某个
//   profile 需要人工二次确认（例如 GLM 内部选模型），你应当 runs=1 + 串行跑。
// ----------------------------------------------------------------------------
window.__SNIPPET_run_matrix = async (conditionsJson, opts = {}) => {
  const { models, conditions, runs = 1, delayBetweenMs = 1500, stopOnError = false } = opts;
  const out = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const mKey of models) {
    const profileSpec = conditionsJson.profiles[mKey];
    if (!profileSpec) throw new Error(`未知 model key: ${mKey}`);
    for (const cKey of conditions) {
      const c = conditionsJson.conditions[cKey];
      if (!c) throw new Error(`未知 condition key: ${cKey}`);
      for (let i = 1; i <= runs; i++) {
        const label = `${mKey}-${cKey}-${String(i).padStart(2, '0')}`;
        try {
          const r = await __TT.runCell({
            label,
            profileName: profileSpec.profileName,
            userMessage: c.userMessage,
            presetMods: c.presetMods,
            userMessageId: conditionsJson.meta?.base_user_message_id ?? 1,
            keepUntilId: conditionsJson.meta?.base_user_message_id ?? 1,
            restoreFrom: 'base',
          });
          out.push(r);
        } catch (e) {
          out.push({ label, ok: false, error: e.message });
          if (stopOnError) throw e;
        }
        await sleep(delayBetweenMs);
      }
    }
  }
  return out;
};

// ----------------------------------------------------------------------------
// 5. 多轮 RP：连续发送 user 消息，每轮采样
// ----------------------------------------------------------------------------
//   用法：
//     await window.__SNIPPET_long_rp({
//       label: 'RP-001',
//       turns: [
//         '（她把外套拉紧，低声开口）……XX，你也常来这边？',
//         '（捧着热可可，眼神躲开他）我……',
//       ],
//       timeoutMs: 300_000,
//     });
window.__SNIPPET_long_rp = async ({ label = 'rp', turns = [], timeoutMs = 5 * 60 * 1000 } = {}) => {
  const history = [];
  for (let i = 0; i < turns.length; i++) {
    const ut = turns[i];
    const r = await __TT.nextTurn({ userText: ut, timeoutMs });
    history.push({ turn: i + 1, user: ut, ...r });
  }
  __TT.results[label] = { label, kind: 'long_rp', turns: history };
  return __TT.results[label];
};

// ----------------------------------------------------------------------------
// 6. 拉结果：把 window.__TT.results 整批 dump 出来供 Claude 落盘
// ----------------------------------------------------------------------------
window.__SNIPPET_dump_results = ({ labels = null, clear = false } = {}) => {
  const all = __TT.results;
  const picked = labels ? Object.fromEntries(labels.map((l) => [l, all[l]]).filter(([, v]) => v)) : all;
  if (clear) __TT.results = {};
  return picked;
};

console.log(
  '[__SNIPPET] runner snippets ready. Available:',
  Object.keys(window).filter((k) => k.startsWith('__SNIPPET_')),
);
