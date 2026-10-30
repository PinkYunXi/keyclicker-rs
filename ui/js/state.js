/*!
 * KeyClicker Next — ui/js/state.js
 * 归属：ui-bridge。Config 缓存 + 去抖自动保存。
 *
 * 对外接口（docs/UI_CONTRACT.md §4）：
 *   await KC.state.load()          -> 从宿主拉取完整 Config 并归一化
 *   KC.state.config                -> 当前 Config（只读语义，修改请走 update）
 *   KC.state.update(fn)            -> fn(config) 内修改；300ms 去抖后整体 config.set
 *   KC.state.saveNow()             -> 立即落盘（返回 Promise）
 *   KC.state.onChange(fn)          -> 订阅变更，返回取消函数
 * 附加（便利方法，全部内部走 update，不绕过统一保存）：
 *   currentPageIndex() / page(i) / setSelectedPage(i) / addTask / removeTask / updateTask
 *   normalizeConfig(raw) / normalizeTask(task) / defaultConfig() / useDefault()
 */
(function (global) {
  'use strict';

  var KC = global.KC = global.KC || {};

  var SAVE_DEBOUNCE_MS = 300;

  var store = {
    config: null,
    loaded: false,
    dirty: false,
    saveTimer: 0,
    saving: null,
    lastError: null
  };

  var changeListeners = [];
  var loadPromise = null;
  var saveSeq = 0;

  /* ---------------------------------------------------------------- 工具 */

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function clampInt(v, def, min, max) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n)) n = def;
    n = Math.round(n);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function warn() {
    try {
      console.warn.apply(console, ['[KC.state]'].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- 归一化 */

  function defaultConfig() {
    return {
      version: 3,
      theme: 'dark',
      selectedPage: 0,
      hotkeys: { toggle: 'alt+`', panic: 'f6' },
      window: { alwaysOnTop: false },
      pages: [{ name: '配置 1', tasks: [] }]
    };
  }

  function normalizeTask(raw) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var type = raw.type === 'timer' ? 'timer' : 'click';
    var task = {
      type: type,
      windowMatch: typeof raw.windowMatch === 'string' ? raw.windowMatch : '',
      windowMode: ['contains', 'exact', 'regex'].indexOf(raw.windowMode) >= 0 ? raw.windowMode : 'contains'
    };
    if (type === 'click') {
      task.keys = typeof raw.keys === 'string' && raw.keys.trim() ? raw.keys.trim() : 'a';
      task.interval = clampInt(raw.interval, 100, 16, 3600000);
    } else {
      task.seq = Array.isArray(raw.seq)
        ? raw.seq.filter(function (s) { return typeof s === 'string' && s.trim(); }).map(function (s) { return s.trim(); })
        : [];
      task.minutes = clampInt(raw.minutes, 0, 0, 1440);
      task.seconds = clampInt(raw.seconds, 10, 0, 59);
      task.gap = clampInt(raw.gap, 200, 16, 3600000);
      if (task.minutes === 0 && task.seconds < 1) task.seconds = 1;
    }
    return task;
  }

  function normalizeConfig(raw) {
    var def = defaultConfig();
    if (Array.isArray(raw)) raw = { pages: raw };            // 旧版 v1.1.0：顶层是页面数组
    if (!raw || typeof raw !== 'object') return def;

    var cfg = {
      version: typeof raw.version === 'number' ? raw.version : 3,
      theme: raw.theme === 'light' ? 'light' : (raw.theme === 'system' ? 'system' : 'dark'),
      selectedPage: clampInt(raw.selectedPage, 0, 0, 9999),
      hotkeys: {
        toggle: (raw.hotkeys && typeof raw.hotkeys.toggle === 'string' && raw.hotkeys.toggle) || def.hotkeys.toggle,
        panic: (raw.hotkeys && typeof raw.hotkeys.panic === 'string' && raw.hotkeys.panic) || def.hotkeys.panic
      },
      window: { alwaysOnTop: !!(raw.window && raw.window.alwaysOnTop) },
      pages: []
    };

    var pages = Array.isArray(raw.pages) ? raw.pages : [];
    for (var i = 0; i < pages.length; i++) {
      var p = (pages[i] && typeof pages[i] === 'object') ? pages[i] : {};
      var tasks = Array.isArray(p.tasks) ? p.tasks.map(normalizeTask) : [];
      cfg.pages.push({
        name: typeof p.name === 'string' && p.name ? p.name : '配置 ' + (i + 1),
        tasks: tasks
      });
    }
    if (!cfg.pages.length) cfg.pages = [{ name: '配置 1', tasks: [] }];
    if (cfg.selectedPage >= cfg.pages.length) cfg.selectedPage = 0;
    return cfg;
  }

  /* ---------------------------------------------------------------- 变更通知 */

  function notify(meta) {
    var list = changeListeners.slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](store.config, meta || {});
      } catch (e) {
        warn('onChange 回调抛错', e);
      }
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('KC.state.onChange(fn)：fn 必须是函数');
    changeListeners.push(fn);
    return function off() {
      var idx = changeListeners.indexOf(fn);
      if (idx >= 0) changeListeners.splice(idx, 1);
    };
  }

  /* ---------------------------------------------------------------- 加载 */

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = KC.host.call('config.get', {}).then(function (raw) {
      store.config = normalizeConfig(raw);
      store.loaded = true;
      store.dirty = false;
      notify({ reason: 'load' });
      return store.config;
    }, function (err) {
      loadPromise = null;                    // 允许上层重试
      throw err;
    });
    return loadPromise;
  }

  // 宿主不可用时的兜底：内存默认配置（main.js 启动失败分支用）
  function useDefault() {
    store.config = defaultConfig();
    store.loaded = true;
    store.dirty = true;
    notify({ reason: 'reset' });
    return store.config;
  }

  /* ---------------------------------------------------------------- 修改 + 去抖保存 */

  function scheduleSave() {
    if (store.saveTimer) global.clearTimeout(store.saveTimer);
    store.saveTimer = global.setTimeout(function () {
      store.saveTimer = 0;
      saveNow().catch(function () { /* 错误已提示，保留脏标记等下次 */ });
    }, SAVE_DEBOUNCE_MS);
  }

  function reportSaveError(err) {
    store.lastError = err;
    var message = (err && err.message) ? err.message : '配置保存失败';
    if (KC.toast && typeof KC.toast === 'function') {
      try { KC.toast('error', message); return; } catch (e) { /* ignore */ }
    }
    warn(message);
  }

  function saveNow() {
    if (store.saveTimer) { global.clearTimeout(store.saveTimer); store.saveTimer = 0; }

    if (store.saving) {
      // 已有保存在进行：等它结束后再补一次（不在此处无限重试失败）
      return store.saving.then(function () { return saveNow(); }, function () { return store.config; });
    }
    if (!store.dirty || !store.config) return Promise.resolve(store.config);

    store.dirty = false;
    var payload = clone(store.config);
    var seq = ++saveSeq;
    var p = KC.host.call('config.set', { config: payload });

    store.saving = p.then(function () {
      store.saving = null;
      store.lastError = null;
      return store.config;
    }, function (err) {
      store.saving = null;
      if (seq === saveSeq) store.dirty = true;   // 失败保留脏标记，下次 update/saveNow 重试
      reportSaveError(err);
      throw err;
    });
    return store.saving;
  }

  function update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('KC.state.update(mutator)：参数必须是函数');
    if (!store.config) store.config = defaultConfig();

    var ret = mutator(store.config);
    if (ret && typeof ret === 'object' && ret !== store.config) store.config = ret;
    if (!store.config || typeof store.config !== 'object') store.config = defaultConfig();
    if (!Array.isArray(store.config.pages) || !store.config.pages.length) {
      store.config.pages = [{ name: '配置 1', tasks: [] }];
    }
    // 注意：不做 normalize，避免打断用户正在输入（例如 interval 输到一半）。
    // 归一化只在 load 时做；视图负责在提交时给出合法值。

    store.dirty = true;
    notify({ reason: 'update' });
    scheduleSave();
    return store.config;
  }

  /* ---------------------------------------------------------------- 任务便利方法（统一走 update） */

  function currentPageIndex() {
    var cfg = store.config;
    if (!cfg || !Array.isArray(cfg.pages) || !cfg.pages.length) return 0;
    var idx = typeof cfg.selectedPage === 'number' ? cfg.selectedPage : 0;
    if (idx < 0 || idx >= cfg.pages.length) idx = 0;
    return idx;
  }

  function page(index) {
    var cfg = store.config;
    if (!cfg || !Array.isArray(cfg.pages)) return null;
    var i = (typeof index === 'number') ? index : currentPageIndex();
    return cfg.pages[i] || null;
  }

  function setSelectedPage(index) {
    return update(function (cfg) {
      var i = clampInt(index, 0, 0, cfg.pages.length - 1);
      cfg.selectedPage = i;
    });
  }

  function addTask(pageIndex, task) {
    var spec = normalizeTask(task);
    update(function (cfg) {
      var pg = cfg.pages[pageIndex];
      if (!pg) return;
      if (!Array.isArray(pg.tasks)) pg.tasks = [];
      pg.tasks.push(spec);
    });
    return spec;
  }

  function removeTask(pageIndex, index) {
    update(function (cfg) {
      var pg = cfg.pages[pageIndex];
      if (!pg || !Array.isArray(pg.tasks)) return;
      if (index < 0 || index >= pg.tasks.length) return;
      pg.tasks.splice(index, 1);
    });
  }

  function updateTask(pageIndex, index, patch) {
    update(function (cfg) {
      var pg = cfg.pages[pageIndex];
      if (!pg || !Array.isArray(pg.tasks)) return;
      if (!pg.tasks[index]) return;
      var merged = {};
      var src = pg.tasks[index];
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) merged[k] = src[k];
      for (var j in patch) if (Object.prototype.hasOwnProperty.call(patch, j)) merged[j] = patch[j];
      pg.tasks[index] = normalizeTask(merged);
    });
    return page(pageIndex) && page(pageIndex).tasks[index];
  }

  /* ---------------------------------------------------------------- 导出 */

  KC.state = {
    SAVE_DEBOUNCE_MS: SAVE_DEBOUNCE_MS,
    load: load,
    update: update,
    saveNow: saveNow,
    flush: saveNow,
    onChange: onChange,
    useDefault: useDefault,
    isDirty: function () { return !!store.dirty; },
    isSaving: function () { return !!store.saving; },
    lastError: function () { return store.lastError; },
    defaultConfig: defaultConfig,
    normalizeConfig: normalizeConfig,
    normalizeTask: normalizeTask,
    currentPageIndex: currentPageIndex,
    page: page,
    setSelectedPage: setSelectedPage,
    addTask: addTask,
    removeTask: removeTask,
    updateTask: updateTask
  };

  Object.defineProperty(KC.state, 'config', {
    enumerable: true,
    get: function () { return store.config; }
  });
  Object.defineProperty(KC.state, 'loaded', {
    enumerable: true,
    get: function () { return store.loaded; }
  });
})(typeof window !== 'undefined' ? window : this);
