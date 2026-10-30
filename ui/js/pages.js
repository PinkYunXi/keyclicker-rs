/* =============================================================================
   KeyClicker Next —— pages.js（ui-foundation）
   配置页标签栏：渲染 / 选择 / 新建 / 重命名 / 删除 / 横向滚动 + 状态栏默认内容。
   与 ui-bridge 对接（以 KC.state 为准，缺失时用本地页兜底）：
     - 读：KC.state.config.pages / KC.state.config.selectedPage
     - 写：KC.state.update(function (config) { ... })
     - 事件：KC.bus 'page:select' { index, page }、'pages:changed' { type, index }
   对外 API：KC.pages.render() / setSelected(i) / getSelected() / getPages()
   ========================================================================== */
(function (window, document) {
  'use strict';

  var KC = window.KC || (window.KC = {});
  var dom = KC.dom;
  var h = dom.h;
  var icon = KC.icon;

  function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function isNode(value) {
    return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
  }

  /* 没有宿主 / state 时的本地兜底，保证浏览器直接打开也能操作页签栏 */
  var localConfig = {
    pages: [{ name: '配置 1', tasks: [] }],
    selectedPage: 0
  };

  var refs = { scroll: null, actions: null };
  var editingIndex = null;
  var stateHooked = false;

  /* ---- 数据访问 ---------------------------------------------------------- */
  function getConfig() {
    var cfg = KC.state && KC.state.config;
    if (cfg && isArray(cfg.pages) && cfg.pages.length) return cfg;
    return localConfig;
  }

  function getPages() {
    var pages = getConfig().pages;
    return isArray(pages) ? pages : [];
  }

  function getSelected() {
    var pages = getPages();
    var index = Number(getConfig().selectedPage) || 0;
    if (!pages.length) return 0;
    return Math.max(0, Math.min(pages.length - 1, index | 0));
  }

  function pageName(page, index) {
    return (page && page.name) || ('配置 ' + (index + 1));
  }

  /** 执行配置修改；优先走 KC.state.update（由 ui-bridge 去抖保存） */
  function mutate(mutator) {
    var cfg = getConfig();
    if (cfg === localConfig) {
      mutator(localConfig);
      return;
    }
    if (KC.state && typeof KC.state.update === 'function') {
      try {
        KC.state.update(function (config) {
          if (config && isArray(config.pages)) mutator(config);
        });
        return;
      } catch (err) {
        if (window.console && console.error) console.error('[KC.pages] 更新失败', err);
      }
    }
    mutator(cfg);
  }

  function emitChanged(type, index) {
    KC.bus.emit('pages:changed', { type: type, index: index });
  }

  function emitSelect(index) {
    var pages = getPages();
    KC.bus.emit('page:select', { index: index, page: pages[index] || null });
  }

  /* ---- 渲染 -------------------------------------------------------------- */
  function iconButton(iconName, label, onClick) {
    return h('button', {
      class: 'btn icon ghost',
      type: 'button',
      title: label,
      'aria-label': label,
      on: { click: onClick }
    }, [icon(iconName)]);
  }

  function ensureContainers(bar) {
    var scroll = bar.querySelector('.pagebar-scroll');
    if (!scroll) {
      scroll = h('div', {
        class: 'pagebar-scroll',
        role: 'tablist',
        'aria-label': '配置页'
      });
      bar.appendChild(scroll);
      scroll.addEventListener('wheel', onWheel, { passive: false });
    }
    var actions = bar.querySelector('.pagebar-actions');
    if (!actions) {
      actions = h('div', { class: 'pagebar-actions' });
      bar.appendChild(actions);
    }
    refs.scroll = scroll;
    refs.actions = actions;
  }

  function onWheel(event) {
    var scroll = refs.scroll;
    if (!scroll) return;
    if (scroll.scrollWidth <= scroll.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    scroll.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  function render() {
    var bar = document.getElementById('pagebar');
    if (!bar) return;
    if (editingIndex != null) return; /* 重命名中不重建 DOM，避免打断输入 */
    ensureContainers(bar);

    var pages = getPages();
    var selected = getSelected();
    dom.clear(refs.scroll);

    pages.forEach(function (page, index) {
      var active = index === selected;
      refs.scroll.appendChild(h('button', {
        class: 'tab' + (active ? ' active' : ''),
        type: 'button',
        role: 'tab',
        'aria-selected': active ? 'true' : 'false',
        title: pageName(page, index) + '（双击重命名）',
        dataset: { index: index },
        on: {
          click: function () {
            if (index !== getSelected()) setSelected(index, { user: true });
          },
          dblclick: function (event) {
            event.preventDefault();
            startRename(index);
          }
        }
      }, [h('span', { class: 'tab-label', text: pageName(page, index) })]));
    });

    renderActions(pages);
    ensureVisible(selected);
  }

  function renderActions(pages) {
    if (!refs.actions) return;
    dom.clear(refs.actions);

    refs.actions.appendChild(iconButton('plus', '新建配置页', function () {
      addPage();
    }));
    refs.actions.appendChild(iconButton('pencil', '重命名当前配置页', function () {
      startRename(getSelected());
    }));

    var removeBtn = iconButton('trash', '删除当前配置页', function () {
      removePage();
    });
    if (pages.length <= 1) {
      removeBtn.disabled = true;
      removeBtn.classList.add('is-disabled');
      removeBtn.title = '至少保留一个配置页';
    }
    refs.actions.appendChild(removeBtn);
  }

  function ensureVisible(index) {
    var scroll = refs.scroll;
    if (!scroll || scroll.scrollWidth <= scroll.clientWidth) return;
    var tab = scroll.querySelector('[data-index="' + index + '"]');
    if (!tab) return;
    var tabRect = tab.getBoundingClientRect();
    var scrollRect = scroll.getBoundingClientRect();
    if (tabRect.left < scrollRect.left) {
      scroll.scrollLeft += tabRect.left - scrollRect.left - 8;
    } else if (tabRect.right > scrollRect.right) {
      scroll.scrollLeft += tabRect.right - scrollRect.right + 8;
    }
  }

  /* ---- 操作：选择 / 新建 / 重命名 / 删除 -------------------------------- */
  function setSelected(index, options) {
    var pages = getPages();
    if (!pages.length) return;
    var target = Math.max(0, Math.min(pages.length - 1, Number(index) | 0));
    var changed = target !== getSelected();

    if (changed) {
      mutate(function (config) { config.selectedPage = target; });
    }
    render();
    if (changed || (options && options.user)) emitSelect(target);
  }

  function nextPageName() {
    var pages = getPages();
    var used = {};
    pages.forEach(function (page) { used[pageName(page, 0)] = true; });
    var n = pages.length + 1;
    while (used['配置 ' + n]) n += 1;
    return '配置 ' + n;
  }

  function addPage() {
    var name = nextPageName();
    var index = getPages().length;
    mutate(function (config) {
      config.pages.push({ name: name, tasks: [] });
      config.selectedPage = config.pages.length - 1;
      index = config.selectedPage;
    });
    render();
    emitChanged('add', index);
    emitSelect(index);
  }

  function startRename(index) {
    var pages = getPages();
    if (index == null || index < 0 || index >= pages.length) return;
    if (editingIndex != null) return;
    var scroll = refs.scroll || document.querySelector('#pagebar .pagebar-scroll');
    if (!scroll) return;
    var tab = scroll.querySelector('[data-index="' + index + '"]');
    var label = tab && tab.querySelector('.tab-label');
    if (!tab || !label) return;

    editingIndex = index;
    var original = pageName(pages[index], index);
    var input = h('input', {
      class: 'pagebar-rename',
      type: 'text',
      value: original,
      maxlength: 40,
      'aria-label': '配置页名称',
      on: {
        click: function (event) { event.stopPropagation(); },
        dblclick: function (event) { event.stopPropagation(); },
        keydown: function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            commit(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            commit(false);
          }
        },
        blur: function () { commit(true); }
      }
    });

    label.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      var value = input.value.trim();
      editingIndex = null;
      if (save && value && value !== original) {
        mutate(function (config) {
          if (config.pages[index]) config.pages[index].name = value;
        });
        render();
        emitChanged('rename', index);
      } else {
        render();
      }
    }
  }

  function deleteSelectedPage() {
    var count = getPages().length;
    if (count <= 1) return;
    var target = Math.max(0, Math.min(count - 1, getSelected()));
    var removedName = pageName(getPages()[target], target);
    mutate(function (config) {
      config.pages.splice(target, 1);
      if (config.selectedPage >= config.pages.length) {
        config.selectedPage = config.pages.length - 1;
      }
    });
    render();
    emitChanged('delete', target);
    emitSelect(getSelected());
    KC.toast.info('已删除配置页“' + removedName + '”');
  }

  function removePage() {
    var pages = getPages();
    var index = getSelected();
    if (pages.length <= 1) {
      KC.toast.warn('至少保留一个配置页');
      return;
    }
    var prefs = (window.KC && KC.prefs) || {};
    if (prefs.confirmDeletePage === false) {
      // 设置里关闭了「删除前确认」
      deleteSelectedPage();
      return;
    }
    var name = pageName(pages[index], index);
    KC.dialog.confirm({
      title: '删除配置页',
      message: '确定删除“' + name + '”吗？该页内的任务会一并删除，此操作不可撤销。',
      okText: '删除',
      cancelText: '取消',
      danger: true
    }).then(function (ok) {
      if (ok) deleteSelectedPage();
    });
  }

  /* ---- 状态栏 ------------------------------------------------------------ */
  function setStatusNode(id, value) {
    var node = document.getElementById(id);
    if (!node) return;
    if (value == null) {
      node.textContent = '';
      return;
    }
    if (isNode(value)) {
      dom.clear(node);
      node.appendChild(value);
      return;
    }
    node.textContent = String(value);
  }

  function kbd(text) {
    return h('kbd', { class: 'kbd', text: text });
  }

  var TICK = String.fromCharCode(96);
  var DEFAULT_HOTKEYS = { toggle: 'alt+' + TICK, panic: 'f6' };

  function comboNodes(combo) {
    var parts = String(combo || '').split('+').filter(function (p) { return p; });
    if (!parts.length) return [kbd('未设置')];
    var out = [];
    parts.forEach(function (part, i) {
      var lower = part.toLowerCase();
      var label = part;
      if (lower === 'ctrl' || lower === 'control') label = 'Ctrl';
      else if (lower === 'shift') label = 'Shift';
      else if (lower === 'alt') label = 'Alt';
      else if (lower === 'win' || lower === 'windows' || lower === 'super' || lower === 'cmd') label = 'Win';
      else if (/^f\d{1,2}$/.test(lower)) label = lower.toUpperCase();
      else if (lower === 'esc') label = 'Esc';
      else if (lower === 'tab') label = 'Tab';
      else if (lower === 'space') label = 'Space';
      else if (lower === 'enter') label = 'Enter';
      else if (part.length === 1) label = part.toUpperCase();
      if (i > 0) out.push(h('span', { class: 'faint', text: '+' }));
      out.push(kbd(label));
    });
    return out;
  }

  function defaultStatus() {
    var left = document.getElementById('status-left');
    if (left && !left.textContent.trim()) left.textContent = '就绪';

    var right = document.getElementById('status-right');
    if (!right) return;
    var hk = (window.KC && KC.hotkeys) || {};
    var toggle = hk.toggle || DEFAULT_HOTKEYS.toggle;
    var panic = hk.panic || DEFAULT_HOTKEYS.panic;
    dom.clear(right);
    var kids = comboNodes(toggle).concat([
      h('span', { class: 'faint', text: ' 启停当前配置' }),
      h('span', { class: 'faint', text: '·' })
    ]).concat(comboNodes(panic)).concat([
      h('span', { class: 'faint', text: ' 启停全部配置' })
    ]);
    right.appendChild(h('span', { class: 'row tight nowrap' }, kids));
  }
  var status = {
    left: function (value) { setStatusNode('status-left', value); },
    right: function (value) { setStatusNode('status-right', value); },
    reset: defaultStatus
  };
  KC.status = status;

  /* ---- 与 KC.state 对接 -------------------------------------------------- */
  function hookState() {
    if (stateHooked) return;
    if (KC.state && typeof KC.state.onChange === 'function') {
      stateHooked = true;
      try {
        KC.state.onChange(function () { render(); });
        render();
        return;
      } catch (err) {
        if (window.console && console.error) console.error('[KC.pages] 订阅 state 失败', err);
      }
    }
  }

  function init() {
    render();
    defaultStatus();

    KC.bus.on('pages:render', render);
    ['state:loaded', 'state:changed', 'config:changed', 'config:loaded'].forEach(function (name) {
      KC.bus.on(name, function () { render(); });
    });

    /* state.js 在本文件之后加载，加载完成后补订阅 */
    [0, 300, 1000].forEach(function (delay) {
      setTimeout(hookState, delay);
    });
  }

  KC.pages = {
    init: init,
    render: render,
    refresh: render,
    setSelected: function (index) { setSelected(index, { user: true }); },
    select: function (index) { setSelected(index, { user: true }); },
    getSelected: getSelected,
    getPages: getPages,
    add: addPage,
    rename: startRename,
    remove: removePage,
    isEditing: function () { return editingIndex != null; }
  };

  KC.ready(init);
})(window, document);
