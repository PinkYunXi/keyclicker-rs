/* ui/js/views/click-form.js — 连点设置卡片（ui-tasks）
 *
 * 按键输入 + 「● 录入」（record.begin，监听 record.captured 填入）
 * 间隔 ms（最小 16，带行内校验与 toast 错误提示）
 * 内嵌窗口匹配控件 + 「添加到任务列表」
 *
 * 契约：KC.views.clickForm.mount(el, ctx) / .refresh(runtime)
 * 配置写入统一走 KC.state.update（视图不自己发 config.set）。
 */
(function () {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.views = KC.views || {};

  var MIN_INTERVAL = 16;
  var MAX_INTERVAL = 3600000;

  function h(tag, attrs, kids) {
    return KC.dom.h(tag, attrs, kids);
  }

  function toast(level, message) {
    try { KC.toast(level, message); } catch (e) {
      if (window.console) window.console.warn('[click-form] toast', level, message);
    }
  }

  function svg(inner) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" ' +
      'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      inner + '</svg>';
  }

  function errText(err) {
    if (err && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return '操作失败，请重试';
  }

  /* ── 事件：全模块只订阅一次，转发给当前挂载的表单 ─────────────────── */
  var active = null;
  var bound = false;

  function onHost(name, fn) {
    try { KC.host.on(name, fn); } catch (e) { /* 忽略不支持的事件名 */ }
  }

  function bindHostEvents() {
    if (bound) return;
    bound = true;
    onHost('record.captured', function (data) {
      if (active) active.onCaptured(data || {});
    });
    onHost('record.finished', function (data) {
      if (active) active.onFinished(data || {});
    });
  }

  /* ── 序列 / 配置辅助 ──────────────────────────────────────────────── */
  function pageIndexOf(ctx) {
    // config.selectedPage 是当前页的权威值；ctx.pageIndex 仅作兜底
    var cfg = KC.state && KC.state.config;
    if (cfg && Number.isInteger(cfg.selectedPage) && cfg.selectedPage >= 0) return cfg.selectedPage;
    if (ctx && Number.isInteger(ctx.pageIndex) && ctx.pageIndex >= 0) return ctx.pageIndex;
    return 0;
  }

  function ensurePage(cfg, pi) {
    if (!cfg || typeof cfg !== 'object') return null;
    if (!Array.isArray(cfg.pages) || !cfg.pages.length) cfg.pages = [{ name: '配置1', tasks: [] }];
    var page = cfg.pages[pi];
    if (!page) {
      page = cfg.pages[pi] = { name: '配置' + (pi + 1), tasks: [] };
    }
    if (!Array.isArray(page.tasks)) page.tasks = [];
    return page;
  }

  function commitConfig(mutator) {
    try {
      // 兼容两种核心实现：mutator 收到 config，或直接改 KC.state.config
      return KC.state.update(function (cfg) {
        mutator(cfg || (KC.state && KC.state.config));
      });
    } catch (e) {
      if (window.console) window.console.error('[click-form] 保存配置失败', e);
    }
    return undefined;
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────── */
  function mount(el, ctx) {
    if (!el) return;
    bindHostEvents();
    ctx = ctx || {};

    var recording = false;
    var adding = false;

    /* 按键 */
    var keyInput = h('input', { class: 'input kct-key-input' });
    keyInput.type = 'text';
    keyInput.placeholder = '如 a 或 ctrl+f9';
    keyInput.spellcheck = false;
    keyInput.setAttribute('aria-label', '要连点的按键');

    var recBtn = h('button', { class: 'btn kct-btn-rec', text: '录入' });
    recBtn.type = 'button';
    recBtn.title = '按下要连点的按键（支持组合键），无需手动输入';
    recBtn.setAttribute('aria-pressed', 'false');

    var keyHint = h('div', { class: 'field-hint kct-key-hint', text: '点「录入」后直接按下键盘按键（支持组合键），按 Esc 取消。' });
    var keyError = h('div', { class: 'field-error kct-key-error' });
    keyError.hidden = true;

    var keyField = h('div', { class: 'kct-field kct-field-key' }, [
      h('span', { class: 'field-label kct-field-label', text: '按键' }),
      h('div', { class: 'kct-key-row' }, [keyInput, recBtn]),
      keyHint,
      keyError
    ]);

    /* 间隔 */
    var intervalInput = h('input', { class: 'input kct-num kct-interval-input' });
    intervalInput.type = 'number';
    intervalInput.min = String(MIN_INTERVAL);
    intervalInput.max = String(MAX_INTERVAL);
    intervalInput.step = '1';
    intervalInput.value = '100';
    intervalInput.setAttribute('aria-label', '连点间隔（毫秒）');

    var intervalHint = h('span', { class: 'field-hint kct-interval-hint', text: '最小 16 ms（约 60 次/秒）' });
    var intervalError = h('div', { class: 'field-error kct-interval-error' });
    intervalError.hidden = true;

    var intervalField = h('div', { class: 'kct-field kct-field-interval' }, [
      h('span', { class: 'field-label kct-field-label', text: '间隔' }),
      h('div', { class: 'kct-inline' }, [intervalInput, h('span', { class: 'kct-unit', text: 'ms' }), intervalHint]),
      intervalError
    ]);

    /* 窗口匹配（可编辑下拉 + 模式 + 抓取） */
    var wm = KC.views.windowMatch.create({
      value: '',
      mode: 'contains',
      onInput: function () { clearAllErrors(); }
    });

    /* 添加 */
    var addBtn = h('button', { class: 'btn primary kct-add-btn kct-add-click', html: svg('<path d="M8 3.4v9.2"/><path d="M3.4 8h9.2"/>') + '<span>添加到任务列表</span>' });
    addBtn.type = 'button';
    addBtn.title = '把当前设置添加为本页的一个连点任务';

    var actions = h('div', { class: 'kct-actions' }, [addBtn]);

    var card = h('section', { class: 'card kct-card kct-click-card' }, [
      h('div', { class: 'card-header kct-card-head' }, [
        h('div', { class: 'kct-card-headtext' }, [
          h('h2', { class: 'kct-card-title', text: '连点' }),
          h('p', { class: 'kct-card-sub', text: '按固定间隔反复发送同一个按键' })
        ]),
        h('span', { class: 'kct-type-ico kct-type-ico-click', html: svg('<rect x="2.4" y="4.4" width="11.2" height="7.2" rx="1.6"/><path d="M5.4 8h5.2"/>') })
      ]),
      h('div', { class: 'card-body kct-card-body' }, [keyField, intervalField, wm, actions])
    ]);

    /* ── 错误提示 ── */
    function clearKeyError() {
      keyError.textContent = '';
      keyError.hidden = true;
      keyInput.removeAttribute('aria-invalid');
    }

    function clearIntervalError() {
      intervalError.textContent = '';
      intervalError.hidden = true;
      intervalInput.removeAttribute('aria-invalid');
    }

    function clearAllErrors() {
      clearKeyError();
      clearIntervalError();
    }

    function setKeyError(message) {
      keyError.textContent = message;
      keyError.hidden = false;
      keyInput.setAttribute('aria-invalid', 'true');
    }

    function setIntervalError(message) {
      intervalError.textContent = message;
      intervalError.hidden = false;
      intervalInput.setAttribute('aria-invalid', 'true');
    }

    function fail(err) {
      var message = errText(err);
      toast('error', message);
      return message;
    }

    /* ── 间隔校验 ── */
    function parseInterval() {
      var raw = String(intervalInput.value == null ? '' : intervalInput.value).trim();
      if (!raw) throw new Error('请填写连点间隔（毫秒）');
      if (!/^\d+$/.test(raw)) throw new Error('连点间隔必须是整数（毫秒）');
      var value = parseInt(raw, 10);
      if (value < MIN_INTERVAL) throw new Error('连点间隔最小为 ' + MIN_INTERVAL + ' 毫秒（约 60 次/秒）');
      if (value > MAX_INTERVAL) throw new Error('连点间隔不能超过 ' + MAX_INTERVAL + ' 毫秒（1 小时）');
      return value;
    }

    function checkIntervalLive() {
      var raw = String(intervalInput.value == null ? '' : intervalInput.value).trim();
      if (!raw) { clearIntervalError(); return; }
      try {
        parseInterval();
        clearIntervalError();
      } catch (err) {
        setIntervalError(errText(err));
      }
    }

    intervalInput.addEventListener('input', checkIntervalLive);
    intervalInput.addEventListener('blur', checkIntervalLive);

    /* ── 录入状态 ── */
    function setRecording(on) {
      recording = on;
      recBtn.textContent = on ? '停止录入' : '录入';
      recBtn.classList.toggle('kct-recording', on);
      recBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      keyInput.readOnly = on;
      keyHint.textContent = on
        ? '正在录入：请按下要连点的按键（支持组合键），按 Esc 取消'
        : '点「录入」后直接按下键盘按键（支持组合键），按 Esc 取消。';
    }

    async function stopRecord(cancel) {
      if (!recording) return;
      window.removeEventListener("keydown", onRecordKeydown, true);
      setRecording(false);
      if (cancel !== false) {
        try { await KC.host.call('record.cancel', {}); } catch (e) { /* 已结束则忽略 */ }
      }
    }


    function onRecordKeydown(e) {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      var combo = KC.keys.comboFromEvent(e);
      if (combo === "escape") { stopRecord(true); return; }
      if (KC.keys.onlyModifiers(combo)) return;
      window.removeEventListener("keydown", onRecordKeydown, true);
      keyInput.value = combo;
      setRecording(false);
      try { KC.host.call("record.cancel", {}); } catch (e2) { /* ignore */ }
      clearKeyError();
    }
    async function startRecord() {
      try {
        await KC.host.call('record.begin', { mode: 'single' });
        setRecording(true);
        window.addEventListener("keydown", onRecordKeydown, true);
      } catch (err) {
        setRecording(false);
        fail(err);
      }
    }

    recBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (recording) stopRecord(true);
      else startRecord();
    });

    keyInput.addEventListener('input', function () { clearKeyError(); });

    /* ── 校验 + 添加 ── */
    function normalizeCombo(data, fallback) {
      var normalized = data && typeof data.normalized === 'string' && data.normalized ? data.normalized : '';
      return normalized || String(fallback || '').trim().toLowerCase();
    }

    async function validateKeys(text) {
      var value = String(text == null ? '' : text).trim();
      if (!value) throw new Error('请先录入或输入要连点的按键');
      var data = await KC.host.call('keys.validate', { text: value });
      if (data && data.valid === false) {
        throw new Error((data && data.message) || ('无法识别的键名：' + value));
      }
      return normalizeCombo(data, value);
    }

    async function addTask() {
      if (adding) return;
      adding = true;
      addBtn.disabled = true;
      addBtn.classList.add('is-disabled');
      clearAllErrors();

      try {
        var keys = await validateKeys(keyInput.value);
        var interval = parseInterval();
        var wmValue = wm && wm.getValue ? wm.getValue() : '';
        var wmMode = wm && wm.getMode ? wm.getMode() : 'contains';
        var wmError = KC.views.windowMatch.validate({ value: wmValue, mode: wmMode });
        if (wmError) throw new Error(wmError);

        var spec = {
          type: 'click',
          keys: keys,
          interval: interval,
          windowMatch: wmValue,
          windowMode: wmMode
        };

        keyInput.value = keys;
        intervalInput.value = String(interval);

        var pi = pageIndexOf(ctx);
        await KC.host.call('task.add', { pageIndex: pi, task: spec });
        commitConfig(function (cfg) {
          var page = ensurePage(cfg, pi);
          if (page) page.tasks.push(spec);
        });

        if (KC.app && typeof KC.app.refreshRuntimes === 'function') {
          try { await KC.app.refreshRuntimes(); } catch (e) { /* ignore */ }
        }
        toast('info', '已添加连点任务：' + keys + '，间隔 ' + interval + ' ms');
        if (typeof ctx.onAdded === 'function') {
          try { ctx.onAdded(spec); } catch (e) { /* ignore */ }
        }
      } catch (err) {
        var message = fail(err);
        var text = String(err && err.message || '');
        if (/按键|键名|录入/.test(text)) setKeyError(message);
        else if (/间隔|毫秒/.test(text)) setIntervalError(message);
      } finally {
        adding = false;
        addBtn.disabled = false;
        addBtn.classList.remove('is-disabled');
      }
    }

    addBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      addTask();
    });

    /* ── 对外：接收记录事件 ── */
    var api = {
      onCaptured: function (data) {
        if (!recording) return;
        var combo = data && (data.combo || data.keys);
        if (typeof combo !== 'string' || !combo.trim()) {
          setRecording(false);
          return;
        }
        keyInput.value = combo.trim().toLowerCase();
        clearKeyError();
        setRecording(false);
        // 单键录入一次即结束，通知宿主停止钩子
        try { KC.host.call('record.cancel', {}); } catch (e) { /* ignore */ }
        toast('info', '已录入按键：' + keyInput.value);
      },
      onFinished: function () {
        if (!recording) return;
        setRecording(false);
      }
    };

    active = api;
    el.appendChild(card);

    // 卸载时清理（页切换会重新 mount）
    card.__kctUnmount = function () {
      if (recording) stopRecord(true);
      try { if (wm && wm.destroy) wm.destroy(); } catch (e) { /* ignore */ }
      if (active === api) active = null;
    };
  }

  function refresh() {
    /* 连点表单没有运行态需要刷新；统计在任务列表中展示。 */
  }

  KC.views.clickForm = { mount: mount, refresh: refresh, MIN_INTERVAL: MIN_INTERVAL, MAX_INTERVAL: MAX_INTERVAL };
})();
