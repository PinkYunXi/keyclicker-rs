/* ui/js/views/settings.js — 设置弹层（关闭行为 / 全局热键 / 主题）
 * 用法：KC.views.settings.open()
 * 精简单页，无最大化 / 最小化，仅保留关闭按钮。
 */
(function () {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.views = KC.views || {};

  var TICK = String.fromCharCode(96);
  var DEFAULTS = { toggle: 'alt+' + TICK, panic: 'f6' };
  var opening = false;
  var activeCleanup = null;
  /** 面板草稿：点「应用当前设置 / 保存并退出」时整体写盘 */
  var draft = null;

  function h(tag, attrs, kids) { return KC.dom.h(tag, attrs, kids); }

  function displayCombo(combo) {
    var parts = String(combo == null ? '' : combo).split('+').filter(function (p) { return p; });
    if (!parts.length) return ['未设置'];
    return parts.map(function (p) {
      var l = p.toLowerCase();
      if (l === 'ctrl' || l === 'control') return 'Ctrl';
      if (l === 'shift') return 'Shift';
      if (l === 'alt') return 'Alt';
      if (l === 'win' || l === 'windows' || l === 'super' || l === 'cmd') return 'Win';
      if (/^f\d{1,2}$/.test(l)) return l.toUpperCase();
      if (l === 'esc') return 'Esc';
      if (l === 'tab') return 'Tab';
      if (l === 'space') return 'Space';
      if (l === 'enter') return 'Enter';
      return p.length === 1 ? p.toUpperCase() : p;
    });
  }

  function comboNode(combo) {
    var wrap = h('span', { class: 'kct-keys' });
    displayCombo(combo).forEach(function (part, i) {
      if (i > 0) wrap.appendChild(h('span', { class: 'kct-keys-plus', text: '+' }));
      wrap.appendChild(h('span', { class: 'kbd', text: part }));
    });
    return wrap;
  }

  /* 设置项同时写回前端 state.config：
     否则后续任何配置保存会用旧快照整体覆盖，导致「有时候改了没保存」 */
  function syncState(mutator) {
    try {
      if (KC.state && typeof KC.state.update === 'function') {
        KC.state.update(function (config) {
          if (config) mutator(config);
        });
      }
    } catch (e) { /* ignore */ }
  }

  function applyStatusHotkeys(toggle, panic) {
    KC.hotkeys = { toggle: toggle, panic: panic };
    if (KC.status && typeof KC.status.reset === 'function') {
      try { KC.status.reset(); } catch (e) { /* ignore */ }
    }
  }

  /* 关闭行为：三个单选 */
  function closeSection(state, draft) {
    var current = (state && state.closeAction) || 'ask';
    var options = [
      { value: 'ask', label: '每次询问', hint: '关闭时弹框选择' },
      { value: 'tray', label: '最小化到托盘', hint: '隐藏窗口，后台继续运行' },
      { value: 'exit', label: '直接退出', hint: '立即结束程序' }
    ];
    var group = h('div', { class: 'kct-set-options' });
    options.forEach(function (opt) {
      var input = h('input', { type: 'radio', name: 'kc-close-action', value: opt.value });
      input.checked = opt.value === current;
      input.id = 'kc-close-' + opt.value;
      var item = h('label', { class: 'kct-set-option', for: input.id }, [
        input,
        h('span', { class: 'kct-set-option-main' }, [
          h('span', { class: 'kct-set-option-label', text: opt.label }),
          h('span', { class: 'kct-set-option-hint', text: opt.hint })
        ])
      ]);
      input.addEventListener('change', function () {
        if (!input.checked) return;
        KC.host.call('settings.setCloseAction', { action: opt.value }).catch(function () {});
        if (draft) draft.closeAction = opt.value;
        syncState(function (config) {
          if (!config.close) config.close = {};
          config.close.action = opt.value;
        });
      });
      group.appendChild(item);
    });
    return h('div', { class: 'kct-set-section' }, [
      h('div', { class: 'kct-set-title', text: '关闭窗口时' }),
      group
    ]);
  }

  /* 配置页：删除前是否确认 */
  function pageSection(state, draft) {
    var on = !(state && state.confirmDeletePage === false);
    var input = h('input', { type: 'checkbox' });
    input.id = 'kc-confirm-delete';
    input.className = 'kct-set-check';
    input.checked = on;
    var row = h('label', { class: 'kct-set-option kct-set-option-check', for: 'kc-confirm-delete' }, [
      input,
      h('span', { class: 'kct-set-option-main' }, [
        h('span', { class: 'kct-set-option-label', text: '删除配置页前先确认' }),
        h('span', { class: 'kct-set-option-hint', text: '关闭后删除不再询问' })
      ])
    ]);
    input.addEventListener('change', function () {
      var value = !!input.checked;
      if (window.KC) {
        KC.prefs = KC.prefs || {};
        KC.prefs.confirmDeletePage = value;
      }
      KC.host.call('settings.setConfirmDeletePage', { on: value }).catch(function () {});
      if (draft) draft.confirmDeletePage = value;
      syncState(function (config) { config.confirm_delete_page = value; });
    });
    return h('div', { class: 'kct-set-section' }, [
      h('div', { class: 'kct-set-title', text: '配置页' }),
      row
    ]);
  }

  /* 全局热键：可录制 */
  function hotkeySection(state, draft) {
    var values = draft.hotkeys;
    var recording = null;

    function save() {
      KC.host.call('hotkey.set', { toggle: values.toggle, panic: values.panic })
        .then(function (data) {
          if (data && data.toggle) values.toggle = data.toggle;
          if (data && data.panic) values.panic = data.panic;
        })
        .catch(function () {
          conflict = '保存失败，请重试';
          KC.host.call('hotkey.resume', {}).catch(function () {});
        })
        .then(function () {
          syncRows();
          applyStatusHotkeys(values.toggle, values.panic);
          syncState(function (config) {
            if (!config.hotkeys) config.hotkeys = {};
            config.hotkeys.toggle = values.toggle;
            config.hotkeys.panic = values.panic;
          });
        });
    }

    function stopRecording(saveIt) {
      if (!recording) return;
      window.removeEventListener('keydown', recording.handler, true);
      recording = null;
      syncRows();
      if (saveIt !== true) {
        // 取消：恢复原来的全局热键
        KC.host.call('hotkey.resume', {}).catch(function () {});
      }
    }

    var conflict = ''; /* 录制冲突提示 */

    function startRecording(key, rowNode) {
      stopRecording();
      conflict = '';
      var handler = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stopRecording(false); return; }
        var combo = KC.keys && KC.keys.comboFromEvent ? KC.keys.comboFromEvent(e) : '';
        if (!combo) return;
        if (KC.keys.onlyModifiers && KC.keys.onlyModifiers(combo)) return;
        var other = key === 'toggle' ? 'panic' : 'toggle';
        if (combo === values[other]) {
          conflict = '与另一个热键相同，请换一个';
          stopRecording(false);
          return;
        }
        values[key] = combo;
        // 录一次即结束：解绑监听并恢复全局热键
        stopRecording(true);
        save();
      };
      recording = { key: key, handler: handler };
      // 立刻进入录制态：先绑监听、先给反馈
      window.addEventListener('keydown', handler, true);
      syncRows();
      // 再异步注销全局热键，否则录入的组合键会被系统截获
      KC.host.call('hotkey.suspend', {}).catch(function () {});
    }

    var rows = {};
    ['toggle', 'panic'].forEach(function (key) {
      var label = key === 'toggle' ? '启停当前配置' : '启停全部配置';
      var valueNode = h('span', { class: 'kct-set-hk-value' });
      var btn = h('button', { class: 'btn ghost kct-set-hk-btn', type: 'button', text: '更改' });
      // 绑定统一放在 syncRows 里（onclick），避免重复触发两次录制
      var row = h('div', { class: 'kct-set-hk-row' }, [
        h('span', { class: 'kct-set-hk-name', text: label }),
        valueNode,
        btn
      ]);
      rows[key] = { valueNode: valueNode, btn: btn, row: row };
    });

    function syncRows() {
      if (hint) {
        hint.textContent = conflict || hintText;
        hint.classList.toggle('kct-set-conflict', !!conflict);
      }
      ['toggle', 'panic'].forEach(function (key) {
        var row = rows[key];
        if (!row) return;
        KC.dom.clear(row.valueNode);
        if (recording && recording.key === key) {
          row.valueNode.appendChild(h('span', { class: 'kct-set-recording', text: '请按下快捷键…（Esc 取消）' }));
          row.btn.textContent = '取消';
          row.btn.onclick = function () { stopRecording(false); };
        } else {
          row.valueNode.appendChild(comboNode(values[key]));
          row.btn.textContent = '更改';
          row.btn.onclick = function () { startRecording(key, row.valueNode); };
        }
      });
    }

    var hintText = '点「更改」后按新组合键即保存，Esc 取消';
    var hint = h('div', { class: 'field-hint', text: hintText });
    var wrap = h('div', { class: 'kct-set-section' }, [
      h('div', { class: 'kct-set-title', text: '全局热键' }),
      h('div', { class: 'kct-set-hk' }, [rows.toggle.row, rows.panic.row]),
      hint
    ]);
    syncRows();
    activeCleanup = stopRecording;
    return wrap;
  }

  /* 主题 */
  function themeSection(state, draft) {
    var current = (state && state.theme) || 'system';
    var options = [
      { value: 'system', label: '跟随系统', hint: '随 Windows 设置' },
      { value: 'light', label: '浅色', hint: '适合明亮环境' },
      { value: 'dark', label: '深色', hint: '夜间不刺眼' }
    ];
    var group = h('div', { class: 'kct-set-options kct-set-inline' });
    options.forEach(function (opt) {
      var input = h('input', { type: 'radio', name: 'kc-theme', value: opt.value });
      input.checked = opt.value === current;
      input.id = 'kc-theme-' + opt.value;
      var item = h('label', { class: 'kct-set-option', for: input.id }, [
        input,
        h('span', { class: 'kct-set-option-main' }, [
          h('span', { class: 'kct-set-option-label', text: opt.label }),
          opt.hint ? h('span', { class: 'kct-set-option-hint', text: opt.hint }) : null
        ])
      ]);
      input.addEventListener('change', function () {
        if (!input.checked) return;
        KC.host.call('app.setTheme', { theme: opt.value })
          .then(function (data) {
            var applied = (data && data.theme) || opt.value;
            if (KC.theme && KC.theme.apply) KC.theme.apply(applied);
            if (draft) draft.theme = opt.value;
            syncState(function (config) { config.theme = opt.value; });
          })
          .catch(function () {});
      });
      group.appendChild(item);
    });
    return h('div', { class: 'kct-set-section' }, [
      h('div', { class: 'kct-set-title', text: '主题' }),
      group
    ]);
  }

  function open() {
    if (opening) return Promise.resolve();
    if (!KC.dialog || typeof KC.dialog.open !== 'function') return Promise.resolve();
    opening = true;
    return KC.host.call('settings.get', {}).then(function (state) {
      var hk = (state && state.hotkeys) || {};
      draft = {
        closeAction: (state && state.closeAction) || 'ask',
        confirmDeletePage: !(state && state.confirmDeletePage === false),
        theme: (state && state.theme) || 'dark',
        hotkeys: {
          toggle: hk.toggle || DEFAULTS.toggle,
          panic: hk.panic || DEFAULTS.panic
        }
      };
      var body = h('div', { class: 'kct-set' }, [
        closeSection(state, draft),
        pageSection(state, draft),
        hotkeySection(state, draft),
        themeSection(state, draft)
      ]);
      return KC.dialog.open({
        title: '设置',
        body: body,
        actions: [] /* 所有设置项点一下即保存，面板只用右上角 ✕ 关闭 */
      });
    }).catch(function () {
      return null;
    }).then(function (v) {
      if (typeof activeCleanup === 'function') {
        try { activeCleanup(); } catch (e) { /* ignore */ }
      }
      activeCleanup = null;
      draft = null;
      opening = false;
      return v;
    });
  }

  KC.views.settings = { open: open };

  function bind() {
    if (KC.host && typeof KC.host.on === 'function') {
      KC.host.on('openSettings', function () { open(); });
    }
    if (KC.bus && typeof KC.bus.on === 'function') {
      KC.bus.on('settings:open', function () { open(); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  window.__kcSettingsReady = true;

})();
