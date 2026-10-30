/*!
 * KeyClicker Next — ui/js/main.js
 * 归属：ui-bridge。启动顺序、#view 骨架、视图挂载、宿主事件分派。
 *
 * 启动顺序（docs/PROTOCOL.md §8 + Lead 裁定）：
 *   KC.host.init() → KC.state.load() → 渲染 #view 骨架 → mount 三个视图 → 订阅宿主事件 → 首次 task.list
 *
 * #view 结构（main.js 独占，常驻不销毁，只切显隐）：
 *   <div id="view" data-mode="click">
 *     <div class="kct-page">
 *       <div class="kct-page-head" data-role="mode-switch"> .segmented 分段控件 </div>
 *       <section class="kct-cards">
 *         <div data-view="click"></div>
 *         <div data-view="timer" style="display:none"></div>
 *       </section>
 *       <section class="kct-list" data-view="list"></section>
 *     </div>
 *   </div>
 *
 * 容错：KC.views.* 缺失 → console.warn + data-missing-view 占位，300ms 重试（最多 5 次），绝不抛异常。
 */
(function (global) {
  'use strict';

  var KC = global.KC = global.KC || {};

  var MODES = [
    { mode: 'click', label: '连点' },
    { mode: 'timer', label: '定时序列' }
  ];
  var MOUNT_RETRY_MS = 300;
  var MOUNT_RETRY_MAX = 5;

  var runtime = {
    mode: 'click',
    appInfo: null,
    tasks: [],
    byId: Object.create(null),
    currentTaskId: null,
    booted: false,
    bootError: null,
    bootPhase: 'idle'
  };

  var shell = null;
  var bootPromise = null;
  var mountRetryTimer = 0;
  var mountRetries = 0;
  var hostSubs = [];
  var stateOff = null;

  /* ---------------------------------------------------------------- 小工具 */

  function warn() {
    try {
      console.warn.apply(console, ['[KC.app]'].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* ignore */ }
  }

  function emitBus(name, payload) {
    if (!KC.bus || typeof KC.bus.emit !== 'function') return;
    try { KC.bus.emit(name, payload); } catch (e) { warn('bus.emit 失败：' + name, e); }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function indexRuntimes(list) {
    var map = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id) map[list[i].id] = list[i];
    }
    return map;
  }

  function normalizeRuntime(raw) {
    raw = raw || {};
    return {
      id: raw.id != null ? String(raw.id) : '',
      pageIndex: typeof raw.pageIndex === 'number' ? raw.pageIndex : 0,
      type: raw.type === 'timer' ? 'timer' : 'click',
      state: (raw.state === 'running' || raw.state === 'paused') ? raw.state : 'idle',
      count: typeof raw.count === 'number' ? raw.count : 0,
      remaining: typeof raw.remaining === 'number' ? raw.remaining : 0,
      windowBlocked: !!raw.windowBlocked
    };
  }

  function totalSecondsOf(task) {
    if (!task || task.type !== 'timer') return 0;
    var m = typeof task.minutes === 'number' ? task.minutes : 0;
    var s = typeof task.seconds === 'number' ? task.seconds : 0;
    return Math.max(1, m * 60 + s);
  }

  /* ---------------------------------------------------------------- 主题 */

  function resolveConfiguredTheme(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    var hostTheme = runtime.appInfo && runtime.appInfo.theme;
    if (hostTheme === 'light' || hostTheme === 'dark') return hostTheme;
    try {
      return (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function applyTheme(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    if (KC.theme && typeof KC.theme.apply === 'function') {
      try { KC.theme.apply(t); return t; } catch (e) { warn('KC.theme.apply 失败，回退 data-theme', e); }
    }
    document.documentElement.setAttribute('data-theme', t);
    return t;
  }

  /* ---------------------------------------------------------------- #view 骨架 */

  function buildShell() {
    var view = document.getElementById('view');
    if (!view) {
      warn('缺少 #view 挂载点，视图无法渲染');
      return null;
    }
    if (shell) return shell;

    view.innerHTML = '';
    view.setAttribute('data-mode', runtime.mode);

    var page = el('div', 'kct-page');

    var head = el('div', 'kct-page-head');
    head.setAttribute('data-role', 'mode-switch');
    var buttons = [];
    var segmented = el('div', 'segmented');
    segmented.setAttribute('role', 'tablist');
    for (var i = 0; i < MODES.length; i++) {
      (function (def) {
        var btn = el('button', 'segmented-item', def.label);
        btn.type = 'button';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('data-mode', def.mode);
        btn.addEventListener('click', function () { setMode(def.mode); });
        segmented.appendChild(btn);
        buttons.push(btn);
      })(MODES[i]);
    }
    head.appendChild(segmented);

    var cards = el('section', 'kct-cards');
    var clickSlot = el('div');
    clickSlot.setAttribute('data-view', 'click');
    var timerSlot = el('div');
    timerSlot.setAttribute('data-view', 'timer');
    cards.appendChild(clickSlot);
    cards.appendChild(timerSlot);

    var listSlot = el('section', 'kct-list');
    listSlot.setAttribute('data-view', 'list');

    page.appendChild(head);
    page.appendChild(cards);
    page.appendChild(listSlot);
    view.appendChild(page);

    shell = {
      view: view,
      page: page,
      head: head,
      segmented: segmented,
      click: clickSlot,
      timer: timerSlot,
      list: listSlot,
      modeButtons: buttons
    };
    applyModeToShell();
    return shell;
  }

  function applyModeToShell() {
    var sh = shell;
    if (!sh) return;
    sh.view.setAttribute('data-mode', runtime.mode);
    sh.click.style.display = runtime.mode === 'click' ? '' : 'none';
    sh.timer.style.display = runtime.mode === 'timer' ? '' : 'none';
    for (var i = 0; i < sh.modeButtons.length; i++) {
      var btn = sh.modeButtons[i];
      var active = btn.getAttribute('data-mode') === runtime.mode;
      if (active) {
        btn.classList.add('active');
        btn.classList.add('is-active');
      } else {
        btn.classList.remove('active');
        btn.classList.remove('is-active');
      }
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  function setMode(mode) {
    var next = mode === 'timer' ? 'timer' : 'click';
    var changed = runtime.mode !== next;
    runtime.mode = next;
    applyModeToShell();
    if (changed) {
      emitBus('mode:change', { mode: next });
      refreshViews();
    }
    return next;
  }

  /* ---------------------------------------------------------------- 视图挂载 */

  function viewContext() {
    return {
      pageIndex: KC.state.currentPageIndex(),
      state: KC.state,
      host: KC.host,
      app: KC.app,
      getPageIndex: function () { return KC.state.currentPageIndex(); }
    };
  }

  function markMissing(slot, name) {
    slot.setAttribute('data-missing-view', name);
    if (slot.querySelector('[data-placeholder="' + name + '"]')) return;
    var ph = el('div', 'kct-view-missing', '视图 ' + name + ' 尚未加载（等待 ui-tasks 就绪）');
    ph.setAttribute('data-placeholder', name);
    slot.appendChild(ph);
  }

  function mountOne(name, slot, ctx) {
    if (!slot) return true;
    var views = KC.views || {};
    var mod = views[name];

    if (!mod || typeof mod.mount !== 'function') {
      if (slot.getAttribute('data-missing-view') !== name) {
        warn('KC.views.' + name + ' 尚未实现，先挂占位（' + MOUNT_RETRY_MS + 'ms 后重试）');
      }
      markMissing(slot, name);
      return false;
    }
    if (slot.getAttribute('data-mounted') === name) return true;

    var ph = slot.querySelector('[data-placeholder="' + name + '"]');
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);

    try {
      mod.mount(slot, ctx);
      slot.setAttribute('data-mounted', name);
      slot.removeAttribute('data-missing-view');
      return true;
    } catch (e) {
      warn('挂载 KC.views.' + name + ' 失败：', e);
      markMissing(slot, name);
      return false;
    }
  }

  function mountViews() {
    var sh = shell;
    if (!sh) return false;
    var ctx = viewContext();
    var ok = true;
    ok = mountOne('clickForm', sh.click, ctx) && ok;
    ok = mountOne('timerForm', sh.timer, ctx) && ok;
    ok = mountOne('taskList', sh.list, ctx) && ok;

    if (ok) {
      mountRetries = 0;
    } else {
      scheduleMountRetry();
    }
    return ok;
  }

  function scheduleMountRetry() {
    if (mountRetryTimer) return;
    if (mountRetries >= MOUNT_RETRY_MAX) {
      warn('视图重试 ' + MOUNT_RETRY_MAX + ' 次仍未就绪，停止重试（页面仍可继续使用）');
      return;
    }
    mountRetries++;
    mountRetryTimer = global.setTimeout(function () {
      mountRetryTimer = 0;
      mountViews();
    }, MOUNT_RETRY_MS);
  }

  /* ---------------------------------------------------------------- 刷新分派 */

  function callView(mod, method, args) {
    if (!mod || typeof mod[method] !== 'function') return;
    try {
      mod[method].apply(mod, args);
    } catch (e) {
      warn('调用 KC.views.*.' + method + ' 失败：', e);
    }
  }

  function refreshViews() {
    var views = KC.views || {};
    if (!shell) return;
    callView(views.taskList, 'refresh', [runtime.tasks]);
    var current = runtime.currentTaskId ? (runtime.byId[runtime.currentTaskId] || null) : null;
    if (runtime.mode === 'click') callView(views.clickForm, 'refresh', [current]);
    else callView(views.timerForm, 'refresh', [current]);
  }

  /* ---------------------------------------------------------------- 宿主事件 */

  function onTaskStats(data) {
    if (!data || !Array.isArray(data.tasks)) return;
    runtime.tasks = data.tasks.map(normalizeRuntime);
    runtime.byId = indexRuntimes(runtime.tasks);
    refreshViews();
    emitBus('task:stats', { tasks: runtime.tasks });
  }

  function onTaskState(data) {
    if (!data || !data.id) return;
    var id = String(data.id);
    var target = runtime.byId[id];
    if (target) target.state = data.state;
    refreshViews();
    emitBus('task:state', { id: id, state: data.state });
  }

  function onToast(data) {
    var level = (data && data.level) || 'info';
    var message = (data && data.message) || '';
    if (!message) return;
    if (KC.toast && typeof KC.toast === 'function') {
      try { KC.toast(level, message); return; } catch (e) { warn('KC.toast 失败', e); }
    }
    if (level === 'error') warn(message); else console.info('[toast] ' + message);
  }

  function onThemeChanged(data) {
    var theme = applyTheme(data && data.theme);
    emitBus('theme:change', { theme: theme });
  }

  function onHotkey(data) {
    var action = (data && data.action) || 'toggle';
    emitBus('hotkey:triggered', { action: action });
    if (action === 'panic') {
      // 提示由宿主统一发送（暂停/恢复），前端只刷新任务列表，避免重复弹提示。
      seedRuntimes();
    }
  }

  /* 首次点击关闭：宿主发来 closePrompt，弹选择框（可记住） */
  function onClosePrompt() {
    var host = KC.host;
    function decide(action, remember) {
      if (!host || typeof host.call !== 'function') return;
      host.call('app.close.decide', { action: action, remember: !!remember })
        .catch(function (err) { warn('保存关闭选项失败', err); });
    }
    if (!KC.dialog || typeof KC.dialog.open !== 'function') {
      decide('tray', false);
      return;
    }
    var remember = document.createElement('input');
    remember.type = 'checkbox';
    remember.id = 'kc-close-remember';
    remember.className = 'kct-close-check';

    var text = document.createElement('p');
    text.className = 'dialog-text';
    text.textContent = '关闭窗口时希望怎么做？勾选「下次不再提示」后，以后点关闭会直接按这次的选择执行（可在托盘右键菜单里重新打开主界面）。';

    var label = document.createElement('label');
    label.className = 'kct-close-remember';
    label.setAttribute('for', 'kc-close-remember');
    var span = document.createElement('span');
    span.textContent = '下次不再提示（记住本次选择）';
    label.appendChild(remember);
    label.appendChild(span);

    var body = document.createElement('div');
    body.className = 'kct-close-body';
    body.appendChild(text);
    body.appendChild(label);

    KC.dialog.open({
      title: '关闭 KeyClicker',
      body: body,
      narrow: true,
      actions: [
        { label: '最小化到托盘', kind: 'primary', value: 'tray' },
        { label: '直接退出', kind: 'danger', value: 'exit' },
        { label: '取消', value: null }
      ]
    }).then(function (value) {
      if (!value) return;
      decide(value, remember.checked);
    });
  }

  function onClosing() {
    emitBus('app:closing', {});
    if (KC.state && typeof KC.state.saveNow === 'function') {
      KC.state.saveNow().catch(function (err) { warn('关窗前保存配置失败', err); });
    }
  }

  function forwardEvent(name) {
    return function (data) { emitBus(name, data); };
  }

  function subscribeHostEvents() {
    unsubHostEvents();
    hostSubs.push(KC.host.on('task.stats', onTaskStats));
    hostSubs.push(KC.host.on('task.state', onTaskState));
    hostSubs.push(KC.host.on('toast', onToast));
    hostSubs.push(KC.host.on('theme.changed', onThemeChanged));
    hostSubs.push(KC.host.on('hotkey.triggered', onHotkey));
    hostSubs.push(KC.host.on('record.captured', forwardEvent('record:captured')));
    hostSubs.push(KC.host.on('record.finished', forwardEvent('record:finished')));
    hostSubs.push(KC.host.on('window.grabTick', forwardEvent('window:grabTick')));
    hostSubs.push(KC.host.on('window.grabResult', forwardEvent('window:grabResult')));
    hostSubs.push(KC.host.on('app.closing', onClosing));
    hostSubs.push(KC.host.on('closePrompt', onClosePrompt));
  }

  function unsubHostEvents() {
    for (var i = 0; i < hostSubs.length; i++) {
      try { if (typeof hostSubs[i] === 'function') hostSubs[i](); } catch (e) { /* ignore */ }
    }
    hostSubs = [];
  }

  /* ---------------------------------------------------------------- Config 变更 */

  function onConfigChanged(config, meta) {
    if (!config) return;
    var pageIndex = KC.state.currentPageIndex();
    if (meta && meta.reason === 'load') return;
    if (pageIndex !== runtime.pageIndex) {
      runtime.pageIndex = pageIndex;
      emitBus('page:change', { pageIndex: pageIndex });
      mountViews();
      refreshViews();
    }
    emitBus('config:change', config);
  }

  function wireStateChange() {
    if (stateOff) { try { stateOff(); } catch (e) { /* ignore */ } stateOff = null; }
    stateOff = KC.state.onChange(onConfigChanged);
  }

  /* ---------------------------------------------------------------- 任务列表种子 */

  /* 用配置里的热键刷新全局缓存与底部提示（重启后仍显示上次改过的快捷键） */
  function applyHotkeysFromConfig(config) {
    var hk = (config && config.hotkeys) || {};
    var TICK = String.fromCharCode(96);
    window.KC.hotkeys = {
      toggle: hk.toggle || ('alt+' + TICK),
      panic: hk.panic || 'f6'
    };
    window.KC.prefs = {
      confirmDeletePage: !(config && config.confirm_delete_page === false)
    };
    if (KC.status && typeof KC.status.reset === 'function') {
      try { KC.status.reset(); } catch (e) { /* ignore */ }
    }
  }

  function seedRuntimes() {
    return KC.host.call('task.list', {}).then(function (data) {
      if (data && Array.isArray(data.tasks)) {
        runtime.tasks = data.tasks.map(normalizeRuntime);
        runtime.byId = indexRuntimes(runtime.tasks);
        refreshViews();
      }
    }, function (err) {
      warn('获取 task.list 失败（继续使用空运行态）', err);
    });
  }

  function runtimeAt(pageIndex, index) {
    var seen = 0;
    for (var i = 0; i < runtime.tasks.length; i++) {
      if (runtime.tasks[i].pageIndex !== pageIndex) continue;
      if (seen === index) return runtime.tasks[i];
      seen++;
    }
    return null;
  }

  /* ---------------------------------------------------------------- 任务增删（便利 + 测试用） */

  function addTask(pageIndex, task) {
    var idx = typeof pageIndex === 'number' ? pageIndex : KC.state.currentPageIndex();
    var cfg = KC.state.config;
    if (!cfg || !cfg.pages[idx]) {
      return Promise.reject({ code: 'not_found', message: '页面不存在：' + idx });
    }
    var spec = KC.state.normalizeTask(task);
    return KC.host.call('task.add', { pageIndex: idx, task: spec }).then(function (res) {
      KC.state.update(function (config) {
        var pg = config.pages[idx];
        if (!pg) return;
        if (!Array.isArray(pg.tasks)) pg.tasks = [];
        pg.tasks.push(spec);
      });
      return seedRuntimes().then(function () { return res; });
    });
  }

  function removeTaskAt(pageIndex, index) {
    var idx = typeof pageIndex === 'number' ? pageIndex : KC.state.currentPageIndex();
    var cfg = KC.state.config;
    var pg = cfg && cfg.pages[idx];
    if (!pg || !Array.isArray(pg.tasks) || !pg.tasks[index]) {
      return Promise.reject({ code: 'not_found', message: '任务不存在：第 ' + idx + ' 页第 ' + index + ' 项' });
    }
    var rt = runtimeAt(idx, index);
    var hostCall = (rt && rt.id)
      ? KC.host.call('task.remove', { id: rt.id }).catch(function (err) { warn('task.remove 失败（继续更新本地配置）', err); })
      : Promise.resolve();

    return hostCall.then(function () {
      KC.state.update(function (config) {
        var p2 = config.pages[idx];
        if (p2 && Array.isArray(p2.tasks)) p2.tasks.splice(index, 1);
      });
      return seedRuntimes();
    });
  }

  /* ---------------------------------------------------------------- dev 快捷键 */

  function isDev() {
    try {
      if (KC.host && typeof KC.host.isMock === 'function' && KC.host.isMock()) return true;
      if (global.location && global.location.protocol === 'file:') return true;
      if (global.__KC_DEV__) return true;
      return /[?&]dev=1(&|$)/.test((global.location && global.location.search) || '');
    } catch (e) {
      return false;
    }
  }

  function wireDevShortcuts() {
    if (!isDev()) return;
    global.addEventListener('keydown', function (ev) {
      if (ev.key === 'F5') {
        ev.preventDefault();
        try { global.location.reload(); } catch (e) { warn('刷新失败', e); }
        return;
      }
      if (ev.key === 'F12') {
        ev.preventDefault();
        // WebView2 的 DevTools 由宿主打开；mock/browser 下会失败，只打 info 不弹错
        KC.host.call('app.devtools', {}).then(function () {
          console.info('[KC.app] 已请求宿主打开 DevTools');
        }, function (err) {
          console.info('[KC.app] 无法打开 DevTools：' + ((err && err.message) || '宿主不支持 app.devtools'));
        });
      }
    }, true);
  }

  /* ---------------------------------------------------------------- 启动 / 失败 */

  function bootFailure(err) {
    var message = (err && err.message) ? err.message : String(err);
    console.error('[KC.app] 启动失败：' + message, err);
    var view = document.getElementById('view');
    if (view) {
      view.innerHTML = '';
      var box = el('div', 'kct-boot-error');
      box.appendChild(el('div', 'kct-boot-error-title', '启动失败：' + message));
      var btn = el('button', 'btn', '重试');
      btn.type = 'button';
      btn.addEventListener('click', function () { try { global.location.reload(); } catch (e) { /* ignore */ } });
      box.appendChild(btn);
      view.appendChild(box);
    }
    if (KC.toast && typeof KC.toast === 'function') {
      try { KC.toast('error', '启动失败：' + message); } catch (e) { /* ignore */ }
    }
    emitBus('app:error', { error: err });
  }

  function boot() {
    if (bootPromise) return bootPromise;

    bootPromise = KC.host.init().then(function (info) {
      runtime.bootPhase = 'init';
      runtime.appInfo = (info && typeof info === 'object') ? info : {};
      applyTheme(resolveConfiguredTheme(KC.state.config ? KC.state.config.theme : null));
      return KC.state.load();
    }).then(function (config) {
      runtime.bootPhase = 'load';
      applyTheme(resolveConfiguredTheme(config && config.theme));
      runtime.bootPhase = 'render';
      if (buildShell()) mountViews();
      applyHotkeysFromConfig(config);
      runtime.bootPhase = 'ready';
      subscribeHostEvents();     // 渲染后再订阅；bridge 会把 init 前的事件补发
      wireStateChange();
      wireDevShortcuts();
      return seedRuntimes();
    }).then(function () {
      runtime.booted = true;
      document.documentElement.setAttribute('data-kc-ready', '1');
      emitBus('app:ready', { info: runtime.appInfo });
      return KC.app;
    }).catch(function (err) {
      runtime.bootError = err;
      bootFailure(err);
      throw err;
    });

    // 避免无人 await whenReady() 时出现 unhandledrejection（错误已由 UI 呈现）
    bootPromise.catch(function () { /* 已处理 */ });
    return bootPromise;
  }

  function whenReady() {
    return bootPromise || boot();
  }

  /* ---------------------------------------------------------------- 对外 API */

  var app = {
    uiVersion: (KC.host && KC.host.uiVersion) || '1.0.0',
    whenReady: whenReady,
    booted: function () { return runtime.booted; },
    bootError: function () { return runtime.bootError; },
    info: function () { return runtime.appInfo; },
    isDev: isDev,
    setMode: setMode,
    pageIndex: function () { return KC.state.currentPageIndex(); },
    setPage: function (index) { return KC.state.setSelectedPage(index); },
    runtimeList: function () { return runtime.tasks.slice(); },
    runtime: function (id) { return runtime.byId[String(id)] || null; },
    seedRuntimes: seedRuntimes,
    refresh: function () { buildShell(); mountViews(); refreshViews(); },
    addTask: addTask,
    removeTaskAt: removeTaskAt,
    openAbout: function () {
      if (KC.views && KC.views.about && typeof KC.views.about.open === 'function') {
        try { KC.views.about.open(); } catch (e) { warn('打开关于层失败', e); }
      } else {
        warn('KC.views.about 尚未实现');
      }
    },
    toast: function (level, message) {
      if (KC.toast && typeof KC.toast === 'function') {
        try { KC.toast(level, message); return; } catch (e) { /* ignore */ }
      }
      console.info('[KC.app.toast] ' + message);
    }
  };

  Object.defineProperty(app, 'mode', {
    enumerable: true,
    get: function () { return runtime.mode; }
  });

  KC.app = app;
  // 供视图在增删任务后立刻刷新运行态（否则新任务按钮会短暂禁用）
  KC.app.refreshRuntimes = function () { return seedRuntimes(); };

  /* ---------------------------------------------------------------- 入口 */

  // 等 DOM 与同级脚本全部解析完再启动（views/*.js 可能在本文件之后加载）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); }, { once: true });
  } else {
    global.setTimeout(function () { boot(); }, 0);
  }

  // 关窗兜底：宿主 app.closing 之外再保一次
  global.addEventListener('beforeunload', function () {
    if (KC.state && typeof KC.state.saveNow === 'function') {
      try { KC.state.saveNow(); } catch (e) { /* ignore */ }
    }
  });
})(typeof window !== 'undefined' ? window : this);
