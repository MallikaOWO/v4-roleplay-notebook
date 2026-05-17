// =============================================================================
//  tavern_test_tool — SillyTavern 助手脚本（粘贴到 酒馆助手 → 脚本库）
//
//  在 window.__TT 暴露一组 AI 友好的 RPC 函数，供 Claude 用 chrome MCP
//  的 javascript_tool 直接调用，跑半自动化对照测试。
//
//  设计原则：
//   - 只用 TavernHelper API，不依赖具体 DOM 选择器
//   - 所有操作幂等、可观察（toastr 通知）
//   - 不静默生成：触发的是用户能看见的 /regenerate，不是后台 generate()
//   - 条件改动 = 数据描述（presetMods），不硬编码到脚本
// =============================================================================

(() => {
  const TH = window.parent?.TavernHelper ?? window.TavernHelper;
  const ST = window.parent?.SillyTavern?.getContext?.() ?? window.SillyTavern?.getContext?.();
  const $win = window.parent ?? window;
  const toast = (...args) => $win.toastr?.info?.(...args) ?? console.info(...args);
  const toastOk = (...args) => $win.toastr?.success?.(...args) ?? console.info(...args);
  const toastErr = (...args) => $win.toastr?.error?.(...args) ?? console.error(...args);

  if (!TH) {
    console.error('[__TT] 找不到 TavernHelper，请先安装并启用酒馆助手');
    return;
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 在 prompts 列表里按 UUID 或名称（精确/包含/emoji 前缀都行）定位一条 */
  function findPrompt(preset, idOrName) {
    if (!idOrName) return null;
    const exact = preset.prompts.find((p) => p.id === idOrName || p.name === idOrName);
    if (exact) return exact;
    return preset.prompts.find((p) => p.name?.includes(idOrName)) ?? null;
  }

  /** 等待条件成立，每 intervalMs 轮询一次，超时返回 {ok:false,reason:'timeout'} */
  async function waitFor(predicate, { timeoutMs = 5 * 60 * 1000, intervalMs = 500, label = '' } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await predicate()) return { ok: true, elapsed_ms: Date.now() - t0 };
      } catch (_) {}
      await sleep(intervalMs);
    }
    return { ok: false, reason: 'timeout', label, elapsed_ms: Date.now() - t0 };
  }

  // ---------------------------------------------------------------------------
  // 预设：读 / 改 / 备份 / 还原
  // ---------------------------------------------------------------------------

  const snapshots = new Map();

  function getPresetSummary() {
    const preset = TH.getPreset('in_use');
    return {
      loaded_from: TH.getLoadedPresetName(),
      settings: {
        temperature: preset.settings.temperature,
        top_p: preset.settings.top_p,
        max_completion_tokens: preset.settings.max_completion_tokens,
        should_stream: preset.settings.should_stream,
        reasoning_effort: preset.settings.reasoning_effort,
      },
      prompts: preset.prompts.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        role: p.role,
        position: p.position,
        content_preview: (p.content ?? '').slice(0, 80),
        content_length: (p.content ?? '').length,
      })),
    };
  }

  /** 把当前 in_use 预设的完整内容快照到内存，便于 restorePreset(label) 还原 */
  function snapshotPreset(label = 'default') {
    const preset = TH.getPreset('in_use');
    snapshots.set(label, JSON.parse(JSON.stringify(preset)));
    toast(`[__TT] 预设已快照：${label}（${preset.prompts.length} 条 prompt）`);
    return { label, prompt_count: preset.prompts.length };
  }

  async function restorePreset(label = 'default') {
    if (!snapshots.has(label)) {
      toastErr(`[__TT] 没有名为 ${label} 的快照`);
      throw new Error(`no snapshot: ${label}`);
    }
    await TH.replacePreset('in_use', snapshots.get(label), { render: 'immediate' });
    toastOk(`[__TT] 预设已还原：${label}`);
  }

  /**
   * 对一条 prompt 做局部修改。op 支持：
   *   - setEnabled  : 开关条目
   *   - replace     : 整段替换 content
   *   - append      : 在末尾追加 content
   *   - prepend     : 在开头插入 content
   *   - insertAfter : 在 anchor 子串之后（不换行）插入 content
   *   - insertBefore: 在 anchor 子串之前插入 content
   *   - removeSubstr: 删除 content（substr）
   */
  async function patchPrompt({ idOrName, op, enabled, anchor, content }) {
    const preset = TH.getPreset('in_use');
    const target = findPrompt(preset, idOrName);
    if (!target) throw new Error(`找不到 prompt: ${idOrName}`);

    switch (op) {
      case 'setEnabled':
        target.enabled = !!enabled;
        break;
      case 'replace':
        target.content = content ?? '';
        break;
      case 'append':
        target.content = (target.content ?? '') + (content ?? '');
        break;
      case 'prepend':
        target.content = (content ?? '') + (target.content ?? '');
        break;
      case 'insertAfter': {
        const c = target.content ?? '';
        const idx = c.indexOf(anchor);
        if (idx < 0) throw new Error(`anchor 未找到: ${anchor.slice(0, 60)}…`);
        target.content = c.slice(0, idx + anchor.length) + (content ?? '') + c.slice(idx + anchor.length);
        break;
      }
      case 'insertBefore': {
        const c = target.content ?? '';
        const idx = c.indexOf(anchor);
        if (idx < 0) throw new Error(`anchor 未找到: ${anchor.slice(0, 60)}…`);
        target.content = c.slice(0, idx) + (content ?? '') + c.slice(idx);
        break;
      }
      case 'removeSubstr': {
        const c = target.content ?? '';
        if (!c.includes(content)) throw new Error(`要删除的子串未找到: ${content.slice(0, 60)}…`);
        target.content = c.split(content).join('');
        break;
      }
      default:
        throw new Error(`未知 op: ${op}`);
    }

    await TH.replacePreset('in_use', preset, { render: 'immediate' });
    toast(`[__TT] prompt 已修改：${target.name} (${op})`);
    return {
      idOrName,
      name: target.name,
      enabled: target.enabled,
      content_length: target.content?.length ?? 0,
    };
  }

  /** 批量应用 presetMods（来自 conditions.json 的 presetMods 数组） */
  async function applyPresetMods(mods = []) {
    const results = [];
    for (const mod of mods) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await patchPrompt(mod));
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // 聊天楼层
  // ---------------------------------------------------------------------------

  function getChatSummary({ rangeFromTail = 6 } = {}) {
    const last = TH.getLastMessageId();
    const start = Math.max(0, last - rangeFromTail + 1);
    const msgs = TH.getChatMessages(`${start}-${last}`, { include_swipes: true });
    return msgs.map((m) => ({
      id: m.message_id,
      role: m.role,
      name: m.name,
      is_hidden: m.is_hidden,
      swipe_id: m.swipe_id,
      swipe_count: m.swipes?.length ?? 1,
      preview: (m.message ?? '').slice(0, 80),
      length: (m.message ?? '').length,
    }));
  }

  async function setUserMessage({ messageId, content }) {
    if (messageId === undefined || messageId === null) throw new Error('需要 messageId');
    await TH.setChatMessages([{ message_id: messageId, message: content }], { refresh: 'affected' });
    toast(`[__TT] 已改写 #${messageId}：${content.slice(0, 30)}…`);
  }

  /** 删除该楼及之后的所有楼（用来"回到固定开场重跑"） */
  async function truncateAfter(keepUntilId) {
    const last = TH.getLastMessageId();
    if (last <= keepUntilId) return { deleted: 0 };
    const toDel = [];
    for (let i = keepUntilId + 1; i <= last; i++) toDel.push(i);
    await TH.deleteChatMessages(toDel, { refresh: 'affected' });
    toast(`[__TT] 删除 ${toDel.length} 楼（保留 0..${keepUntilId}）`);
    return { deleted: toDel.length };
  }

  // ---------------------------------------------------------------------------
  // 模型切换（连接配置文件 / Connection Profile）
  // ---------------------------------------------------------------------------

  async function listConnectionProfiles() {
    // /profile-list 返回 JSON 字符串数组：'["p1","p2",...]'
    const raw = await TH.triggerSlash('/profile-list');
    if (!raw) return [];
    const trimmed = String(raw).trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch (_) {}
    // 兜底：按行切
    return trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async function getCurrentConnectionProfile() {
    const raw = await TH.triggerSlash('/profile');
    return (raw ?? '').trim();
  }

  async function switchConnectionProfile(name) {
    if (!name) throw new Error('需要 profile name');
    await TH.triggerSlash(`/profile ${name}`);
    // 等待 PRESET_CHANGED 或者直接 sleep 一小段
    await sleep(800);
    const now = await getCurrentConnectionProfile();
    toastOk(`[__TT] 已切换连接配置：${now}`);
    return now;
  }

  // ---------------------------------------------------------------------------
  // 触发生成 / 等待 / 采样
  // ---------------------------------------------------------------------------

  /**
   * 重新生成最后一楼。
   *
   * 实现：ST 没有 /regenerate slash 命令，但有 /trigger（基于已有楼层让 AI 接续）。
   * 如果最后一楼是 assistant，先把它删掉，让 /trigger 基于上一楼的 user 接续。
   * 如果最后一楼是 user，直接 /trigger。
   */
  async function regenerate() {
    const last = TH.getLastMessageId();
    if (last < 0) throw new Error('聊天没有楼层');
    const lastMsg = TH.getChatMessages(last)[0];
    if (lastMsg?.role === 'assistant') {
      await TH.deleteChatMessages([last], { refresh: 'affected' });
    }
    await TH.triggerSlash('/trigger');
    toast('[__TT] 已触发 /trigger（regenerate）');
  }

  /** 像人类一样输入并发送一条用户消息，触发 AI 回复（多轮 RP 用） */
  async function sendUserMessage(content) {
    if (!content) throw new Error('需要消息内容');
    // /send 会创建一条 user 消息但不触发回复；/trigger 让 AI 接续
    // 直接用一个组合命令：把文本塞入输入框 → 触发
    await TH.createChatMessages([{ role: 'user', message: content }]);
    await TH.triggerSlash('/trigger');
    toast(`[__TT] 已发送用户消息：${content.slice(0, 30)}…`);
  }

  /**
   * 等待当前生成完成。
   *
   * 实现：两段式轮询。
   *   阶段 1：等 duringGenerating 从 false → true（启动期，最多 startupTimeoutMs）
   *           触发后立刻轮询可能错过短暂的 true 状态；如果阶段 1 始终 false，认为生成压根没启动。
   *   阶段 2：等 duringGenerating 从 true → false（生成结束）。
   *
   * 不依赖 TH.eventOnce — 那个 API 在 page-level（window.parent.TavernHelper）不存在。
   */
  async function waitForGenerationEnd({
    timeoutMs = 5 * 60 * 1000,
    startupTimeoutMs = 8000,
    intervalMs = 500,
  } = {}) {
    const t0 = Date.now();
    let started = false;
    // 阶段 1
    while (Date.now() - t0 < startupTimeoutMs) {
      try {
        if (TH.builtin?.duringGenerating?.()) {
          started = true;
          break;
        }
      } catch (_) {}
      await sleep(200);
    }
    if (!started) {
      return { ok: false, reason: 'never_started', elapsed_ms: Date.now() - t0 };
    }
    // 阶段 2
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (!TH.builtin?.duringGenerating?.()) {
          // 给 ST 一拍时间把 reasoning / extra 写回 chat[id]
          await sleep(500);
          return { ok: true, reason: 'poll', elapsed_ms: Date.now() - t0 };
        }
      } catch (_) {}
      await sleep(intervalMs);
    }
    return { ok: false, reason: 'timeout', elapsed_ms: Date.now() - t0 };
  }

  async function abortGeneration() {
    try {
      await TH.triggerSlash('/abort');
    } catch (_) {}
    toast('[__TT] /abort 已发送');
  }

  /**
   * 采样最后一条 assistant 楼层：思维链 + 正文 + UI 上的 meta（耗时/token）
   *
   * TH.getChatMessages 的字段位置实测：
   *   include_swipes:false → msg.message 有正文；reasoning 在 msg.extra.extra.reasoning（二级嵌套）
   *   include_swipes:true  → msg.message 是空；正文在 msg.swipes[swipe_id]；reasoning 在 msg.swipes_info[swipe_id].extra.reasoning
   *
   * 我们用 include_swipes:false 拿正文，多路 fallback 抓 reasoning（含 ST 原始 chat[] 兜底）。
   */
  function getLastAssistantMessage() {
    const last = TH.getLastMessageId();
    const msgPlain = TH.getChatMessages(last)[0];
    if (!msgPlain) return null;
    const msgSwiped = TH.getChatMessages(last, { include_swipes: true })[0];

    // 正文
    const body =
      msgPlain.message ||
      msgSwiped?.swipes?.[msgSwiped?.swipe_id] ||
      '';

    // reasoning 多路 fallback
    const ext = msgPlain.extra ?? {};
    let thinking =
      ext.reasoning ||
      ext.extra?.reasoning ||
      ext.reasoning_chain ||
      msgSwiped?.swipes_info?.[msgSwiped?.swipe_id]?.extra?.reasoning ||
      '';
    if (!thinking) {
      // ST 原始 chat 对象兜底
      const ctx = window.parent?.SillyTavern?.getContext?.() ?? window.SillyTavern?.getContext?.();
      thinking = ctx?.chat?.[last]?.extra?.reasoning || '';
    }

    // meta 从 ST 原始数据拿（耗时/token）；DOM 仅作字符串兜底
    const ctx = window.parent?.SillyTavern?.getContext?.() ?? window.SillyTavern?.getContext?.();
    const stMsg = ctx?.chat?.[last];
    const meta_obj = {
      api: stMsg?.extra?.api,
      model: stMsg?.extra?.model,
      token_count: stMsg?.extra?.token_count,
      time_to_first_token: stMsg?.extra?.time_to_first_token,
      reasoning_duration: stMsg?.extra?.reasoning_duration,
    };
    let meta_dom = '';
    try {
      const $doc = $win.document;
      const el = $doc.querySelector(`#chat .mes[mesid="${last}"] .mes_timer`);
      meta_dom = el?.innerText?.trim() ?? '';
    } catch (_) {}

    return {
      message_id: last,
      role: msgPlain.role,
      name: msgPlain.name,
      swipe_id: msgSwiped?.swipe_id ?? 0,
      swipe_count: msgSwiped?.swipes?.length ?? 1,
      thinking,
      body,
      meta: meta_dom,
      meta_obj,
      thinking_len: thinking.length,
      body_len: body.length,
    };
  }

  // ---------------------------------------------------------------------------
  // 单元格一键执行
  // ---------------------------------------------------------------------------

  /**
   * 执行一个条件，留下完整可观察的痕迹。
   *
   * @param spec
   *   - label:        'M-V4-C3-01'
   *   - profileName:  连接配置名（如有则切）
   *   - userMessage:  改写 #1 楼用户消息（如有）
   *   - userMessageId: 默认 1
   *   - keepUntilId:  truncate 到哪楼（默认 1，意思是只保留 #0 #1）
   *   - presetMods:   prompt 修改列表
   *   - timeoutMs:    等待生成的超时
   *   - restoreFrom:  跑完后从该 label 还原预设（默认 'base'）
   */
  async function runCell(spec) {
    const {
      label = 'unnamed',
      profileName,
      userMessage,
      userMessageId = 1,
      keepUntilId = 1,
      presetMods = [],
      timeoutMs = 5 * 60 * 1000,
      restoreFrom = 'base',
    } = spec;

    toastOk(`[__TT] === runCell ${label} 开始 ===`);

    if (profileName) await switchConnectionProfile(profileName);

    // 1. 截断到 #0..#keepUntilId
    await truncateAfter(keepUntilId);

    // 2. 改写 #userMessageId（如果给了 userMessage）
    if (userMessage !== undefined && userMessage !== null) {
      await setUserMessage({ messageId: userMessageId, content: userMessage });
    }

    // 3. apply preset mods
    const modResults = await applyPresetMods(presetMods);

    // 4. 触发 regenerate（如果当前最后一楼已经是 assistant，会覆盖该楼的最新 swipe；
    //    如果最后一楼是 user，会接续生成）
    const t0 = Date.now();
    await regenerate();
    const wait = await waitForGenerationEnd({ timeoutMs });
    const elapsed = Date.now() - t0;

    // 5. 采样
    const result = wait.ok ? getLastAssistantMessage() : null;
    const summary = {
      label,
      ok: wait.ok,
      wait_reason: wait.reason,
      elapsed_ms: elapsed,
      profileName: profileName ?? null,
      mods: modResults,
      ...(result ?? {}),
    };

    // 6. 还原预设（聊天楼层不还原，下次 runCell 会再 truncate）
    if (restoreFrom && snapshots.has(restoreFrom)) {
      try {
        await restorePreset(restoreFrom);
      } catch (e) {
        toastErr(`[__TT] 还原预设失败：${e.message}`);
      }
    }

    // 7. 暂存到 window.__TT.results
    __TT.results[label] = summary;
    toastOk(`[__TT] === runCell ${label} 完成（${elapsed}ms，body=${result?.body_len ?? 0}） ===`);
    return summary;
  }

  // ---------------------------------------------------------------------------
  // 多轮 RP（长程会话）
  // ---------------------------------------------------------------------------

  /** 给一段 user 文本 → 等 AI 回复 → 返回新 assistant 楼内容 */
  async function nextTurn({ userText, timeoutMs = 5 * 60 * 1000 } = {}) {
    if (userText) {
      await sendUserMessage(userText);
    } else {
      await regenerate();
    }
    const wait = await waitForGenerationEnd({ timeoutMs });
    return { wait, ...(wait.ok ? getLastAssistantMessage() : {}) };
  }

  // ---------------------------------------------------------------------------
  // 按钮（在 酒馆助手 → 脚本库 中显示）
  // ---------------------------------------------------------------------------

  try {
    TH.appendInexistentScriptButtons?.([
      { name: '快照基线', visible: true },
      { name: '还原基线', visible: true },
      { name: '展示预设摘要', visible: true },
      { name: '展示聊天摘要', visible: true },
    ]);
    TH.eventOn?.(TH.getButtonEvent?.('快照基线'), () => snapshotPreset('base'));
    TH.eventOn?.(TH.getButtonEvent?.('还原基线'), () => restorePreset('base').catch((e) => toastErr(e.message)));
    TH.eventOn?.(TH.getButtonEvent?.('展示预设摘要'), () => {
      const s = getPresetSummary();
      console.log('[__TT] preset summary', s);
      toast(`[__TT] 预设摘要已输出到 console（${s.prompts.length} 条 prompt）`);
    });
    TH.eventOn?.(TH.getButtonEvent?.('展示聊天摘要'), () => {
      const s = getChatSummary();
      console.log('[__TT] chat summary', s);
      toast(`[__TT] 聊天摘要已输出到 console（最近 ${s.length} 楼）`);
    });
  } catch (e) {
    console.warn('[__TT] 按钮注册失败（脚本可能在前端界面里运行）', e);
  }

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------

  const __TT = {
    // 元信息
    getPresetSummary,
    getChatSummary,
    getCurrentConnectionProfile,
    listConnectionProfiles,

    // 预设
    snapshotPreset,
    restorePreset,
    patchPrompt,
    applyPresetMods,

    // 聊天
    setUserMessage,
    truncateAfter,

    // 模型
    switchConnectionProfile,

    // 生成
    regenerate,
    sendUserMessage,
    waitForGenerationEnd,
    abortGeneration,
    getLastAssistantMessage,

    // 一键
    runCell,
    nextTurn,

    // 数据
    results: {},
    snapshots,

    // 元
    version: '0.1.0',
  };

  $win.__TT = __TT;
  toastOk('[__TT] tavern_test_tool 已就绪（window.__TT）');
  console.log('[__TT] available methods:', Object.keys(__TT));
})();
