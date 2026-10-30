/* ui/js/views/timer-form.js — 定时序列设置卡片（ui-tasks）
 *
 * 序列摘要 + 「设置序列」（打开 sequenceEditor）+ 分/秒倒计时 + 步骤间隔（最小 16）
 * + 窗口匹配 + 「添加到任务列表」。
 *
 * 契约：KC.views.timerForm.mount(el, ctx) / .refresh(runtime)
 */
(function () {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.views = KC.views || {};

  var MIN_INTERVAL = 16;
  var MAX_GAP = 60000;

  function h(tag, attrs, kids) {
    return KC.dom.h(tag, attrs, kids);
  }

  function toast(level, message) {
    try { KC.toast(level, message); } catch (e) {
      if (window.console) window.console.warn('[timer-form] toast', level, message);
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

  function normalizeSeq(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (item) { return String(item == null ? '' : item).trim(); }).filter(Boolean);
  }

  function pad2(n) {
    n = Math.max(0, Number(n) || 0);
    return n < 10 ? '0' + n : String(n);
  }

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
    if (!page) page = cfg.pages[pi] = { name: '配置' + (pi + 1), tasks: [] };
    if (!Array.isArray(page.tasks)) page.tasks = [];
    return page;
  }

  function commitConfig(mutator) {
    try {
      return KC.state.update(function (cfg) {
        mutator(cfg || (KC.state && KC.state.config));
      });
    } catch (e) {
      if (window.console) window.console.error('[timer-form] 保存配置失败', e);
    }
    return undefined;
  }

  function mount(el, ctx) {
    if (!el) return;
    ctx = ctx || {};

    var seq = [];
    var adding = false;

    /* 序列摘要 */
    var seqSummary = h('div', { class: 'kct-seq-summary' });
    var seqCount = h('span', { class: 'kct-seq-count' });

    var seqBtn = h('button', { class: 'btn kct-seq-btn', html: svg('<path d="M3.4 8h9.2"/><path d="M8 3.4v9.2"/>') + '<span>设置序列</span>' });
    seqBtn.type = 'button';
    seqBtn.title = '打开序列编辑器，可逐个录入或手动输入按键序列';

    var seqError = h('div', { class: 'field-error kct-seq-error' });
    seqError.hidden = true;

    var seqField = h('div', { class: 'kct-field kct-field-seq' }, [
      h('div', { class: 'kct-field-head' }, [
        h('span', { class: 'field-label kct-field-label', text: '按键序列' }),
        seqCount
      ]),
      h('div', { class: 'kct-seq-line' }, [seqSummary, seqBtn]),
      h('div', { class: 'field-hint', text: '倒计时结束后按顺序发送；每一步都支持组合键。' }),
      seqError
    ]);

    /* 倒计时 */
    var minInput = h('input', { class: 'input kct-num kct-min-input' });
    minInput.type = 'number';
    minInput.min = '0';
    minInput.max = '999';
    minInput.step = '1';
    minInput.value = '0';
    minInput.setAttribute('aria-label', '倒计时分钟');

    var secInput = h('input', { class: 'input kct-num kct-sec-input' });
    secInput.type = 'number';
    secInput.min = '0';
    secInput.max = '59';
    secInput.step = '1';
    secInput.value = '10';
    secInput.setAttribute('aria-label', '倒计时秒');

    var timeError = h('div', { class: 'field-error kct-time-error' });
    timeError.hidden = true;

    var timeField = h('div', { class: 'kct-field kct-field-time' }, [
      h('span', { class: 'field-label kct-field-label', text: '倒计时' }),
      h('div', { class: 'kct-inline' }, [
        minInput,
        h('span', { class: 'kct-unit', text: '分' }),
        secInput,
        h('span', { class: 'kct-unit', text: '秒' }),
        h('span', { class: 'field-hint kct-time-hint', text: '合计至少 1 秒' })
      ]),
      timeError
    ]);

    /* 步骤间隔 */
    var gapInput = h('input', { class: 'input kct-num kct-gap-input' });
    gapInput.type = 'number';
    gapInput.min = String(MIN_INTERVAL);
    gapInput.max = String(MAX_GAP);
    gapInput.step = '1';
    gapInput.value = '200';
    gapInput.setAttribute('aria-label', '序列步骤之间的间隔（毫秒）');

    var gapError = h('div', { class: 'field-error kct-gap-error' });
    gapError.hidden = true;

    var gapField = h('div', { class: 'kct-field kct-field-gap' }, [
      h('span', { class: 'field-label kct-field-label', text: '步骤间隔' }),
      h('div', { class: 'kct-inline' }, [
        gapInput,
        h('span', { class: 'kct-unit', text: 'ms' }),
        h('span', { class: 'field-hint', text: '最小 ' + MIN_INTERVAL + ' ms，序列相邻按键之间的停顿' })
      ]),
      gapError
    ]);

    /* 窗口匹配 */
    var wm = KC.views.windowMatch.create({
      value: '',
      mode: 'contains',
      onInput: function () { clearAllErrors(); }
    });

    /* 添加 */
    var addBtn = h('button', { class: 'btn primary kct-add-btn kct-add-timer', html: svg('<path d="M8 3.4v9.2"/><path d="M3.4 8h9.2"/>') + '<span>添加到任务列表</span>' });
    addBtn.type = 'button';
    addBtn.title = '把当前设置添加为本页的一个定时序列任务';

    var card = h('section', { class: 'card kct-card kct-timer-card' }, [
      h('div', { class: 'card-header kct-card-head' }, [
        h('div', { class: 'kct-card-headtext' }, [
          h('h2', { class: 'kct-card-title', text: '定时序列' }),
          h('p', { class: 'kct-card-sub', text: '倒计时结束后依次发送序列中的按键' })
        ]),
        h('span', { class: 'kct-type-ico kct-type-ico-timer', html: svg('<circle cx="8" cy="8.6" r="5.1"/><path d="M8 5.8v2.9l1.9 1.1"/><path d="M6.2 1.9h3.6"/>') })
      ]),
      h('div', { class: 'card-body kct-card-body' }, [seqField, timeField, gapField, wm, h('div', { class: 'kct-actions' }, [addBtn])])
    ]);

    /* ── 错误提示 ── */
    function clearError(node, input) {
      node.textContent = '';
      node.hidden = true;
      if (input) input.removeAttribute('aria-invalid');
    }

    function setError(node, input, message) {
      node.textContent = message;
      node.hidden = false;
      if (input) input.setAttribute('aria-invalid', 'true');
    }

    function clearAllErrors() {
      clearError(seqError);
      clearError(timeError, minInput);
      clearError(timeError, secInput);
      clearError(gapError, gapInput);
    }

    function fail(err) {
      var message = errText(err);
      toast('error', message);
      return message;
    }

    /* ── 序列渲染 ── */
    function renderSeq() {
      seqSummary.textContent = '';
      if (!seq.length) {
        seqSummary.appendChild(h('span', { class: 'kct-seq-empty', text: '（未设置）点右侧「设置序列」录入按键' }));
        seqCount.textContent = '';
        seqBtn.classList.remove('kct-seq-btn-filled');
        return;
      }
      seq.forEach(function (combo, index) {
        if (index > 0) seqSummary.appendChild(h('span', { class: 'kct-seq-arrow', text: '→' }));
        seqSummary.appendChild(h('span', { class: 'kct-chip kct-chip-static', text: combo }));
      });
      seqCount.textContent = '共 ' + seq.length + ' 步';
      seqBtn.classList.add('kct-seq-btn-filled');
    }

    function openEditor() {
      if (!KC.views.sequenceEditor || typeof KC.views.sequenceEditor.open !== 'function') {
        toast('error', '序列编辑器未加载，请刷新界面重试');
        return;
      }
      seqBtn.disabled = true;
      seqBtn.classList.add('is-disabled');
      KC.views.sequenceEditor.open({
        seq: seq.slice(),
        onSave: function (next) {
          seq = normalizeSeq(next);
          clearError(seqError);
          renderSeq();
        }
      }).then(function (result) {
        seqBtn.disabled = false;
        seqBtn.classList.remove('is-disabled');
        if (result) {
          seq = normalizeSeq(result);
          clearError(seqError);
          renderSeq();
        }
      }).catch(function (err) {
        seqBtn.disabled = false;
        seqBtn.classList.remove('is-disabled');
        fail(err);
      });
    }

    seqBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      openEditor();
    });

    /* ── 数值解析 ── */
    function parseIntInRange(input, label, min, max) {
      var raw = String(input.value == null ? '' : input.value).trim();
      if (!raw) throw new Error('请填写' + label);
      if (!/^\d+$/.test(raw)) throw new Error(label + '必须是整数');
      var value = parseInt(raw, 10);
      if (value < min) throw new Error(label + '不能小于 ' + min);
      if (value > max) throw new Error(label + '不能大于 ' + max);
      return value;
    }

    function parseTime() {
      var minutes = parseIntInRange(minInput, '倒计时分钟数', 0, 999);
      var seconds = parseIntInRange(secInput, '倒计时秒数', 0, 59);
      if (minutes * 60 + seconds < 1) throw new Error('倒计时不能为 0，合计至少 1 秒');
      return { minutes: minutes, seconds: seconds };
    }

    minInput.addEventListener('input', function () { clearError(timeError); });
    secInput.addEventListener('input', function () { clearError(timeError); });
    gapInput.addEventListener('input', function () { clearError(gapError); });

    /* ── 添加 ── */
    async function addTask() {
      if (adding) return;
      adding = true;
      addBtn.disabled = true;
      addBtn.classList.add('is-disabled');
      clearAllErrors();

      try {
        if (!seq.length) throw new Error('请先设置按键序列');
        var time = parseTime();
        var gap = parseIntInRange(gapInput, '步骤间隔', MIN_INTERVAL, MAX_GAP);
        var wmValue = wm && wm.getValue ? wm.getValue() : '';
        var wmMode = wm && wm.getMode ? wm.getMode() : 'contains';
        var wmError = KC.views.windowMatch.validate({ value: wmValue, mode: wmMode });
        if (wmError) throw new Error(wmError);

        var spec = {
          type: 'timer',
          seq: seq.slice(),
          minutes: time.minutes,
          seconds: time.seconds,
          gap: gap,
          windowMatch: wmValue,
          windowMode: wmMode
        };

        minInput.value = String(time.minutes);
        secInput.value = String(time.seconds);
        gapInput.value = String(gap);

        var pi = pageIndexOf(ctx);
        await KC.host.call('task.add', { pageIndex: pi, task: spec });
        commitConfig(function (cfg) {
          var page = ensurePage(cfg, pi);
          if (page) page.tasks.push(spec);
        });

        var total = time.minutes * 60 + time.seconds;
        if (KC.app && typeof KC.app.refreshRuntimes === 'function') {
          try { await KC.app.refreshRuntimes(); } catch (e) { /* ignore */ }
        }
        toast('info', '已添加定时任务：' + seq.join(' → ') + '，倒计时 ' + pad2(time.minutes) + ':' + pad2(time.seconds) + '（' + total + ' 秒）');
        if (typeof ctx.onAdded === 'function') {
          try { ctx.onAdded(spec); } catch (e) { /* ignore */ }
        }
      } catch (err) {
        var message = fail(err);
        var text = String(err && err.message || '');
        if (/序列/.test(text)) setError(seqError, null, message);
        else if (/倒计时|分钟|秒数|时间/.test(text)) setError(timeError, minInput, message);
        else if (/间隔/.test(text)) setError(gapError, gapInput, message);
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

    /* 手动输入回车也能加 */
    card.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.target.classList.contains('kct-seq-manual')) {
        // 输入框里回车 = 添加，避免用户误以为需要点按钮
        if (ev.target === minInput || ev.target === secInput || ev.target === gapInput) {
          ev.preventDefault();
          addTask();
        }
      }
    });

    el.appendChild(card);
    renderSeq();

    card.__kctUnmount = function () {
      try { if (wm && wm.destroy) wm.destroy(); } catch (e) { /* ignore */ }
    };
  }

  function refresh() {
    /* 定时表单没有运行态需要刷新；剩余时间在任务列表中展示。 */
  }

  KC.views.timerForm = { mount: mount, refresh: refresh, MIN_INTERVAL: MIN_INTERVAL };
})();
