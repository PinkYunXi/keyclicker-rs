/* =============================================================================
   KeyClicker Next —— titlebar.js（ui-foundation）
   自绘标题栏：品牌区 / 主题切换 / 窗口按钮（— □ ✕）/ 双击最大化。
   宿主命令走 KC.host（bridge.js 提供）；浏览器 mock 下自动降级为本地状态。
   ========================================================================== */
(function (window, document) {
  'use strict';

  var KC = window.KC || (window.KC = {});
  var dom = KC.dom;
  var h = dom.h;
  var icon = KC.icon;

  var state = { maximized: false };

  /* ---- 宿主调用（bridge.js 可能尚未加载，调用时再取）--------------------- */
  function hostCall(cmd, args) {
    var host = KC.host;
    if (!host || typeof host.call !== 'function') return null;
    try {
      return host.call(cmd, args || {});
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function requestWindowAction(action) {
    var pending = hostCall('app.window', { action: action });
    if (pending && typeof pending.catch === 'function') {
      pending.catch(function () {
        /* mock / 浏览器环境没有窗口控制权，静默忽略 */
      });
    }
    KC.bus.emit('window:action', { action: action });
  }

  /* ---- 窗口按钮 ---------------------------------------------------------- */
  function setMaximized(maximized) {
    state.maximized = !!maximized;
    var btn = document.getElementById('btn-max');
    if (!btn) return;
    dom.clear(btn);
    btn.appendChild(icon(state.maximized ? 'restore' : 'maximize'));
    var label = state.maximized ? '还原' : '最大化';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    document.documentElement.classList.toggle('is-maximized', state.maximized);
  }

  function toggleMaximize() {
    // 窗口已禁用最大化（尺寸上限固定），双击标题栏与最大化按钮均不生效
    return;
  }

  function decorateWindowButton(id, iconName, label, handler) {
    var btn = document.getElementById(id);
    if (!btn) return;
    dom.clear(btn);
    btn.appendChild(icon(iconName));
    btn.setAttribute('type', 'button');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', handler);
  }

  function initWindowButtons() {
    decorateWindowButton('btn-min', 'minimize', '最小化', function () {
      requestWindowAction('minimize');
    });
    decorateWindowButton('btn-max', 'maximize', '最大化', toggleMaximize);
    decorateWindowButton('btn-close', 'close', '关闭', function () {
      requestWindowAction('close');
    });
  }

  /* ---- 主题切换 ---------------------------------------------------------- */
  function updateThemeButton() {
    var btn = document.getElementById('btn-theme');
    if (!btn) return;
    var isDark = KC.theme.current() === 'dark';
    dom.clear(btn);
    btn.appendChild(icon(isDark ? 'sun' : 'moon'));
    var label = isDark ? '切换到浅色主题' : '切换到深色主题';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', isDark ? 'false' : 'true');
  }

  function toggleTheme() {
    var next = KC.theme.current() === 'dark' ? 'light' : 'dark';
    var pending = hostCall('app.setTheme', { theme: next });
    if (pending && typeof pending.then === 'function') {
      pending.then(function (data) {
        KC.theme.apply((data && data.theme) || next);
      }).catch(function () {
        KC.theme.apply(next);
      });
    } else {
      KC.theme.apply(next);
    }
  }

  function initThemeButton() {
    var actions = document.querySelector('#titlebar .tb-actions');
    if (!actions) return;
    var existing = document.getElementById('btn-theme');
    if (existing) return;
    var btn = h('button', {
      id: 'btn-theme',
      class: 'tb-btn',
      type: 'button',
      on: { click: toggleTheme }
    });
    actions.appendChild(btn);
    updateThemeButton();
  }

  function openSettings() {
    if (KC.views && KC.views.settings && typeof KC.views.settings.open === 'function') {
      try { KC.views.settings.open(); } catch (e) { /* ignore */ }
    }
  }

  function initSettingsButton() {
    var actions = document.querySelector('#titlebar .tb-actions');
    if (!actions || document.getElementById('btn-settings')) return;
    var btn = h('button', {
      id: 'btn-settings',
      class: 'tb-btn',
      type: 'button',
      title: '设置',
      'aria-label': '设置',
      on: { click: openSettings }
    });
    btn.appendChild(icon('settings'));
    actions.appendChild(btn);
  }

  /* ---- 初始化 ------------------------------------------------------------ */
  function init() {
    initWindowButtons();
    initThemeButton();
    initSettingsButton();
    setMaximized(document.documentElement.classList.contains('is-maximized'));

    /* 双击标题栏空白处切换最大化（WebView2 拖动区会吞事件，保留给 mock/宿主转发） */
    var bar = document.getElementById('titlebar');
    if (bar) {
      bar.addEventListener('dblclick', function (event) {
        if (event.target.closest('button')) return;
        toggleMaximize();
      });
    }

    KC.bus.on('theme:changed', updateThemeButton);
    KC.bus.on('window:state', function (payload) {
      if (payload && typeof payload.maximized === 'boolean') {
        setMaximized(payload.maximized);
      }
    });
  }

  KC.titlebar = {
    init: init,
    toggleMaximize: toggleMaximize,
    setMaximized: setMaximized,
    isMaximized: function () { return state.maximized; },
    updateTheme: updateThemeButton
  };

  KC.ready(init);
})(window, document);


/* KC_DRAG_PATCH: WebView2 不实现 CSS app-region，拖拽交给宿主轮询实现 */
(function () {
  function host() { return (window.KC && window.KC.host) ? window.KC.host : null; }
  function interactive(t) {
    return !!(t && t.closest && t.closest('button, input, select, textarea, a, [data-no-drag]'));
  }
  function bind() {
    var tb = document.getElementById('titlebar');
    if (!tb || tb.dataset.dragBound === '1') return;
    tb.dataset.dragBound = '1';
    tb.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || interactive(e.target)) return;
      var h = host();
      if (!h) return;
      try { h.call('app.drag', {}).catch(function () {}); } catch (_) {}
    });
    tb.addEventListener('dblclick', function (e) {
      if (interactive(e.target)) return;
      var h = host();
      if (!h) return;
      try { h.call('app.window', { action: 'maximize' }).catch(function () {}); } catch (_) {}
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
