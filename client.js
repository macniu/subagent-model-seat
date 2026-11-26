/**
 * Web Client half — subagent-model-seat
 *
 * Stock DSH hides the composer model seat (`conversation.input.model`) for
 * every addressed subagent session, and the stock Host RPC refuses them too:
 * `session.selectModel` resolves the Session through
 * `ApiSessionAgentController.resolveAgent`, which rejects any Session whose
 * header origin is 'subagent' with `session/agent-busy ... owned by subagent
 * routing`. So a subagent conversation could never switch models, by design.
 *
 * This plugin restores the seat, and is a faithful port of the shipped
 * `ModelSelect` component rather than a lookalike:
 *
 *   - the trigger is `model · effort` at the shipped measurements;
 *   - the dropdown is the same two-level card: a root pane with a
 *     `Model` cell and an `Effort` cell, each drilling into its own list,
 *     plus the `conversation.input.model.options` chain for other plugins;
 *   - the model pane keeps the provider-grouped list with pinned headings,
 *     the search field above four models, the pending spinner, and the
 *     provider-default / per-level effort choices in the effort pane;
 *   - Escape and Shift+Tab leave a drilled pane first and otherwise close.
 *
 * Two deviations, both forced by the platform and disclosed in the README:
 *   1. The stock component is not exported from its module, and no compiler
 *      ships with the app, so this is a hand port of the same structure and
 *      the same `ModelSelect.module.css` measurements.
 *   2. Selection goes through the plugin's own same-origin route
 *      (`POST /subagent-model-seat/select`, see index.js) because the stock
 *      RPC refuses subagent Sessions. Ordinary sessions keep using the stock
 *      RPC so resume/persistence semantics stay exactly as shipped.
 */
window.__ModuleLoader__.load({
  id: '@local/subagent-model-seat',
  factory(require) {
    const React = require('react')
    const {
      useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React
    const h = React.createElement

    /**
     * The composer seat carries `will-change: transform`, which makes it the
     * containing block for `position: fixed` descendants — a menu painted
     * inside the card would be clamped to the card's box. The stock seat
     * solves this by portaling to the document body, and `react-dom` is a
     * platform seed module, so the same is available here.
     */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      createPortal = typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : null
    } catch {
      createPortal = null
    }

    /** High enough to win the `single` seat over stock (default 0). */
    const SEAT_PRIORITY = 1000

    /** Same-origin route registered by the Host half. */
    const SELECT_PATH = '/subagent-model-seat/select'

    const STRINGS = {
      zh: {
        model: '模型', effort: '档位', title: '选择该会话使用的模型',
        locked: '当前会话正在处理中，暂不可切换模型',
        search: '搜索模型 / 厂商…', clear: '清除搜索',
        emptyModels: '没有可用的模型', emptySearch: '没有匹配的模型', emptyEfforts: '该模型没有可选档位',
        loading: '加载中…', selectAria: '选择模型',
        providerDefault: '默认', fallback: '选择模型',
        retry: '重试', reload: '重新加载',
        warning: name => `无法加载 ${name} 的模型`,
        action: message => `操作失败：${message}`,
        sessionInUse: '该会话正在写入，请稍后再试',
      },
      en: {
        model: 'Model', effort: 'Effort', title: 'Choose the model for this conversation',
        locked: 'Model is locked while this session is busy',
        search: 'Search models / providers…', clear: 'Clear search',
        emptyModels: 'No models available', emptySearch: 'No matching models', emptyEfforts: 'This model has no effort levels',
        loading: 'Loading…', selectAria: 'Select a model',
        providerDefault: 'Default', fallback: 'Select model',
        retry: 'Retry', reload: 'Reload',
        warning: name => `Could not load models from ${name}`,
        action: message => `Action failed: ${message}`,
        sessionInUse: 'This session is still writing; try again shortly',
      },
    }
    const locale = (typeof navigator !== 'undefined' && navigator.language || '')
      .toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const I18N = STRINGS[locale]

    /** Copy for the settings section (workspace / conversation model matrix). */
    const SETTINGS_STRINGS = {
      zh: {
        nav: '子智能体模型', title: '子智能体模型配置',
        loading: '加载中…', noWorkspace: '没有找到工作区', noSessions: '该工作区下没有对话',
        pick: '从左侧选择一个对话', oneClick: '一键统一',
        oneClickDesc: '该对话委派的子智能体统一用这个模型',
        single: '逐个配置', singleDesc: '给下面每个子会话单独指定',
        apply: '应用', applying: '应用中…', applied: '已应用', failed: '设置失败',
        appliedNothing: '该对话还没有子会话',
        allChildren: '个子智能体', child: '子', currentModel: '当前模型',
        chooseModel: '模型', chooseEffort: '档位', inherit: '跟随会话默认',
        sessionCount: '个对话', untitled: '未命名对话',
        filter: '搜索对话…', close: '关闭',
        searchModel: '搜索模型 / 厂商…', noMatch: '没有匹配的模型',
        catalogError: '模型目录加载失败', noCurrent: '未指定',
        noModelPicked: '先选一个模型', appliedHead: '已写入：',
        appliedLive: '当前会话正在运行，立即生效',
        appliedCold: '已写入会话日志，下次该会话启动时生效',
        sessionInUse: '该会话正在写入，稍后再试',
        modelUnavailable: '这个模型当前不可用（缺凭据或通道不支持）',
        sessionMissing: '找不到该会话', badRequest: '请求参数不合法',
      },
      en: {
        nav: 'Subagent Models', title: 'Subagent Model Configuration',
        loading: 'Loading…', noWorkspace: 'No workspaces found', noSessions: 'No conversations in this workspace',
        pick: 'Pick a conversation on the left', oneClick: 'Apply to all',
        oneClickDesc: 'Use one model for every subagent this conversation delegates',
        single: 'Configure individually', singleDesc: 'Assign a model to each subagent below',
        apply: 'Apply', applying: 'Applying…', applied: 'Applied', failed: 'Failed',
        appliedNothing: 'No subagent sessions yet',
        allChildren: 'subagents', child: 'sub', currentModel: 'Current model',
        chooseModel: 'Model', chooseEffort: 'Effort', inherit: 'Follow session default',
        sessionCount: 'conversations', untitled: 'Untitled conversation',
        filter: 'Search conversations…', close: 'Close',
        searchModel: 'Search models / providers…', noMatch: 'No matching model',
        catalogError: 'Model catalog failed to load', noCurrent: 'not set',
        noModelPicked: 'Pick a model first', appliedHead: 'Written: ',
        appliedLive: 'the session is live, applied now',
        appliedCold: 'stored in the session log, applied when the session next starts',
        sessionInUse: 'This session is writing; try again shortly',
        modelUnavailable: 'This model is unavailable right now (missing credentials or unsupported route)',
        sessionMissing: 'Session not found', badRequest: 'Invalid request',
      },
    }
    const T = SETTINGS_STRINGS[locale]

    /**
     * Scoped stylesheet. Kept inside the component tree (never appended to
     * `document.body`) and class-prefixed so it cannot collide with shell CSS.
     * Every token falls back to the light-theme value so the seat still reads
     * correctly under a theme that omits the alias. Measurements are the
     * shipped `ModelSelect.module.css` ones.
     */
    const CSS_TEXT = `
.sms-root{position:relative;min-width:0}
.sms-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:360px;height:28px;padding:0 4px 0 8px;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:13px;line-height:20px;font-weight:400;cursor:pointer;border-radius:var(--dsw-radius-sm,6px)}
@media(hover:hover){.sms-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}
.sms-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.sms-trigger:disabled{color:var(--dsw-alias-label-dimmed,#9a9a9a);cursor:default}
.sms-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-trigger-effort{flex-shrink:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption,#8e8e8e)}
/* The composer row sets these when its chips must collapse; mirror the stock
   seat so the trigger degrades exactly like the shipped one. */
.sms-trigger-label,.sms-trigger-effort{display:var(--dsh-composer-model-text-display,block)}
.sms-chevron{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;color:var(--dsw-alias-label-caption,#8e8e8e);transition:transform 120ms ease}
.sms-chevron-open{transform:rotate(180deg)}
.sms-menu{box-sizing:border-box;position:fixed;right:var(--sms-anchor-right,12px);bottom:var(--sms-anchor-bottom,64px);z-index:1100;display:flex;flex-direction:column;width:max-content;min-width:min(240px,calc(100vw - 24px));max-width:min(420px,calc(100vw - 24px));max-height:min(360px,calc(100dvh - 96px));overflow:hidden;padding:4px;border:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,inherit)}
@media(pointer:coarse){.sms-menu{max-height:min(60dvh,420px)}}
.sms-search-row{position:relative;flex-shrink:0;margin:2px 0 3px}
.sms-search{box-sizing:border-box;display:block;width:100%;padding:5px 7px;border:0 solid transparent;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font-family:inherit;font-size:12px;line-height:normal;outline:none}
.sms-search-with-query{padding-right:34px}
.sms-search::placeholder{color:var(--dsw-alias-label-caption,#8e8e8e)}
@media(pointer:coarse){.sms-search{font-size:16px}}
.sms-search-clear{position:absolute;top:50%;right:4px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer}
@media(hover:hover){.sms-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}
.sms-groups{min-height:0;flex:1 1 auto;overflow-x:hidden;overflow-y:auto;display:block;scrollbar-color:var(--dsh-scrollbar-thumb,var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35))) transparent}
.sms-group{display:block;flex:0 0 auto}
.sms-group-label{position:sticky;top:0;z-index:1;margin:0;padding:6px 7px 4px;background:var(--dsw-alias-menu-group-header-fill,var(--dsw-alias-bg-layer-2,#fff));backdrop-filter:blur(2px);color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:11px;line-height:16px;font-weight:500;letter-spacing:.3px;text-transform:uppercase}
.sms-option{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:auto;min-width:100%;min-height:34px;padding:5px 7px;border:none;outline:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;text-align:left;cursor:pointer}
.sms-option:focus-visible,.sms-option[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
@media(hover:hover){.sms-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}
.sms-option:disabled{color:var(--dsw-alias-label-dimmed,#9a9a9a);cursor:default}
.sms-option-copy{display:flex;flex:1;flex-direction:column;min-width:0}
.sms-model-name{overflow:hidden;color:inherit;font-size:13px;line-height:18px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}
.sms-check{display:flex;align-items:center;justify-content:center;flex:0 0 14px;color:var(--dsw-alias-label-primary,inherit)}
.sms-spinner{display:inline-block;width:10px;height:10px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;opacity:.7;animation:sms-spin .8s linear infinite}
@keyframes sms-spin{to{transform:rotate(360deg)}}
.sms-cell{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:auto;min-width:100%;height:34px;padding:0 8px;border:none;outline:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.sms-cell:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
@media(hover:hover){.sms-cell:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}
.sms-cell:disabled{color:var(--dsw-alias-label-dimmed,#9a9a9a);cursor:default}
.sms-cell-label{flex:0 0 auto;white-space:nowrap}
.sms-cell-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-tertiary,#8e8e8e)}
.sms-cell-chevron{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-caption,#8e8e8e))}
.sms-status,.sms-empty{padding:8px;color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:12px;line-height:18px}
.sms-empty{text-align:center}
.sms-error,.sms-warning{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:3px;padding:6px 7px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12));color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px;line-height:16px}
.sms-warning{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08));color:var(--dsw-alias-state-warn-label,#a86a00)}
.sms-retry{flex:0 0 auto;padding:0;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
`

    /** Scoped stylesheet for the settings section, using the same theme tokens. */
    const SETTINGS_CSS = `
.sms-set{display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:18px;min-height:0}
.sms-set-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.sms-set-input{box-sizing:border-box;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;outline:none}
.sms-set-input:focus-visible{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sms-set-filter{flex:0 1 240px;min-width:120px}
.sms-set-count{color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:11px;flex:0 0 auto}
.sms-set-spacer{flex:1 1 auto}
.sms-set-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;cursor:pointer;flex:0 0 auto}
.sms-set-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.sms-set-btn:disabled{color:var(--dsw-alias-label-dimmed,#9a9a9a);cursor:default}
.sms-set-primary{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;color:var(--dsw-alias-label-on-accent,#fff)}
.sms-set-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4d6bfe);filter:brightness(1.06)}
.sms-set-body{display:grid;grid-template-columns:220px minmax(0,1fr);gap:10px;min-height:0;flex:1 1 auto}
.sms-set-tree{display:flex;flex-direction:column;gap:1px;overflow-y:auto;max-height:min(56vh,460px);padding-right:2px;border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1))}
.sms-set-ws{display:flex;flex-direction:column;flex:0 0 auto}
.sms-set-ws-head{display:flex;flex:0 0 auto;align-items:center;gap:6px;width:100%;padding:3px 4px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-weight:500;cursor:pointer;text-align:left}
.sms-set-ws-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.sms-set-caret{display:inline-block;width:9px;flex:0 0 9px;font-size:9px;color:var(--dsw-alias-label-tertiary,#8e8e8e);transition:transform 120ms ease}
.sms-set-caret-open{transform:rotate(90deg)}
.sms-set-ws-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-set-sessions{display:flex;flex-direction:column;gap:1px;padding-left:14px}
.sms-set-session{display:flex;flex:0 0 auto;align-items:center;gap:4px;width:100%;padding:3px 6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-set-session:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.sms-set-session[data-selected=true]{background:var(--dsw-alias-interactive-bg-selected,rgba(77,107,254,.14));color:var(--dsw-alias-label-primary,inherit);font-weight:500}
.sms-set-current{margin-left:auto;flex:1 1 100%;order:9;color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-set-child-route{display:block;color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:10px;line-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-set-child-tag{margin-left:auto;flex:0 0 auto;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:10px;line-height:14px}
.sms-set-detail{min-width:0;overflow-y:auto;max-height:min(56vh,460px)}
.sms-set-panel{display:flex;flex-direction:column;gap:8px;min-width:0}
.sms-set-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.sms-set-title{font-size:13px;line-height:18px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-set-sub{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:11px}
.sms-set-block{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}
.sms-set-block-grow{flex:1 1 auto;min-height:0}
.sms-set-block-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.sms-set-block-title{font-weight:600;flex:0 0 auto}
.sms-set-desc{color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:11px;line-height:16px;min-width:0}
.sms-set-row{display:flex;align-items:flex-end;gap:6px;flex-wrap:wrap;min-width:0}
.sms-set-children{display:flex;flex-direction:column;min-width:0}
.sms-set-child-row{display:flex;flex:0 0 auto;align-items:flex-end;gap:6px;padding:5px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1));min-width:0}
.sms-set-child-row:first-child{border-top:0}
.sms-set-child-name{flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-bottom:5px;color:var(--dsw-alias-label-secondary,#666)}
.sms-set-msg{margin-top:2px;font-size:11px;line-height:16px}
.sms-set-msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary,#2f8f4e)}
.sms-set-msg[data-kind=err]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.sms-set-empty{padding:20px 8px;color:var(--dsw-alias-label-tertiary,#8e8e8e);text-align:center}
.sms-st-field-wrap{display:flex;flex-direction:column;gap:2px;flex:1 1 200px;min-width:0}
.sms-st-field-narrow{flex:0 1 126px}
.sms-st-field-label{color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:10px;line-height:14px}
.sms-st-field-label:empty{display:none}
.sms-st-field{display:flex;align-items:center;gap:4px;width:100%;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;cursor:pointer;text-align:left;min-width:0}
.sms-st-field:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.sms-st-field:disabled{color:var(--dsw-alias-label-dimmed,#9a9a9a);cursor:default}
.sms-st-field-idle{color:var(--dsw-alias-label-tertiary,#8e8e8e)}
.sms-st-field-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-st-caret{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:10px}
.sms-st-pop{position:fixed;z-index:1100;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:4px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-background,#fff));box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.22))}
.sms-st-search{box-sizing:border-box;width:100%;padding:3px 6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));color:inherit;font:inherit;outline:none}
.sms-st-search::placeholder{color:var(--dsw-alias-label-caption,#9a9a9a)}
.sms-st-list{display:flex;flex-direction:column;gap:1px;max-height:min(240px,38vh);overflow-y:auto;overscroll-behavior:contain}
.sms-st-group{position:sticky;top:0;z-index:1;flex:0 0 auto;padding:3px 6px 2px;background:var(--dsw-alias-menu-group-header-fill,var(--dsw-alias-bg-layer-2,transparent));color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:10px;line-height:14px;font-weight:500;letter-spacing:.3px;text-transform:uppercase}
.sms-st-row{display:block;flex:0 0 auto;width:100%;padding:4px 6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sms-st-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.sms-st-row[data-current=true]{background:var(--dsw-alias-interactive-bg-selected,rgba(77,107,254,.14))}
.sms-st-row-inherit{color:var(--dsw-alias-label-secondary,#666)}
.sms-st-empty{padding:8px 6px;color:var(--dsw-alias-label-tertiary,#8e8e8e);font-size:11px}
`


    /** Resolve the real subagent address (mode included) from the sessions face. */
    function subagentAddress(sessions, sessionId) {
      try {
        return typeof sessions?.subagentAddress === 'function'
          ? sessions.subagentAddress(sessionId)
          : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Every addressed subagent qualifies. A continuation-capable child keeps a
     * live Agent and takes the change immediately; a one-shot or already-cold
     * child has no Agent, so the Host route appends the selection to its stored
     * log and the next continuation reads it back. Ordinary sessions always
     * qualify.
     */
    function canSwitch(sessionId, sessions) {
      return true
    }

    /** Post one selection to the plugin's Host route. */
    async function postSelection(body) {
      if (typeof fetch !== 'function') {
        return { ok: false, error: { code: 'seat/no-fetch', message: 'fetch is unavailable' } }
      }
      let response
      try {
        response = await fetch(SELECT_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        })
      } catch (error) {
        return {
          ok: false,
          error: { code: 'seat/network', message: error instanceof Error ? error.message : String(error) },
        }
      }
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (payload === null || typeof payload !== 'object') {
        return { ok: false, error: { code: 'seat/bad-response', message: `HTTP ${response.status}` } }
      }
      return payload
    }

    const EMPTY_SNAPSHOT = { groups: [], current: null, failures: [], status: 'idle', error: null }

    /** Provider rows, keeping the raw catalog model so reasoning travels with it. */
    function buildGroups(state) {
      const groups = []
      for (const group of state.groups ?? []) {
        const provider = {
          id: group.id,
          name: group.id === 'deepseek-account' ? 'DeepSeek Account' : (group.name ?? group.id),
        }
        const models = (group.models ?? []).map(model => ({ group: provider, model }))
        if (models.length > 0) groups.push({ provider, models })
      }
      return groups
    }

    /**
     * Rank by a literal query over BOTH model and provider names, then drop
     * empty groups. A provider-name hit keeps that whole group (so searching
     * "deepseek" or "gjld" reveals everything that vendor offers), while a
     * model-name hit keeps just the matching rows — the stock grouping order
     * is preserved either way.
     */
    function filterGroups(groups, query, ranked) {
      const needle = ranked ? query.trim().toLowerCase() : ''
      if (needle.length === 0) return groups
      return groups
        .map(group => {
          const providerHit = `${group.provider.name ?? ''} ${group.provider.id ?? ''}`.toLowerCase().includes(needle)
          return {
            ...group,
            models: providerHit
              ? group.models
              : group.models.filter(({ model }) => `${model.name ?? model.id} ${model.id}`.toLowerCase().includes(needle)),
          }
        })
        .filter(group => group.models.length > 0)
    }

    /** Effort choices: provider default first only while the model declares none of its own. */
    function effortChoicesFor(reasoning) {
      if (reasoning === undefined || reasoning === null) return []
      const choices = reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: I18N.providerDefault }]
        : []
      for (const level of reasoning.efforts ?? []) {
        choices.push({ key: `effort:${level.id}`, effort: level.id, label: level.name ?? level.id })
      }
      return choices
    }

    /**
     * Composer model seat. Props are the slot's injected face spread directly
     * (available, directory, load, resolveText, select) plus runtime `locked`
     * and the renderer-provided `renderSlot` for this registration's children.
     */
    function ModelSeat({ locked, available, directory, select, renderSlot }) {
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('root')
      const [query, setQuery] = useState('')
      const [active, setActive] = useState(-1)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [anchor, setAnchor] = useState(null)
      const rootRef = useRef(null)
      const menuRef = useRef(null)
      const triggerRef = useRef(null)
      const listRef = useRef(null)
      const searchRef = useRef(null)
      /** Where focus should land after the pane swaps; 'drill' lands on the checked row. */
      const paneFocus = useRef(null)
      const modelCells = useRef([])

      const subscribe = useCallback(
        cb => directory?.subscribe?.(cb) ?? (() => {}),
        [directory],
      )
      const getSnapshot = useCallback(
        () => directory?.getSnapshot?.() ?? EMPTY_SNAPSHOT,
        [directory],
      )
      const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

      /**
       * A selection written to a cold subagent log lands in persistence, not in
       * the projection this view folds, so the projection would keep reporting
       * the previous route. Keep the accepted selection locally and drop it as
       * soon as the projection agrees.
       */
      const [accepted, setAccepted] = useState(null)
      const current = accepted ?? state.current

      useEffect(() => {
        if (accepted === null) return
        const projected = state.current
        if (projected === null || projected === undefined) return
        if (projected.provider === accepted.provider
          && projected.model === accepted.model
          && (projected.reasoningEffort ?? undefined) === (accepted.reasoningEffort ?? undefined)) {
          setAccepted(null)
        }
      }, [accepted, state.current])

      const groups = useMemo(() => buildGroups(state), [state.groups])
      const showSearch = groups.reduce((total, group) => total + group.models.length, 0) > 4
      const filtered = useMemo(
        () => filterGroups(groups, query, showSearch),
        [groups, query, showSearch],
      )
      const visible = useMemo(
        () => filtered.flatMap(group => group.models.map(({ model }) => ({ provider: group.provider.id, model: model.id }))),
        [filtered],
      )

      const currentGroup = groups.find(group => group.provider.id === current?.provider)
      const currentChoice = currentGroup?.models.find(({ model }) => model.id === current?.model)
      const reasoning = currentChoice?.model.reasoning
      const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = reasoning === undefined || reasoning === null
        ? undefined
        : effectiveEffort === undefined
          ? I18N.providerDefault
          : (reasoning.efforts ?? []).find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
      const effortChoices = useMemo(() => effortChoicesFor(reasoning), [reasoning])

      const modelLabel = currentChoice?.model.name
        ?? (state.status === 'loading' ? I18N.loading : I18N.fallback)

      // Provider headings stay pinned only if the scroller is the scrollport;
      // the sticky rule is CSS, so nothing imperative is needed here beyond
      // keeping the checked row in view when the model pane opens.
      const activeIndex = useMemo(() => {
        if (active >= 0) return Math.min(active, visible.length - 1)
        const found = visible.findIndex(row => row.provider === current?.provider && row.model === current?.model)
        return found
      }, [active, visible, current])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (menuRef.current?.contains(event.target) === true) return
          setOpen(false)
          setPane('root')
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      // A pane swap unmounts the focused row; hand the keyboard to the row that
      // carries the current value, or back to the root cell that was left.
      useEffect(() => {
        if (!open) return
        const intent = paneFocus.current
        paneFocus.current = null
        if (intent === null) return
        if (intent === 'drill') {
          if (pane === 'model') {
            if (showSearch) { searchRef.current?.focus(); return }
            const checked = menuRef.current?.querySelector('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
            ;(checked ?? listRef.current?.querySelector('button:not([disabled])') ?? triggerRef.current)?.focus()
            return
          }
          if (pane === 'effort') {
            const checked = menuRef.current?.querySelector('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
            ;(checked ?? triggerRef.current)?.focus()
          }
          return
        }
        const cell = modelCells.current[intent === 'effort' ? 1 : 0]
        ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
      }, [open, pane, showSearch])

      useLayoutEffect(() => {
        if (!open || pane !== 'model' || showSearch) return
        if (activeIndex < 0) return
        const node = listRef.current?.querySelectorAll('button[role="menuitemradio"]')[activeIndex]
        node?.scrollIntoView?.({ block: 'nearest' })
      }, [open, pane, activeIndex, showSearch])

      // The menu paints into the viewport (position:fixed) so the composer
      // card's own overflow cannot crop it. Its offset is measured from the
      // trigger and re-measured while the page scrolls or the window resizes.
      const measure = () => {
        const rect = triggerRef.current?.getBoundingClientRect?.()
        if (rect === undefined || rect === null) return
        setAnchor({
          right: Math.max(12, Math.round((window.innerWidth || 0) - rect.right)),
          bottom: Math.max(12, Math.round((window.innerHeight || 0) - rect.top + 8)),
        })
      }

      useEffect(() => {
        if (!open) return undefined
        measure()
        const onMove = () => { measure() }
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
          window.removeEventListener('resize', onMove)
          window.removeEventListener('scroll', onMove, true)
        }
      }, [open])

      if (!available) return null

      /** The child slot other plugins contribute to, replayed with the shipped owner props. */
      const renderOptions = (dismiss) => (typeof renderSlot === 'function'
        ? renderSlot('conversation.input.model.options', {
          locked: locked || busy,
          dismiss,
          reportFailure: message => setError(String(message)),
        })
        : null)

      const renderModelLabel = (provider, model, placement, selected) => {
        if (typeof renderSlot === 'function') {
          return renderSlot('conversation.input.model.label', {
            provider: { id: provider.id, name: provider.name },
            model,
            placement,
            selected,
          }, { fallback: model.name ?? model.id })
        }
        return model.name ?? model.id
      }

      const close = (restoreFocus) => {
        setOpen(false)
        setPane('root')
        setQuery('')
        setActive(-1)
        if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
      }

      const show = () => {
        setError(null)
        setQuery('')
        setActive(-1)
        // No current model (an empty catalog) means the model list is the only
        // useful pane, exactly as the stock seat opens.
        if (currentChoice === undefined) {
          paneFocus.current = 'drill'
          setPane('model')
        } else {
          setPane('root')
        }
        setOpen(true)
      }

      const drill = (next) => {
        setQuery('')
        setActive(-1)
        paneFocus.current = 'drill'
        setPane(next)
      }

      const back = (from) => {
        paneFocus.current = from
        setPane('root')
      }

      const submit = async (selection) => {
        setError(null)
        triggerRef.current?.focus()
        setBusy(true)
        try {
          const result = await select(selection)
          if (result && result.ok === false) {
            const code = result.error?.code ?? 'error'
            const message = result.error?.message ?? 'selection failed'
            setError(code === 'session/writer-held' ? I18N.sessionInUse : I18N.action(`${code}: ${message}`))
            return
          }
          // The projection only re-folds on reload for a cold log, so mirror the
          // accepted route here; the effect below clears it once they agree.
          setAccepted(selection)
          close(true)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      const chooseModel = (provider, model) => {
        if (current?.provider === provider && current?.model === model.id) {
          close(true)
          return
        }
        void submit({
          provider,
          model: model.id,
          ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }),
        })
      }

      const chooseEffort = (effort) => {
        if (current === null || current === undefined) return
        if (effectiveEffort === effort) {
          close(true)
          return
        }
        void submit({
          provider: current.provider,
          model: current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        })
      }

      const optionRows = () => visible

      const onMenuKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          // Escape leaves a drilled pane for the root one before it closes.
          if (pane !== 'root' && currentChoice !== undefined) back(pane)
          else close(true)
          return
        }
        if (event.key === 'Tab' && event.shiftKey) {
          if (pane !== 'root' && currentChoice !== undefined) {
            event.preventDefault()
            back(pane)
          }
          return
        }
        if (pane === 'model') {
          if (event.key === 'Enter' && activeIndex >= 0) {
            const row = visible[activeIndex]
            if (row === undefined) return
            const group = groups.find(candidate => candidate.provider.id === row.provider)
            const model = group?.models.find(candidate => candidate.model.id === row.model)?.model
            if (model === undefined) return
            event.preventDefault()
            chooseModel(row.provider, model)
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          if (showSearch) return // the search field owns the arrow keys
          event.preventDefault()
          if (visible.length === 0) return
          setActive(prev => {
            const start = activeIndex < 0 ? -1 : activeIndex
            if (event.key === 'ArrowDown') return (start + 1) % visible.length
            return start <= 0 ? visible.length - 1 : start - 1
          })
          return
        }
        if (pane === 'effort') {
          if (event.key !== 'Enter') return
          const checked = menuRef.current?.querySelector('[role="menuitemradio"][aria-checked="true"]')
          const target = document.activeElement
          if (checked === null && target instanceof HTMLElement) return
        }
      }

      const portal = (node) => {
        if (createPortal === null || typeof document === 'undefined') return node
        return createPortal(node, document.body)
      }

      const spinner = h('span', { className: 'sms-spinner', 'aria-hidden': 'true' })

      const rootPane = () => [
        h('button', {
          key: 'cell-model',
          ref: node => { modelCells.current[0] = node },
          type: 'button',
          role: 'menuitem',
          className: 'sms-cell',
          disabled: busy,
          onClick: () => { drill('model') },
        },
          h('span', { className: 'sms-cell-label' }, I18N.model),
          h('span', { className: 'sms-cell-value' },
            currentChoice === undefined
              ? modelLabel
              : renderModelLabel(currentGroup.provider, currentChoice.model, 'menu', true)),
          h('span', { className: 'sms-cell-chevron' }, h('svg', {
            width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
            strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          }, h('path', { d: 'M4.5 3 7.5 6 4.5 9' }))),
        ),
        reasoning === undefined || reasoning === null
          ? null
          : h('button', {
            key: 'cell-effort',
            ref: node => { modelCells.current[1] = node },
            type: 'button',
            role: 'menuitem',
            className: 'sms-cell',
            disabled: busy,
            onClick: () => { drill('effort') },
          },
            h('span', { className: 'sms-cell-label' }, I18N.effort),
            h('span', { className: 'sms-cell-value' }, effortLabel),
            h('span', { className: 'sms-cell-chevron' }, h('svg', {
              width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
              strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
            }, h('path', { d: 'M4.5 3 7.5 6 4.5 9' }))),
          ),
        renderOptions(() => { close(true) }),
      ]

      const modelPane = () => [
        showSearch
          ? h('div', { key: 'search', className: 'sms-search-row' },
            h('input', {
              ref: searchRef,
              type: 'text',
              role: 'searchbox',
              'aria-label': I18N.search,
              className: `sms-search${query !== '' ? ' sms-search-with-query' : ''}`,
              placeholder: I18N.search,
              value: query,
              readOnly: busy,
              autoFocus: true,
              onChange: event => { setQuery(event.target.value); setActive(0) },
            }),
            query !== ''
              ? h('button', {
                type: 'button',
                className: 'sms-search-clear',
                'aria-label': I18N.clear,
                disabled: busy,
                onClick: () => { setQuery(''); setActive(-1); searchRef.current?.focus() },
              }, h('svg', {
                width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
                strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': 'true',
              }, h('path', { d: 'M3 3 9 9M9 3 3 9' })))
              : null,
          )
          : null,
        state.status === 'loading' && visible.length === 0
          ? h('div', { key: 'loading', className: 'sms-status' }, I18N.loading)
          : null,
        state.error !== null && state.error !== undefined
          ? h('div', { key: 'error', className: 'sms-error', role: 'alert' },
            h('span', null, I18N.action(String(state.error))))
          : null,
        ...(state.failures ?? []).map(failure => h('div', { key: `fail-${failure.id}`, className: 'sms-warning' },
          h('span', null, I18N.warning(failure.id === 'deepseek-account' ? 'DeepSeek Account' : failure.name)),
          h('button', { type: 'button', className: 'sms-retry', onClick: () => { setError(null) } }, I18N.retry))),
        filtered.length > 0
          ? h('div', {
            key: 'groups', ref: listRef, className: 'sms-groups', role: 'group', 'aria-label': I18N.model,
          },
            ...filtered.map(group => h('div', { className: 'sms-group', key: group.provider.id },
              h('div', { className: 'sms-group-label' }, group.provider.name),
              ...group.models.map(({ model }) => {
                const index = visible.findIndex(row => row.provider === group.provider.id && row.model === model.id)
                const selected = current?.provider === group.provider.id && current?.model === model.id
                const pending = state.pending !== null && state.pending !== undefined
                  && state.pending.provider === group.provider.id && state.pending.model === model.id
                return h('button', {
                  key: `${group.provider.id}/${model.id}`,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': selected ? 'true' : 'false',
                  tabIndex: showSearch ? -1 : 0,
                  'data-current': selected ? 'true' : undefined,
                  'data-active': index === activeIndex ? '' : undefined,
                  className: 'sms-option',
                  title: model.name ?? model.id,
                  disabled: busy,
                  onFocus: () => setActive(index),
                  onMouseMove: busy || index === activeIndex ? undefined : () => setActive(index),
                  onClick: () => chooseModel(group.provider.id, model),
                },
                  h('span', { className: 'sms-option-copy' },
                    h('span', { className: 'sms-model-name' }, renderModelLabel(group.provider, model, 'option', selected))),
                  h('span', { className: 'sms-check' }, pending ? spinner : selected ? h('svg', {
                    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor',
                    strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
                  }, h('path', { d: 'M2.5 7.5 5.5 10.5 11.5 4' })) : null),
                )
              }),
            )),
          )
          : null,
        state.status === 'ready' && filtered.length === 0
          ? h('div', { key: 'empty', className: 'sms-empty', role: 'status' },
            groups.length === 0 ? I18N.emptyModels : I18N.emptySearch)
          : null,
      ]

      const effortPane = () => (effortChoices.length === 0
        ? [h('div', { key: 'none', className: 'sms-empty' }, I18N.emptyEfforts)]
        : [h('div', { key: 'groups', className: 'sms-groups', role: 'group', 'aria-label': I18N.effort },
          ...effortChoices.map(level => {
            const selected = effectiveEffort === level.effort
            const pending = state.pending !== null && state.pending !== undefined
              && state.pending.provider === current?.provider
              && state.pending.model === current?.model
              && state.pending.reasoningEffort === level.effort
            return h('button', {
              key: level.key,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected ? 'true' : 'false',
              'data-current': selected ? 'true' : undefined,
              className: 'sms-option',
              disabled: busy,
              onClick: () => chooseEffort(level.effort),
            },
              h('span', { className: 'sms-option-copy' },
                h('span', { className: 'sms-model-name' }, level.label)),
              h('span', { className: 'sms-check' }, pending ? spinner : selected ? h('svg', {
                width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor',
                strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
              }, h('path', { d: 'M2.5 7.5 5.5 10.5 11.5 4' })) : null),
            )
          }))])

      return h('div', { className: 'sms-root', ref: rootRef },
        h('style', { key: 'sms-css' }, CSS_TEXT),
        h('button', {
          type: 'button',
          ref: triggerRef,
          className: 'sms-trigger',
          disabled: locked || busy,
          onClick: () => { if (open) close(false); else show() },
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown' && !open) {
              event.preventDefault()
              show()
            }
          },
          title: locked ? I18N.locked : I18N.title,
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
        },
          h('span', { className: 'sms-trigger-label' },
            currentChoice === undefined
              ? modelLabel
              : renderModelLabel(currentGroup.provider, currentChoice.model, 'trigger', true)),
          effortLabel !== undefined
            ? h('span', { className: 'sms-trigger-effort' }, effortLabel)
            : null,
          busy
            ? spinner
            : h('span', { className: `sms-chevron${open ? ' sms-chevron-open' : ''}` },
              h('svg', {
                width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
                strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
              }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' })),
            ),
        ),
        open ? portal(h('div', {
          className: 'sms-menu',
          role: pane === 'model' ? 'group' : 'menu',
          'aria-label': I18N.title,
          'aria-busy': state.status === 'loading' || busy ? 'true' : 'false',
          onKeyDown: onMenuKeyDown,
          ref: menuRef,
          style: anchor === null
            ? undefined
            : { '--sms-anchor-right': `${anchor.right}px`, '--sms-anchor-bottom': `${anchor.bottom}px` },
        },
          error !== null
            ? h('div', { className: 'sms-error', role: 'alert' }, h('span', null, error))
            : null,
          ...(pane === 'root' ? rootPane() : pane === 'model' ? modelPane() : effortPane()),
        )) : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Settings section — workspace / conversation subagent-model matrix
     * ------------------------------------------------------------------ */

    const EMPTY_WS = { items: [], state: 'idle', phase: 'pending', error: null }
    const EMPTY_SESSIONS = { ids: [], byId: {}, phase: 'pending' }

    /** Subscribe to an ObservableSnapshot face without re-creating fallbacks. */
    function useFace(store, fallback) {
      const subscribe = useCallback(cb => store?.subscribe?.(cb) ?? (() => {}), [store])
      const getSnapshot = useCallback(() => store?.getSnapshot?.() ?? fallback, [store, fallback])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /**
     * Read the Host-generation model catalog through the plain Remote.
     *
     * `ctx.modelDirectories.directoryFor(sessionId)` requires a live Client
     * binding, so any conversation that is not currently open resolves no
     * directory at all. The old settings page derived its model list from that
     * directory, which is why cold conversations showed an empty picker and
     * could not be configured. The catalog itself is global — one list for the
     * whole Host generation — so read it directly and share it everywhere.
     */
    function useModelCatalog(remote) {
      const [state, setState] = useState({ groups: [], status: 'loading', error: null })
      useEffect(() => {
        if (remote === undefined || remote === null) return undefined
        let live = true
        const apply = (response) => {
          if (!live) return
          const value = response !== null && typeof response === 'object' && 'ok' in response
            ? (response.ok === false ? null : response.value)
            : response
          if (value === null || value === undefined) {
            const message = response?.error?.message ?? response?.error?.code ?? 'modelCatalog failed'
            setState({ groups: [], status: 'error', error: String(message) })
            return
          }
          setState({ groups: Array.isArray(value.groups) ? value.groups : [], status: 'ready', error: null })
        }
        const load = () => {
          let pending
          try {
            pending = remote.session.modelCatalog()
          } catch (error) {
            if (live) setState({ groups: [], status: 'error', error: String(error?.message ?? error) })
            return
          }
          Promise.resolve(pending).then(apply, error => {
            if (live) setState({ groups: [], status: 'error', error: String(error?.message ?? error) })
          })
        }
        load()
        const offs = []
        for (const name of ['llm/models-updated', 'llm/adapters-updated', 'credentials/record-updated', 'connection/reset']) {
          try {
            const off = remote.$on?.(name, load)
            if (typeof off === 'function') offs.push(off)
          } catch { /* this Host generation does not carry the event */ }
        }
        return () => {
          live = false
          for (const off of offs) { try { off() } catch { /* already detached */ } }
        }
      }, [remote])
      return state
    }

    /** Every descendant of a session (its delegated subagent conversations). */
    function descendantsOf(sessionId, byId) {
      const out = []
      const seen = new Set([sessionId])
      const walk = (parent) => {
        for (const row of Object.values(byId ?? {})) {
          if (row.parentId === parent && !seen.has(row.id)) {
            seen.add(row.id)
            out.push(row)
            walk(row.id)
          }
        }
      }
      walk(sessionId)
      return out
    }

    /**
     * Current model route a conversation is pinned to, read from the Session
     * summary projection. `next` is the latest recorded selection; `lastUsed`
     * is what the last request actually used.
     */
    function currentRouteOf(row) {
      const state = row?.projectionValues?.modelSelection
      const route = state?.next ?? state?.lastUsed
      if (route === null || route === undefined) return null
      if (typeof route.provider !== 'string' || typeof route.model !== 'string') return null
      return { provider: route.provider, model: route.model, model_: route.model, effort: route.reasoningEffort ?? '' }
    }

    /** Human label for a route, resolved against the loaded catalog. */
    function routeLabel(route, groups) {
      if (route === null) return null
      for (const group of groups ?? []) {
        if (group.provider.id !== route.provider) continue
        const hit = group.models.find(({ model }) => model.id === route.model)
        if (hit !== undefined) return `${group.provider.name} / ${hit.model.name ?? hit.model.id}`
      }
      return `${route.provider} / ${route.model}`
    }

    /** Provider groups in the seat's shape (name override matches the composer). */
    function catalogGroups(raw) {
      const groups = []
      for (const group of raw ?? []) {
        const provider = {
          id: group.id,
          name: group.id === 'deepseek-account' ? 'DeepSeek Account' : (group.name ?? group.id),
        }
        const models = (group.models ?? []).map(model => ({ group: provider, model }))
        if (models.length > 0) groups.push({ provider, models })
      }
      return groups
    }

    /**
     * Flat picker entries grouped by provider, matched exactly like the
     * composer seat: a provider-name hit keeps that whole vendor, a model-name
     * hit keeps just the matching rows.
     */
    function modelEntries(groups, query) {
      const needle = query.trim().toLowerCase()
      const out = []
      for (const group of groups) {
        const providerHit = needle.length === 0
          || `${group.provider.name ?? ''} ${group.provider.id ?? ''}`.toLowerCase().includes(needle)
        const rows = providerHit
          ? group.models
          : group.models.filter(({ model }) => `${model.name ?? model.id} ${model.id}`.toLowerCase().includes(needle))
        if (rows.length === 0) continue
        out.push({ kind: 'group', key: `g:${group.provider.id}`, label: group.provider.name })
        for (const { model } of rows) {
          out.push({
            kind: 'row',
            key: `m:${group.provider.id}/${model.id}`,
            label: model.name ?? model.id,
            hint: `${group.provider.name} /`,
            value: `${group.provider.id}\u0000${model.id}`,
            efforts: model.reasoning?.efforts ?? [],
            defaultEffort: model.reasoning?.defaultEffort,
          })
        }
      }
      return out
    }

    /**
     * Anchor a floating panel to a trigger element.
     *
     * The settings section lives inside scrollable panels, so an absolutely
     * positioned panel would be clipped by an ancestor's overflow. Measure the
     * trigger rect instead and place the panel with viewport coordinates,
     * flipping upward when the field sits low on screen.
     */
    function useAnchoredPanel(open, ref, height) {
      const [anchor, setAnchor] = useState(null)
      useEffect(() => {
        if (!open) { setAnchor(null); return undefined }
        const measure = () => {
          const rect = ref.current?.getBoundingClientRect?.()
          if (rect === undefined || rect === null || typeof window === 'undefined') return
          const up = rect.bottom + height > window.innerHeight && rect.top > height
          setAnchor({
            left: Math.max(8, Math.round(rect.left)),
            width: Math.max(180, Math.round(rect.width)),
            top: up ? undefined : Math.round(rect.bottom + 4),
            bottom: up ? Math.round(window.innerHeight - rect.top + 4) : undefined,
          })
        }
        measure()
        const onMove = () => measure()
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
          window.removeEventListener('resize', onMove)
          window.removeEventListener('scroll', onMove, true)
        }
      }, [open, ref, height])
      return anchor
    }

    const portalNode = node => {
      if (createPortal === null || typeof document === 'undefined') return node
      return createPortal(node, document.body)
    }

    /**
     * One compact searchable picker.
     *
     * A native `<select>` cannot search and cannot stay scrollable with a
     * hundred models, so this renders its own trigger plus a portaled panel
     * that searches providers and models exactly like the composer seat.
     */
    function ModelField({ value, groups, label, t, disabled, onPick }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const buttonRef = useRef(null)
      const panelRef = useRef(null)
      const searchRef = useRef(null)
      const entries = useMemo(() => modelEntries(groups, query), [groups, query])
      const anchor = useAnchoredPanel(open, buttonRef, 300)

      const [provider, model] = value === '' ? ['', ''] : value.split('\u0000')
      const display = value === ''
        ? t.inherit
        : (groups.flatMap(group => group.models)
          .find(({ group, model: candidate }) => group.id === provider && candidate.id === model)
          ?.model.name ?? model)

      const close = () => { setOpen(false); setQuery('') }
      const choose = (entry) => {
        close()
        if (entry === null) { onPick(null); return }
        onPick({
          provider: entry.value.split('\u0000')[0],
          model: entry.value.split('\u0000')[1],
          efforts: entry.efforts,
          defaultEffort: entry.defaultEffort,
        })
      }

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (buttonRef.current?.contains?.(event.target) === true) return
          if (panelRef.current?.contains?.(event.target) === true) return
          setOpen(false); setQuery('')
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          setOpen(false); setQuery('')
          buttonRef.current?.focus?.()
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      useEffect(() => {
        if (open) searchRef.current?.focus?.()
      }, [open])

      const panel = open && anchor !== null
        ? portalNode(h('div', {
          className: 'sms-st-pop',
          role: 'listbox',
          ref: panelRef,
          style: {
            left: `${anchor.left}px`,
            width: `${Math.min(Math.max(anchor.width, 240), 380)}px`,
            ...(anchor.top === undefined ? { bottom: `${anchor.bottom}px` } : { top: `${anchor.top}px` }),
          },
        },
          h('input', {
            className: 'sms-st-search',
            type: 'text',
            placeholder: t.searchModel,
            value: query,
            ref: searchRef,
            onChange: event => setQuery(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Escape') { event.stopPropagation(); close() }
              if (event.key !== 'Enter') return
              const row = entries.find(entry => entry.kind === 'row')
              if (row !== undefined) choose(row)
            },
          }),
          h('div', { className: 'sms-st-list' },
            h('button', {
              type: 'button',
              className: 'sms-st-row sms-st-row-inherit',
              'data-current': value === '' ? 'true' : undefined,
              onClick: () => choose(null),
            }, t.inherit),
            entries.length === 0
              ? h('div', { className: 'sms-st-empty' }, t.noMatch)
              : entries.map(entry => entry.kind === 'group'
                ? h('div', { className: 'sms-st-group', key: entry.key }, entry.label)
                : h('button', {
                  type: 'button',
                  className: 'sms-st-row',
                  key: entry.key,
                  'data-current': entry.value === value ? 'true' : undefined,
                  title: entry.label,
                  onClick: () => choose(entry),
                }, entry.label)),
          ),
        ))
        : null

      return h('div', { className: 'sms-st-field-wrap' },
        label ? h('span', { className: 'sms-st-field-label' }, label) : null,
        h('button', {
          type: 'button',
          className: `sms-st-field${value === '' ? ' sms-st-field-idle' : ''}`,
          disabled,
          ref: buttonRef,
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => { if (open) close(); else setOpen(true) },
        },
          h('span', { className: 'sms-st-field-text' }, display),
          h('span', { className: 'sms-st-caret', 'aria-hidden': 'true' }, '▾'),
        ),
        panel,
      )
    }

    /** Effort field: a short list, so the same picker without the search box. */
    function EffortField({ value, efforts, label, t, disabled, onPick }) {
      const [open, setOpen] = useState(false)
      const buttonRef = useRef(null)
      const panelRef = useRef(null)
      const anchor = useAnchoredPanel(open, buttonRef, 200)
      if (efforts.length === 0) return null
      const display = value === ''
        ? t.inherit
        : (efforts.find(level => level.id === value)?.name ?? value)

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (buttonRef.current?.contains?.(event.target) === true) return
          if (panelRef.current?.contains?.(event.target) === true) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const panel = open && anchor !== null
        ? portalNode(h('div', {
          className: 'sms-st-pop',
          role: 'listbox',
          ref: panelRef,
          style: {
            left: `${anchor.left}px`,
            width: `${Math.max(140, Math.min(anchor.width, 220))}px`,
            ...(anchor.top === undefined ? { bottom: `${anchor.bottom}px` } : { top: `${anchor.top}px` }),
          },
        },
          h('div', { className: 'sms-st-list' },
            h('button', {
              type: 'button',
              className: 'sms-st-row sms-st-row-inherit',
              'data-current': value === '' ? 'true' : undefined,
              onClick: () => { setOpen(false); onPick({ value: '' }) },
            }, t.inherit),
            efforts.map(level => h('button', {
              type: 'button',
              className: 'sms-st-row',
              key: level.id,
              'data-current': level.id === value ? 'true' : undefined,
              onClick: () => { setOpen(false); onPick({ value: level.id }) },
            }, level.name ?? level.id)),
          ),
        ))
        : null

      return h('div', { className: 'sms-st-field-wrap sms-st-field-narrow' },
        label ? h('span', { className: 'sms-st-field-label' }, label) : null,
        h('button', {
          type: 'button',
          className: `sms-st-field${value === '' ? ' sms-st-field-idle' : ''}`,
          disabled,
          ref: buttonRef,
          onClick: () => setOpen(prev => !prev),
        },
          h('span', { className: 'sms-st-field-text' }, display),
          h('span', { className: 'sms-st-caret', 'aria-hidden': 'true' }, '▾'),
        ),
        panel,
      )
    }

    function SettingsSection({ workspaces, sessions, remote, post, t, close }) {
      const ws = useFace(workspaces?.list, EMPTY_WS)
      const sl = useFace(sessions?.list, EMPTY_SESSIONS)
      const catalog = useModelCatalog(remote)
      const groups = useMemo(() => catalogGroups(catalog.groups), [catalog.groups])

      const [selected, setSelected] = useState(null)
      const [collapsed, setCollapsed] = useState({})
      const [filter, setFilter] = useState('')
      const [pick, setPick] = useState({ provider: '', model: '', effort: '', efforts: [] })
      const [childPick, setChildPick] = useState({})
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)
      /** Optimistic route overlay: a cold write cannot move the summary
       * projection until the session is reopened, so remember what we wrote. */
      const [localRoute, setLocalRoute] = useState({})

      const byId = sl.byId ?? {}

      // Reset the form whenever another conversation is picked.
      useEffect(() => {
        setPick({ provider: '', model: '', effort: '', efforts: [] })
        setChildPick({})
        setMsg(null)
      }, [selected])

      const needle = filter.trim().toLowerCase()
      const rowsOf = (workspace) => (workspace.sessionIds ?? [])
        .map(id => byId[id])
        .filter(row => row !== undefined)
        .filter(row => needle.length === 0
          || (row.displayTitle ?? row.title ?? row.id).toLowerCase().includes(needle))
      const visibleWorkspaces = (ws.items ?? [])
        .map(workspace => ({ workspace, rows: rowsOf(workspace) }))
        .filter(entry => entry.rows.length > 0 || needle.length === 0)
      const totalRows = visibleWorkspaces.reduce((sum, entry) => sum + entry.rows.length, 0)

      const selectedRow = selected === null ? undefined : byId[selected]
      const children = selected === null ? [] : descendantsOf(selected, byId)

      /** Current route for a row: our own last write wins over the projection. */
      const routeFor = (row) => {
        if (row === undefined || row === null) return null
        const local = localRoute[row.id]
        if (local !== undefined) return local
        return currentRouteOf(row)
      }
      const pickedEfforts = pick.efforts ?? []

      const flash = (kind, text) => { setMsg({ kind, text }); setBusy(false) }

      /** One write; returns a readable failure so the page can explain it. */
      const applyTo = async (sessionId, choice) => {
        if (!choice.provider || !choice.model) return { ok: false, message: t.noModelPicked }
        let result
        try {
          result = await post({
            sessionId,
            provider: choice.provider,
            model: choice.model,
            ...(choice.effort ? { reasoningEffort: choice.effort } : {}),
          })
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
        if (result === null || result === undefined) return { ok: false, message: t.failed }
        if (result.ok === false) {
          const code = result.error?.code ?? ''
          const message = result.error?.message ?? t.failed
          const mapped = code === 'session/writer-held' ? t.sessionInUse
            : code === 'seat/model-unavailable' ? t.modelUnavailable
              : code === 'seat/session-not-found' ? t.sessionMissing
                : code === 'seat/body-too-large' || code === 'seat/bad-request' ? t.badRequest
                  : message
          return { ok: false, message: `${mapped}${code ? `（${code}）` : ''}` }
        }
        setLocalRoute(prev => ({
          ...prev,
          [sessionId]: { provider: choice.provider, model: choice.model, effort: choice.effort ?? '' },
        }))
        return { ok: true, live: result.live === true }
      }

      const applyAll = async () => {
        if (selected === null) return
        if (!pick.provider || !pick.model) { setMsg({ kind: 'err', text: t.noModelPicked }); return }
        setBusy(true); setMsg(null)
        const result = await applyTo(selected, { provider: pick.provider, model: pick.model, effort: pick.effort })
        setBusy(false)
        setMsg({ kind: result.ok ? 'ok' : 'err', text: result.ok ? `${t.appliedHead}${result.live ? t.appliedLive : t.appliedCold}` : result.message })
      }
      const applyChild = async (child) => {
        const choice = childPick[child.id] ?? { provider: pick.provider, model: pick.model, effort: '' }
        if (!choice.provider || !choice.model) { setMsg({ kind: 'err', text: t.noModelPicked }); return }
        setBusy(true); setMsg(null)
        const result = await applyTo(child.id, choice)
        setBusy(false)
        setMsg({ kind: result.ok ? 'ok' : 'err', text: result.ok ? `${t.appliedHead}${result.live ? t.appliedLive : t.appliedCold}` : result.message })
      }

      const empty = catalog.status === 'loading'
        ? t.loading
        : catalog.status === 'error'
          ? t.catalogError
          : t.noMatch

      return h('div', { className: 'sms-set' },
        h('style', { key: 'sms-set-css' }, SETTINGS_CSS),
        h('div', { className: 'sms-set-bar' },
          h('input', {
            className: 'sms-set-input sms-set-filter',
            type: 'text',
            placeholder: t.filter,
            value: filter,
            onChange: event => setFilter(event.target.value),
          }),
          h('span', { className: 'sms-set-count' }, `${totalRows} ${t.sessionCount}`),
          h('span', { className: 'sms-set-spacer' }),
          typeof close === 'function'
            ? h('button', { className: 'sms-set-btn', type: 'button', onClick: close }, t.close)
            : null,
        ),
        h('div', { className: 'sms-set-body' },
          h('div', { className: 'sms-set-tree' },
            ws.state === 'loading' && visibleWorkspaces.length === 0
              ? h('div', { className: 'sms-set-empty' }, t.loading)
              : null,
            visibleWorkspaces.length === 0 && ws.state !== 'loading'
              ? h('div', { className: 'sms-set-empty' }, t.noWorkspace)
              : null,
            ...visibleWorkspaces.map(({ workspace, rows }) => {
              const open = collapsed[workspace.workspaceId] !== true
              return h('div', { className: 'sms-set-ws', key: workspace.workspaceId },
                h('button', {
                  className: 'sms-set-ws-head',
                  type: 'button',
                  onClick: () => setCollapsed(prev => ({ ...prev, [workspace.workspaceId]: open })),
                },
                  h('span', { className: `sms-set-caret${open ? ' sms-set-caret-open' : ''}` }, '▸'),
                  h('span', { className: 'sms-set-ws-title' }, workspace.title ?? workspace.path ?? workspace.workspaceId),
                  h('span', { className: 'sms-set-count' }, String(rows.length)),
                ),
                open
                  ? h('div', { className: 'sms-set-sessions' },
                    rows.length === 0
                      ? h('div', { className: 'sms-set-empty' }, t.noSessions)
                      : null,
                    ...rows.map(row => h('button', {
                      className: 'sms-set-session',
                      type: 'button',
                      key: row.id,
                      'data-selected': row.id === selected ? 'true' : undefined,
                      title: row.displayTitle ?? row.title ?? row.id,
                      onClick: () => setSelected(row.id),
                    },
                      row.displayTitle ?? row.title ?? t.untitled,
                      row.origin === 'subagent'
                        ? h('span', { className: 'sms-set-child-tag' }, t.child)
                        : null,
                    )),
                  )
                  : null,
              )
            }),
          ),
          h('div', { className: 'sms-set-detail' },
            selectedRow === undefined
              ? h('div', { className: 'sms-set-empty' }, t.pick)
              : h('div', { className: 'sms-set-panel' },
                h('div', { className: 'sms-set-head' },
                  h('span', { className: 'sms-set-title' }, selectedRow.displayTitle ?? selectedRow.title ?? t.untitled),
                  h('span', { className: 'sms-set-sub' }, `${children.length} ${t.allChildren}`),
                  h('span', { className: 'sms-set-current', title: routeLabel(routeFor(selectedRow), groups) ?? t.noCurrent },
                    `${t.currentModel}：${routeLabel(routeFor(selectedRow), groups) ?? t.noCurrent}`),
                ),
                h('div', { className: 'sms-set-block' },
                  h('div', { className: 'sms-set-block-head' },
                    h('span', { className: 'sms-set-block-title' }, t.oneClick),
                    h('span', { className: 'sms-set-desc' }, t.oneClickDesc),
                  ),
                  h('div', { className: 'sms-set-row' },
                    h(ModelField, {
                      key: 'all-model',
                      value: pick.provider && pick.model ? `${pick.provider}\u0000${pick.model}` : '',
                      groups,
                      label: t.chooseModel,
                      t,
                      disabled: busy,
                      onPick: (choice) => {
                        if (choice === null) { setPick({ provider: '', model: '', effort: '', efforts: [] }); return }
                        setPick({ provider: choice.provider, model: choice.model, effort: choice.defaultEffort ?? '', efforts: choice.efforts ?? [] })
                      },
                    }),
                    h(EffortField, {
                      key: 'all-effort',
                      value: pick.effort ?? '',
                      efforts: pickedEfforts,
                      label: t.chooseEffort,
                      t,
                      disabled: busy,
                      onPick: (choice) => setPick(prev => ({ ...prev, effort: choice.value ?? '' })),
                    }),
                    h('button', {
                      className: 'sms-set-btn sms-set-primary',
                      type: 'button',
                      disabled: busy,
                      onClick: applyAll,
                    }, busy ? t.applying : t.apply),
                  ),
                ),
                h('div', { className: 'sms-set-block sms-set-block-grow' },
                  h('div', { className: 'sms-set-block-head' },
                    h('span', { className: 'sms-set-block-title' }, t.single),
                    h('span', { className: 'sms-set-desc' }, t.singleDesc),
                  ),
                  children.length === 0
                    ? h('div', { className: 'sms-set-empty' }, t.appliedNothing)
                    : h('div', { className: 'sms-set-children' }, ...children.map(child => {
                      const chosen = childPick[child.id]
                      const choice = chosen ?? { provider: pick.provider, model: pick.model, effort: '', efforts: pickedEfforts }
                      return h('div', { className: 'sms-set-child-row', key: child.id },
                        h('span', { className: 'sms-set-child-name', title: child.displayTitle ?? child.title ?? child.id },
                          child.displayTitle ?? child.title ?? child.id,
                          h('span', { className: 'sms-set-child-route' },
                            routeLabel(routeFor(child), groups) ?? t.noCurrent)),
                        h(ModelField, {
                          value: choice.provider && choice.model ? `${choice.provider}\u0000${choice.model}` : '',
                          groups,
                          label: '',
                          t,
                          disabled: busy,
                          onPick: (picked) => setChildPick(prev => ({
                            ...prev,
                            [child.id]: picked === null
                              ? { provider: '', model: '', effort: '', efforts: [] }
                              : { provider: picked.provider, model: picked.model, effort: picked.defaultEffort ?? '', efforts: picked.efforts ?? [] },
                          })),
                        }),
                        h('button', {
                          className: 'sms-set-btn',
                          type: 'button',
                          disabled: busy,
                          onClick: () => applyChild(child),
                        }, t.apply),
                      )
                    })),
                ),
                msg !== null
                  ? h('div', { className: 'sms-set-msg', 'data-kind': msg.kind, role: 'status' }, msg.text)
                  : null,
                catalog.status === 'error'
                  ? h('div', { className: 'sms-set-msg', 'data-kind': 'err', role: 'status' }, `${t.catalogError}：${catalog.error ?? ''}`)
                  : null,
                groups.length === 0 && catalog.status !== 'error'
                  ? h('div', { className: 'sms-set-msg', 'data-kind': 'err', role: 'status' }, empty)
                  : null,
              ),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.session', 'modelDirectories', 'workspaces'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'subagent-model-seat',
          order: 20,
          label: () => T.nav,
          inject: () => ({
            workspaces: ctx.workspaces,
            sessions: ctx.sessions,
            remote: ctx.remote,
            post: postSelection,
            t: T,
          }),
          children: {},
        }, SettingsSection))

        ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
          name: 'conversation.input.model',
          id: 'subagent-model-seat',
          priority: SEAT_PRIORITY,
          children: {
            'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
            'conversation.input.model.options': { kind: 'list', scope: 'session' },
          },
          inject: (sessionId) => {
            const sessions = ctx.sessions
            const available = canSwitch(sessionId, sessions)
            const addressed = subagentAddress(sessions, sessionId) !== undefined

            let directory = null
            try { directory = ctx.modelDirectories?.directoryFor(sessionId) ?? null } catch { directory = null }

            const resolveText = text => (typeof text === 'string' ? text : '')
            const stub = { subscribe: () => () => {}, getSnapshot: () => EMPTY_SNAPSHOT }

            if (!available || directory === null) {
              return {
                available: false,
                directory: directory?.store ?? stub,
                load: () => {},
                resolveText,
                select: () => Promise.resolve(undefined),
              }
            }

            return {
              available: true,
              directory: directory.store,
              // Catalog is preloaded and kept fresh by ModelDirectoryResolver;
              // calling directory.load() would hit its subagent availability
              // guard, so this is intentionally a no-op.
              load: () => {},
              resolveText,
              select: (selection) => {
                const body = {
                  sessionId,
                  provider: selection.provider,
                  model: selection.model,
                  ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
                }
                // A subagent Session is refused by `session.selectModel` (its
                // owner gate), so those go through the plugin's Host route. An
                // ordinary Session keeps the stock RPC, which also handles
                // resume and the default-model persistence.
                return addressed
                  ? postSelection(body)
                  : ctx.remote.session.selectModel(body)
              },
            }
          },
        }, ModelSeat))
      },
    }
  },
})
