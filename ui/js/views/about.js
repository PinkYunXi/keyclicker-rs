/* ui/js/views/about.js — 关于 / 快捷键弹层（ui-tasks）
 *
 * 用法：KC.views.about.open()
 * 同时兼容宿主推送 app.openAbout 事件 / KC.bus.emit('about:open')（若有）。
 */
(function () {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.views = KC.views || {};

  var APP_NAME = 'KeyClicker';
  var FALLBACK_VERSION = '1.0.0';
  var TICK = String.fromCharCode(96); // 反引号：Ctrl + 反向单引号
  var DEFAULT_HOTKEYS = { toggle: 'ctrl+' + TICK, panic: 'f6' };

  var openSession = null;
  var bound = false;

  function h(tag, attrs, kids) {
    return KC.dom.h(tag, attrs, kids);
  }

  function toast(level, message) {
    try { KC.toast(level, message); } catch (e) {
      if (window.console) window.console.warn('[about] toast', level, message);
    }
  }

  function svg(inner) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" ' +
      'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      inner + '</svg>';
  }

  var ICON_APP = '<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false" ' +
    'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="5" y="9" width="22" height="14" rx="3"/><path d="M10 15.5h7"/>' +
    '<circle cx="21.5" cy="15.5" r="1.6" fill="currentColor" stroke="none"/></svg>';

  var ICON_FOLDER = '<path d="M2.8 4.6h3.6l1.2 1.5h5.6v5.9H2.8z"/>';

  function errText(err) {
    if (err && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return '操作失败，请重试';
  }

  function overlayRoot() {
    return document.getElementById('overlay-root') || document.body;
  }

  function splitCombo(combo) {
    return String(combo == null ? '' : combo).split('+').map(function (part) {
      return part.trim();
    }).filter(Boolean).map(function (part) {
      var lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
      if (lower === 'shift') return 'Shift';
      if (lower === 'alt') return 'Alt';
      if (lower === 'windows' || lower === 'win' || lower === 'cmd' || lower === 'super') return 'Win';
      return part;
    });
  }

  function comboNode(combo) {
    var wrap = h('span', { class: 'kct-keys' });
    var parts = splitCombo(combo);
    if (!parts.length) {
      wrap.appendChild(h('span', { class: 'kbd', text: '未设置' }));
      return wrap;
    }
    parts.forEach(function (part, index) {
      if (index > 0) wrap.appendChild(h('span', { class: 'kct-keys-plus', text: '+' }));
      wrap.appendChild(h('span', { class: 'kbd', text: part }));
    });
    return wrap;
  }

  function appInfo() {
    var info = {};
    try {
      if (KC.app && typeof KC.app === 'object') {
        if (KC.app.info && typeof KC.app.info === 'object') info = KC.app.info;
        else if (KC.app.env && typeof KC.app.env === 'object') info = KC.app.env;
        else if (typeof KC.app.version === 'string') info = { version: KC.app.version };
      }
    } catch (e) { /* ignore */ }
    return info || {};
  }

  async function fetchHotkeys() {
    try {
      var data = await KC.host.call('hotkey.get', {});
      if (data && (data.toggle || data.panic)) {
        return {
          toggle: data.toggle || DEFAULT_HOTKEYS.toggle,
          panic: data.panic || DEFAULT_HOTKEYS.panic
        };
      }
    } catch (e) { /* 宿主不支持时退回默认值 */ }
    var cfg = KC.state && KC.state.config;
    var cfgHotkeys = cfg && cfg.hotkeys;
    return {
      toggle: (cfgHotkeys && cfgHotkeys.toggle) || DEFAULT_HOTKEYS.toggle,
      panic: (cfgHotkeys && cfgHotkeys.panic) || DEFAULT_HOTKEYS.panic
    };
  }

  function bindExternalTriggers() {
    if (bound) return;
    bound = true;
    try { KC.host.on('app.openAbout', function () { open(); }); } catch (e) { /* ignore */ }
    try {
      if (KC.bus && typeof KC.bus.on === 'function') KC.bus.on('about:open', function () { open(); });
    } catch (e) { /* ignore */ }
  }

  /* ── 打开弹层 ── */
  function open() {
    bindExternalTriggers();
    if (openSession) {
      try { openSession.focus(); } catch (e) { /* ignore */ }
      return openSession.promise;
    }

    var closed = false;
    var resolveFn = null;
    var promise = new Promise(function (resolve) { resolveFn = resolve; });

    var info = appInfo();
    var version = info.version || FALLBACK_VERSION;
    var configPath = typeof info.configPath === 'string' ? info.configPath : '';
    var portable = info.portable === true;
    var elevated = info.elevated === true;

    /* 头部 */
    var closeBtn = h('button', {
      class: 'btn icon kct-dialog-close',
      html: svg('<path d="M4.2 4.2 11.8 11.8"/><path d="M11.8 4.2 4.2 11.8"/>')
    });
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.setAttribute('aria-label', '关闭');

    var header = h('div', { class: 'dialog-header kct-dialog-head' }, [
      h('h2', { class: 'kct-dialog-title', text: '关于' }),
      closeBtn
    ]);

    /* 应用信息 */
    var metaBits = ['版本 ' + version];
    if (portable) metaBits.push('便携模式');
    if (elevated) metaBits.push('以管理员运行');

    var hero = h('div', { class: 'kct-about-hero' }, [
      h('span', { class: 'kct-about-logo', html: ICON_APP }),
      h('div', { class: 'kct-about-herotext' }, [
        h('div', { class: 'kct-about-name', text: APP_NAME }),
        h('div', { class: 'kct-about-meta', text: metaBits.join(' · ') }),
        h('div', { class: 'kct-about-desc', text: '连点 · 定时序列 · 多配置页 · 前台窗口匹配锁定' })
      ])
    ]);

    /* 快捷键 */
    var toggleRow = h('div', { class: 'kct-hk-row' }, [
      h('span', { class: 'kct-hk-name', text: '开始 / 停止当前选中配置的全部任务' }),
      comboNode(DEFAULT_HOTKEYS.toggle)
    ]);
    var panicRow = h('div', { class: 'kct-hk-row' }, [
      h('span', { class: 'kct-hk-name', text: '开始 / 停止全部配置（所有页）' }),
      comboNode('f6')
    ]);

    var hotkeySection = h('div', { class: 'kct-about-section' }, [
      h('h3', { class: 'kct-about-h', text: '全局热键' }),
      toggleRow,
      panicRow,
      h('p', { class: 'field-hint kct-about-hint', text: '录入按键期间全局热键会自动暂时失效，因此可以把 F6 本身录成连点键。' })
    ]);

    /* 本地隐私说明 */
    var privacy = h('div', { class: 'kct-about-section' }, [
      h('h3', { class: 'kct-about-h', text: '本地程序' }),
      h('p', { class: 'field-hint kct-about-hint', text: '纯本地运行：不联网、不上传任何数据、不需要账号或密钥。配置自动保存在本机。' })
    ]);

    /* 配置路径 */
    var pathSection = null;
    if (configPath) {
      pathSection = h('div', { class: 'kct-about-section' }, [
        h('h3', { class: 'kct-about-h', text: '配置文件' }),
        h('p', { class: 'kct-about-path', text: configPath })
      ]);
    }

    var openDirBtn = h('button', {
      class: 'btn ghost kct-about-opendir',
      html: svg(ICON_FOLDER) + '<span>打开配置目录</span>'
    });
    openDirBtn.type = 'button';

    var body = h('div', { class: 'dialog-body kct-dialog-body kct-about-body' }, [hero, hotkeySection, privacy]);
    if (pathSection) body.appendChild(pathSection);
    body.appendChild(h('div', { class: 'kct-about-actions' }, [openDirBtn]));

    var okBtn = h('button', { class: 'btn primary kct-about-ok', text: '关闭' });
    okBtn.type = 'button';

    var footer = h('div', { class: 'dialog-footer kct-dialog-foot' }, [
      h('span', { class: 'kct-dialog-spacer' }),
      okBtn
    ]);

    var dialog = h('div', { class: 'dialog kct-about-dialog' }, [header, body, footer]);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '关于 KeyClicker');
    dialog.tabIndex = -1;

    var overlay = h('div', { class: 'overlay kct-overlay kct-about-overlay' }, [dialog]);

    function cleanup() {
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (openSession && openSession.promise === promise) openSession = null;
    }

    function close() {
      if (closed) return;
      cleanup();
      resolveFn(undefined);
    }

    function onKeydown(ev) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }

    closeBtn.addEventListener('click', function (ev) { ev.preventDefault(); close(); });
    okBtn.addEventListener('click', function (ev) { ev.preventDefault(); close(); });
    overlay.addEventListener('mousedown', function (ev) {
      if (ev.target === overlay) close();
    });

    openDirBtn.addEventListener('click', async function (ev) {
      ev.preventDefault();
      try {
        await KC.host.call('app.openConfigDir', {});
      } catch (err) {
        toast('error', errText(err));
      }
    });

    overlayRoot().appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    try { dialog.focus(); } catch (e) { /* ignore */ }

    openSession = {
      promise: promise,
      focus: function () { try { dialog.focus(); } catch (e) { /* ignore */ } },
      close: close
    };

    // 热键异步补全（拿到真实热键后替换显示）
    fetchHotkeys().then(function (hotkeys) {
      if (closed) return;
      toggleRow.replaceChild(comboNode(hotkeys.toggle), toggleRow.lastChild);
      panicRow.replaceChild(comboNode(hotkeys.panic), panicRow.lastChild);
    }).catch(function () { /* 用默认值即可 */ });

    return promise;
  }

  KC.views.about = {
    open: open,
    close: function () { if (openSession && openSession.close) openSession.close(); }
  };
})();
