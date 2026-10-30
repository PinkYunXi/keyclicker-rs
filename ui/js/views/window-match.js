/* ui/js/views/window-match.js — 前台窗口匹配控件（ui-tasks）
 *
 * 组成：可编辑下拉（候选来自 window.list）+ 模式三选（包含/精确/正则）+ 抓取当前窗口（3 秒倒数）。
 *
 * 用法（两种表单共用，不自己发 config.set）：
 *   var wm = KC.views.windowMatch.create({
 *     value: '记事本',            // 初始关键词，可省略
 *     mode: 'contains',          // contains | exact | regex
 *     onInput: function (value, mode) {}
 *   });
 *   card.appendChild(wm);
 *   wm.getValue(); wm.getMode(); wm.setValue('x'); wm.setMode('exact'); wm.destroy();
 *
 * 约定：只用 KC.dom.h / KC.host.call / KC.host.on / KC.toast；自定义类全部 .kct- 前缀。
 */
(function () {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.views = KC.views || {};

  var MODE_LABELS = { contains: '包含', exact: '精确', regex: '正则' };
  var GRAB_SECONDS = 3;

  function h(tag, attrs, kids) {
    return KC.dom.h(tag, attrs, kids);
  }

  function toast(level, message) {
    try { KC.toast(level, message); } catch (e) {
      if (window.console) window.console.warn('[window-match] toast', level, message);
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

  /* ── 抓取事件：全模块只订阅一次，分发给正在等待的实例 ───────────────── */
  var grabWaiters = [];
  var bound = false;

  function onHost(name, fn) {
    try { KC.host.on(name, fn); } catch (e) { /* 事件名不支持时忽略 */ }
  }

  function bindHostEvents() {
    if (bound) return;
    bound = true;

    onHost('window.grabTick', function (data) {
      var left = data && (data.secondsLeft != null ? data.secondsLeft : data.left);
      left = Math.max(0, Number(left) || 0);
      grabWaiters.slice().forEach(function (w) { w.onTick(left); });
    });

    onHost('window.grabResult', function (data) {
      var waiters = grabWaiters.slice();
      grabWaiters.length = 0;
      waiters.forEach(function (w) { w.onResult(data || {}); });
    });
  }

  function removeWaiter(waiter) {
    var i = grabWaiters.indexOf(waiter);
    if (i >= 0) grabWaiters.splice(i, 1);
  }

  /* ── 控件实例 ──────────────────────────────────────────────────────── */
  function create(opts) {
    opts = opts || {};
    bindHostEvents();

    var value = opts.value == null ? '' : String(opts.value);
    var mode = MODE_LABELS[opts.mode] ? opts.mode : 'contains';
    var destroyed = false;
    var grabbing = false;
    var grabWaiter = null;
    var grabSafety = 0;
    var popOpen = false;
    var popSeq = 0;
    var outsideHandler = null;

    /* 关键词输入（可编辑 = 输入框 + 下拉候选） */
    var input = h('input', { class: 'input kct-wm-input' });
    input.type = 'text';
    input.value = value;
    input.placeholder = '留空 = 不限制；点开右侧箭头选窗口，也可直接输入关键词';
    input.spellcheck = false;
    input.setAttribute('aria-label', '窗口标题匹配关键词');

    var caret = h('button', {
      class: 'btn icon kct-wm-caret',
      html: svg('<path d="M4 6.2 8 10.2 12 6.2"/>')
    });
    caret.type = 'button';
    caret.title = '列出当前可见窗口，点选填入';
    caret.setAttribute('aria-label', '列出当前可见窗口');

    var pop = h('div', { class: 'kct-wm-pop' });
    pop.hidden = true;
    pop.setAttribute('role', 'listbox');

    var field = h('div', { class: 'kct-wm-field' }, [input, caret, pop]);

    /* 匹配模式三选 */
    var select = h('select', { class: 'select kct-wm-mode' });
    select.title = '窗口标题的匹配方式：包含 / 精确 / 正则';
    select.setAttribute('aria-label', '窗口标题匹配方式');
    ['contains', 'exact', 'regex'].forEach(function (key) {
      var option = h('option', { text: MODE_LABELS[key] });
      option.value = key;
      select.appendChild(option);
    });
    select.value = mode;

    /* 抓取当前窗口 */
    var grabBtn = h('button', { class: 'btn ghost kct-wm-grab', text: '抓取当前窗口' });
    grabBtn.type = 'button';
    grabBtn.title = '点击后有 ' + GRAB_SECONDS + ' 秒倒数，请在倒数期间切换到目标窗口';

    var hint = h('div', { class: 'field-hint kct-wm-hint' });

    var row = h('div', { class: 'kct-wm-row' }, [field, select, grabBtn]);

    var head = h('div', { class: 'kct-wm-head' }, [
      h('span', { class: 'field-label kct-wm-label', text: '仅在前台窗口匹配时生效' }),
      h('span', { class: 'field-hint kct-wm-tip', text: '留空 = 不限制' })
    ]);

    var root = h('div', { class: 'kct-wm' }, [head, row, hint]);

    /* ── 内部工具 ── */
    function emit() {
      if (destroyed || typeof opts.onInput !== 'function') return;
      try {
        opts.onInput(String(input.value || '').trim(), mode);
      } catch (e) {
        if (window.console) window.console.error('[window-match] onInput 抛错', e);
      }
    }

    function updateHint() {
      var base = '留空表示不限制。';
      var desc = mode === 'exact'
        ? '精确：窗口标题与关键词完全一致才触发。'
        : mode === 'regex'
          ? '正则：按正则表达式匹配标题（忽略大小写），非法表达式会被拒绝。'
          : '包含：窗口标题包含关键词即触发。';
      hint.textContent = desc + base + '任务运行中窗口不匹配时不会发送按键，任务行会给出提示。';
      hint.dataset.mode = mode;
    }

    function closePop() {
      if (!popOpen) return;
      popOpen = false;
      pop.hidden = true;
      caret.setAttribute('aria-expanded', 'false');
      root.classList.remove('kct-wm-pop-open');
      if (outsideHandler) {
        document.removeEventListener('mousedown', outsideHandler, true);
        outsideHandler = null;
      }
    }

    function renderPop(list) {
      pop.textContent = '';
      if (!list.length) {
        pop.appendChild(h('div', { class: 'kct-wm-item kct-wm-item-empty', text: '未找到可见窗口，可直接手动输入关键词' }));
        return;
      }
      var current = String(input.value || '').trim();
      list.forEach(function (title) {
        var item = h('button', { class: 'kct-wm-item', text: title });
        item.type = 'button';
        item.title = title;
        item.setAttribute('role', 'option');
        if (title === current) {
          item.classList.add('kct-wm-item-active');
          item.setAttribute('aria-selected', 'true');
        }
        item.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          input.value = title;
          closePop();
          emit();
          input.focus();
        });
        pop.appendChild(item);
      });
    }

    function normalizeTitles(data) {
      if (!data) return [];
      if (Array.isArray(data)) return data.filter(function (t) { return typeof t === 'string' && t; });
      var list = data.titles || data.windows || data.list || [];
      if (!Array.isArray(list)) return [];
      return list.map(function (t) {
        return typeof t === 'string' ? t : (t && (t.title || t.name)) || '';
      }).filter(Boolean);
    }

    async function openPop() {
      if (popOpen || destroyed) return;
      popOpen = true;
      pop.hidden = false;
      root.classList.add('kct-wm-pop-open');
      caret.setAttribute('aria-expanded', 'true');
      var seq = ++popSeq;
      pop.textContent = '';
      pop.appendChild(h('div', { class: 'kct-wm-item kct-wm-item-empty', text: '正在读取窗口列表…' }));

      // 点击面板外收起（延迟到当前事件循环之后，避免本次点击立刻关掉）
      setTimeout(function () {
        if (destroyed || !popOpen) return;
        outsideHandler = function (ev) {
          if (root.contains(ev.target)) return;
          closePop();
        };
        document.addEventListener('mousedown', outsideHandler, true);
      }, 0);

      try {
        var data = await KC.host.call('window.list', {});
        if (destroyed || !popOpen || seq !== popSeq) return;
        renderPop(normalizeTitles(data));
      } catch (err) {
        if (destroyed || seq !== popSeq) return;
        pop.textContent = '';
        pop.appendChild(h('div', { class: 'kct-wm-item kct-wm-item-empty', text: '读取窗口列表失败' }));
        toast('error', errText(err));
      }
    }

    /* ── 抓取当前窗口 ── */
    function setGrabBusy(busy, label) {
      grabbing = busy;
      grabBtn.disabled = busy;
      grabBtn.classList.toggle('is-disabled', busy);
      grabBtn.textContent = busy ? (label || (GRAB_SECONDS + ' 秒…')) : '抓取当前窗口';
      grabBtn.classList.toggle('kct-wm-grabbing', busy);
    }

    function finishGrab() {
      if (grabSafety) { clearTimeout(grabSafety); grabSafety = 0; }
      if (grabWaiter) { removeWaiter(grabWaiter); grabWaiter = null; }
      if (!destroyed) setGrabBusy(false);
    }

    function applyGrabbedTitle(title) {
      var text = String(title || '').trim();
      if (!text) return false;
      input.value = text;
      emit();
      return true;
    }

    async function startGrab() {
      if (grabbing || destroyed) return;
      closePop();
      setGrabBusy(true, GRAB_SECONDS + ' 秒…');

      grabWaiter = {
        onTick: function (left) {
          if (destroyed) return;
          if (left > 0) setGrabBusy(true, left + ' 秒…');
        },
        onResult: function (data) {
          if (destroyed) return;
          finishGrab();
          if (data && data.ok && data.title) {
            applyGrabbedTitle(data.title);
            var suffix = data.process ? '（' + data.process + '）' : '';
            toast('info', '已抓取窗口标题：' + data.title + suffix);
            return;
          }
          var reason = data && data.reason;
          if (reason === 'self') {
            toast('warn', '抓到的是本程序自己的窗口。请先切换到目标窗口再点「抓取当前窗口」，也可以直接点右侧箭头从窗口列表里选。');
          } else if (reason === 'none' || reason === 'no_foreground') {
            toast('warn', '未能读取当前前台窗口标题，请确认已切换到目标窗口。');
          } else {
            toast('error', (data && data.message) || '抓取窗口失败，请重试');
          }
        }
      };
      grabWaiters.push(grabWaiter);

      try {
        await KC.host.call('window.grabStart', { seconds: GRAB_SECONDS });
      } catch (err) {
        if (destroyed) return;
        finishGrab();
        toast('error', errText(err));
        return;
      }

      // 兜底：宿主事件缺失时不至于永远卡在倒数状态
      grabSafety = setTimeout(function () {
        if (destroyed || !grabbing) return;
        finishGrab();
        toast('warn', '没有收到抓取结果，请重试或手动输入关键词。');
      }, (GRAB_SECONDS + 5) * 1000);
    }

    /* ── 绑定 ── */
    input.addEventListener('input', function () {
      emit();
    });

    caret.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (popOpen) closePop();
      else openPop();
    });

    select.addEventListener('change', function () {
      mode = MODE_LABELS[select.value] ? select.value : 'contains';
      updateHint();
      emit();
    });

    grabBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      startGrab();
    });

    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && popOpen) {
        ev.stopPropagation();
        closePop();
        input.focus();
      }
    });

    updateHint();
    caret.setAttribute('aria-expanded', 'false');

    /* 实例对外接口 */
    root.getValue = function () { return String(input.value || '').trim(); };
    root.getMode = function () { return mode; };
    root.setValue = function (next) {
      input.value = next == null ? '' : String(next);
      emit();
    };
    root.setMode = function (next) {
      mode = MODE_LABELS[next] ? next : 'contains';
      select.value = mode;
      updateHint();
      emit();
    };
    root.focusInput = function () { try { input.focus(); } catch (e) { /* ignore */ } };
    root.destroy = function () {
      if (destroyed) return;
      destroyed = true;
      closePop();
      finishGrab();
      if (root.parentNode) root.parentNode.removeChild(root);
    };

    return root;
  }

  /* 返回 null 表示合法；否则返回中文错误信息（表单在添加前调用） */
  function validate(state) {
    var pattern = state && state.value != null ? String(state.value).trim() : '';
    var mode = (state && state.mode) || 'contains';
    if (!pattern) return null;
    if (mode === 'regex') {
      try {
        new RegExp(pattern, 'i');
      } catch (e) {
        return '窗口标题的正则表达式无法编译，请检查后重试：' + (e && e.message ? e.message : '语法错误');
      }
    }
    return null;
  }

  KC.views.windowMatch = {
    MODE_LABELS: MODE_LABELS,
    GRAB_SECONDS: GRAB_SECONDS,
    create: create,
    validate: validate
  };
})();
