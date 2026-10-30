/*!
 * KeyClicker Next — ui/js/mock-host.js
 * 归属：ui-bridge。浏览器直接打开 ui/index.html（无 WebView2）时的假宿主。
 *
 * 启用条件：KC.host.init() 发现没有 window.chrome.webview → 调 KC.mockHost.create()。
 * 内存态 Config（两页示例任务）+ localStorage 持久化；模拟 task.stats / record.captured /
 * window.grabTick 等事件，让浏览器里可以完整点 UI。
 *
 * 对外：KC.mockHost.create() / reset() / available() / stats() / config()
 */
(function (global) {
  'use strict';

  var KC = global.KC = global.KC || {};

  var STORAGE_KEY = 'keyclicker.mock.config.v1';
  var STATS_INTERVAL_MS = 100;    // 事件节拍：PROTOCOL §6 要求 100ms 合并推送
  var GROWTH_INTERVAL_MS = 200;   // 统计增长节拍：每 200ms 随机增长
  var MAX_STATS_TASKS = 200;

  var state = {
    started: false,
    config: null,
    entries: [],            // entries[pageIndex][taskIndex] = runtime
    seq: 1,
    subs: [],
    statsTimer: 0,
    lastGrowth: 0,
    recording: null,
    grabTimers: [],
    mediaQuery: null
  };

  /* ---------------------------------------------------------------- 小工具 */

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

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function emit(name, data) {
    post({ event: name, data: data });
  }

  function post(msg) {
    var subs = state.subs.slice();
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](msg); } catch (e) { console.warn('[KC.mockHost] 订阅者抛错', e); }
    }
  }

  function fail(code, message) {
    return { __error: { code: code, message: message } };
  }

  function hasWebView() {
    try {
      return !!(global.chrome && global.chrome.webview &&
        typeof global.chrome.webview.postMessage === 'function');
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- 默认 Config */

  function sampleConfig() {
    return {
      version: 3,
      theme: 'dark',
      selectedPage: 0,
      hotkeys: { toggle: 'alt+`', panic: 'f6' },
      window: { alwaysOnTop: false },
      pages: [
        {
          name: '配置 1',
          tasks: [
            { type: 'click', keys: 'ctrl+f9', interval: 100, windowMatch: '', windowMode: 'contains' },
            { type: 'timer', seq: ['f5', '1', '2', 'enter'], minutes: 0, seconds: 10, gap: 200, windowMatch: '记事本', windowMode: 'contains' }
          ]
        },
        {
          name: '配置 2',
          tasks: [
            { type: 'click', keys: 'space', interval: 16, windowMatch: '', windowMode: 'contains' }
          ]
        }
      ]
    };
  }

  function saneTask(raw) {
    raw = (raw && typeof raw === 'object') ? raw : {};
    var type = raw.type === 'timer' ? 'timer' : 'click';
    var t = {
      type: type,
      windowMatch: typeof raw.windowMatch === 'string' ? raw.windowMatch : '',
      windowMode: ['contains', 'exact', 'regex'].indexOf(raw.windowMode) >= 0 ? raw.windowMode : 'contains'
    };
    if (type === 'click') {
      t.keys = typeof raw.keys === 'string' && raw.keys.trim() ? raw.keys.trim() : 'a';
      t.interval = clampInt(raw.interval, 100, 16, 3600000);
    } else {
      t.seq = Array.isArray(raw.seq)
        ? raw.seq.filter(function (s) { return typeof s === 'string' && s.trim(); }).map(function (s) { return s.trim(); })
        : [];
      t.minutes = clampInt(raw.minutes, 0, 0, 1440);
      t.seconds = clampInt(raw.seconds, 10, 0, 59);
      t.gap = clampInt(raw.gap, 200, 16, 3600000);
      if (t.minutes === 0 && t.seconds < 1) t.seconds = 1;
    }
    return t;
  }

  function saneConfig(raw) {
    var sample = sampleConfig();
    if (Array.isArray(raw)) raw = { pages: raw };            // 旧版 v1.1.0 顶层数组
    if (!raw || typeof raw !== 'object') return sample;

    var cfg = {
      version: typeof raw.version === 'number' ? raw.version : 3,
      theme: raw.theme === 'light' ? 'light' : (raw.theme === 'system' ? 'system' : 'dark'),
      selectedPage: clampInt(raw.selectedPage, 0, 0, 9999),
      hotkeys: {
        toggle: (raw.hotkeys && typeof raw.hotkeys.toggle === 'string' && raw.hotkeys.toggle) || sample.hotkeys.toggle,
        panic: (raw.hotkeys && typeof raw.hotkeys.panic === 'string' && raw.hotkeys.panic) || sample.hotkeys.panic
      },
      window: { alwaysOnTop: !!(raw.window && raw.window.alwaysOnTop) },
      pages: []
    };

    var pages = Array.isArray(raw.pages) ? raw.pages : [];
    for (var i = 0; i < pages.length; i++) {
      var p = (pages[i] && typeof pages[i] === 'object') ? pages[i] : {};
      var tasks = Array.isArray(p.tasks) ? p.tasks.map(saneTask) : [];
      cfg.pages.push({
        name: typeof p.name === 'string' && p.name ? p.name : '配置 ' + (i + 1),
        tasks: tasks
      });
    }
    if (!cfg.pages.length) cfg.pages = sample.pages;
    if (cfg.selectedPage >= cfg.pages.length) cfg.selectedPage = 0;
    return cfg;
  }

  /* ---------------------------------------------------------------- 持久化 */

  function readStorage() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[KC.mockHost] 读取 localStorage 失败（已回退默认配置）', e);
      return null;
    }
  }

  function persist() {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
    } catch (e) {
      console.warn('[KC.mockHost] 写入 localStorage 失败（仅内存生效）', e);
    }
  }

  /* ---------------------------------------------------------------- 运行时 */

  function fingerprint(task) {
    task = task || {};
    if (task.type === 'timer') return 'timer|' + (Array.isArray(task.seq) ? task.seq.join(',') : '');
    return 'click|' + (task.keys || '');
  }

  function makeEntry(task) {
    return {
      id: 't_' + (state.seq++),
      fingerprint: fingerprint(task),
      state: 'idle',
      count: 0,
      elapsedMs: 0
    };
  }

  function rebuildEntries() {
    state.entries = (state.config.pages || []).map(function (page) {
      return (page.tasks || []).map(function (task) { return makeEntry(task); });
    });
  }

  function reconcileEntries() {
    var pages = state.config.pages || [];
    var next = [];
    for (var p = 0; p < pages.length; p++) {
      var tasks = (pages[p] && Array.isArray(pages[p].tasks)) ? pages[p].tasks : [];
      var prev = state.entries[p] || [];
      var row = [];
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i] || {};
        var fp = fingerprint(task);
        var old = prev[i];
        row.push(old && old.fingerprint === fp ? old : makeEntry(task));
      }
      next.push(row);
    }
    state.entries = next;
  }

  function totalSeconds(task) {
    return Math.max(1, clampInt(task.minutes, 0, 0, 1440) * 60 + clampInt(task.seconds, 10, 0, 59));
  }

  function remainingSeconds(entry, task) {
    if (!task || task.type !== 'timer') return 0;
    var totalMs = totalSeconds(task) * 1000;
    var leftMs = totalMs - (entry.elapsedMs % totalMs);
    return Math.max(0, Math.round(leftMs / 1000));
  }

  function taskAt(pageIndex, index) {
    var page = state.config.pages[pageIndex];
    if (!page || !page.tasks) return null;
    return page.tasks[index] || null;
  }

  function findEntry(id) {
    for (var p = 0; p < state.entries.length; p++) {
      for (var i = 0; i < state.entries[p].length; i++) {
        if (state.entries[p][i].id === id) {
          return { entry: state.entries[p][i], pageIndex: p, index: i, task: taskAt(p, i) };
        }
      }
    }
    return null;
  }

  function snapshot() {
    var out = [];
    for (var p = 0; p < state.entries.length; p++) {
      for (var i = 0; i < state.entries[p].length; i++) {
        var e = state.entries[p][i];
        var task = taskAt(p, i) || {};
        out.push({
          id: e.id,
          pageIndex: p,
          type: task.type === 'timer' ? 'timer' : 'click',
          state: e.state,
          count: e.count,
          remaining: task.type === 'timer' ? remainingSeconds(e, task) : 0,
          windowBlocked: false
        });
      }
    }
    return out.slice(0, MAX_STATS_TASKS);
  }

  function emitStats() {
    emit('task.stats', { tasks: snapshot() });
  }

  function emitState(entry) {
    emit('task.state', { id: entry.id, state: entry.state });
  }

  /* ---------------------------------------------------------------- 统计 tick */

  function tick() {
    var now = Date.now();
    var grow = (now - state.lastGrowth) >= GROWTH_INTERVAL_MS;
    if (grow) state.lastGrowth = now;

    var changed = false;
    for (var p = 0; p < state.entries.length; p++) {
      for (var i = 0; i < state.entries[p].length; i++) {
        var e = state.entries[p][i];
        if (e.state !== 'running') continue;
        var task = taskAt(p, i) || {};

        if (task.type === 'timer') {
          var before = remainingSeconds(e, task);
          var totalMs = totalSeconds(task) * 1000;
          e.elapsedMs += STATS_INTERVAL_MS;
          while (e.elapsedMs >= totalMs) { e.elapsedMs -= totalMs; e.count++; changed = true; }
          if (remainingSeconds(e, task) !== before) changed = true;
        } else if (grow) {
          e.count += randInt(12, 26);
          changed = true;
        }
      }
    }
    if (changed) emitStats();
  }

  function ensureTicking() {
    if (state.statsTimer) return;
    state.statsTimer = global.setInterval(tick, STATS_INTERVAL_MS);
  }

  /* ---------------------------------------------------------------- 键名归一小工具 */

  var MODIFIER_ALIASES = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', windows: 'windows', win: 'windows', super: 'windows', cmd: 'windows', meta: 'windows' };

  var KEY_ALIASES = {
    esc: 'escape', escape: 'escape',
    return: 'enter', enter: 'enter',
    spacebar: 'space', space: 'space',
    tab: 'tab', backspace: 'backspace', del: 'delete', delete: 'delete', ins: 'insert', insert: 'insert',
    home: 'home', end: 'end', pgup: 'page up', pageup: 'page up', 'page up': 'page up',
    pgdn: 'page down', pagedown: 'page down', 'page down': 'page down',
    up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down',
    left: 'left', arrowleft: 'left', right: 'right', arrowright: 'right',
    capslock: 'caps lock', 'caps lock': 'caps lock',
    numlock: 'num lock', 'num lock': 'num lock',
    scrolllock: 'scroll lock', 'scroll lock': 'scroll lock',
    prtscn: 'print screen', printscreen: 'print screen', 'print screen': 'print screen',
    pause: 'pause', menu: 'menu', apps: 'menu', contextmenu: 'menu'
  };

  var SYMBOLS = ['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/'];

  function normalizeToken(token) {
    if (!token) return null;
    var t = String(token).trim().toLowerCase();
    if (!t) return null;
    if (MODIFIER_ALIASES[t]) return MODIFIER_ALIASES[t];
    if (KEY_ALIASES[t]) return KEY_ALIASES[t];
    if (/^[a-z0-9]$/.test(t)) return t;
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) return t;
    if (SYMBOLS.indexOf(t) >= 0) return t;
    return null;
  }

  function parseCombo(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw { code: 'invalid_key', message: '按键不能为空' };
    }
    var raw = text.trim().split('+');
    var keys = [];
    for (var i = 0; i < raw.length; i++) {
      var tok = raw[i].trim();
      if (!tok) continue;
      var norm = normalizeToken(tok);
      if (!norm) throw { code: 'invalid_key', message: '无法识别的键名：' + tok };
      keys.push(norm);
    }
    if (!keys.length) throw { code: 'invalid_key', message: '按键不能为空' };
    var mods = [];
    var mains = [];
    for (var k = 0; k < keys.length; k++) {
      if (MODIFIER_ALIASES[keys[k]]) {
        if (mods.indexOf(keys[k]) < 0) mods.push(keys[k]);
      } else {
        mains.push(keys[k]);
      }
    }
    return { valid: true, normalized: mods.concat(mains).join('+'), keys: mods.concat(mains) };
  }

  /* ---------------------------------------------------------------- 按键录入 */

  function comboFromEvent(ev) {
    var code = ev.code || '';
    var main = null;
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) main = m[1].toLowerCase();
    else if ((m = /^Digit([0-9])$/.exec(code))) main = m[1];
    else if ((m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code))) main = 'f' + m[1];
    else main = normalizeToken(ev.key);
    if (!main) return null;

    var parts = [];
    if (ev.ctrlKey) parts.push('ctrl');
    if (ev.shiftKey) parts.push('shift');
    if (ev.altKey) parts.push('alt');
    if (ev.metaKey) parts.push('windows');
    parts.push(main);
    return parts.join('+');
  }

  function onRecordKeyDown(ev) {
    if (!state.recording) return;
    try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* ignore */ }
    if (ev.repeat) return;

    if (ev.key === 'Escape' || ev.key === 'Esc') {
      finishRecording(state.recording.combos.slice());
      return;
    }

    var combo = comboFromEvent(ev);
    if (!combo) return;                       // 纯修饰键

    state.recording.combos.push(combo);
    emit('record.captured', { combo: combo });

    if (state.recording.mode === 'single') {
      finishRecording([combo]);
    }
  }

  function startRecording(mode) {
    cancelRecording();
    state.recording = { mode: mode === 'sequence' ? 'sequence' : 'single', combos: [] };
    global.addEventListener('keydown', onRecordKeyDown, true);
  }

  function stopRecordingListener() {
    try { global.removeEventListener('keydown', onRecordKeyDown, true); } catch (e) { /* ignore */ }
    state.recording = null;
  }

  function cancelRecording() {
    if (!state.recording) return;
    stopRecordingListener();
  }

  function finishRecording(combos) {
    if (!state.recording) return;
    stopRecordingListener();
    emit('record.finished', { combos: combos || [] });
  }

  /* ---------------------------------------------------------------- 窗口抓取 */

  function clearGrabTimers() {
    for (var i = 0; i < state.grabTimers.length; i++) {
      global.clearInterval(state.grabTimers[i]);
      global.clearTimeout(state.grabTimers[i]);
    }
    state.grabTimers = [];
  }

  function grabStart(args) {
    clearGrabTimers();
    var seconds = clampInt(args && args.seconds, 3, 1, 10);
    var self = !!(args && (args.forceSelf === true || args.reasonSelf === true));
    var left = seconds;
    emit('window.grabTick', { secondsLeft: left });

    var timer = global.setInterval(function () {
      left -= 1;
      if (left > 0) {
        emit('window.grabTick', { secondsLeft: left });
        return;
      }
      global.clearInterval(timer);
      state.grabTimers = [];
      if (self) emit('window.grabResult', { ok: false, reason: 'self', title: 'KeyClicker Next' });
      else emit('window.grabResult', { ok: true, title: '（模拟）记事本 - notepad.exe' });
    }, 1000);
    state.grabTimers.push(timer);
    return { started: true };
  }

  /* ---------------------------------------------------------------- 主题 */

  function systemTheme() {
    try {
      return (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    } catch (e) {
      return 'dark';
    }
  }

  function resolveTheme(theme) {
    return theme === 'system' ? systemTheme() : (theme === 'light' ? 'light' : 'dark');
  }

  function watchSystemTheme() {
    if (state.mediaQuery || !global.matchMedia) return;
    try {
      state.mediaQuery = global.matchMedia('(prefers-color-scheme: dark)');
      var handler = function () {
        if (state.config && state.config.theme === 'system') {
          emit('theme.changed', { theme: systemTheme() });
        }
      };
      if (state.mediaQuery.addEventListener) state.mediaQuery.addEventListener('change', handler);
      else if (state.mediaQuery.addListener) state.mediaQuery.addListener(handler);
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- 命令分发 */

  var WINDOW_TITLES = [
    '记事本 - notepad.exe',
    '计算器 - CalculatorApp.exe',
    '新建标签页 - Google Chrome - chrome.exe',
    '资源管理器 - explorer.exe',
    'KeyClicker Next - KeyClicker.exe'
  ];

  function dispatch(cmd, args) {
    switch (cmd) {
      /* ---- app ---- */
      case 'app.ready':
        return {
          version: '1.0.0-mock',
          configPath: 'D:\\AIproject\\keyclicker-next\\clicker_config.json',
          portable: true,
          theme: resolveTheme(state.config.theme),
          elevated: false,
          win11: true,
          mica: false,
          mock: true
        };
      case 'app.window': return null;
      case 'app.openConfigDir': return null;
      case 'app.openAbout': return null;
      case 'app.setTheme': {
        var theme = args && args.theme;
        if (theme !== 'dark' && theme !== 'light' && theme !== 'system') {
          return fail('invalid_args', '主题只能是 dark / light / system');
        }
        var before = resolveTheme(state.config.theme);
        state.config.theme = theme;
        persist();
        var after = resolveTheme(theme);
        if (after !== before) emit('theme.changed', { theme: after });
        return { theme: after };
      }
      case 'app.setAlwaysOnTop': {
        var on = !!(args && args.on);
        state.config.window.alwaysOnTop = on;
        persist();
        return { on: on };
      }
      case 'app.devtools':
        return fail('internal', 'mock 宿主没有 WebView2 DevTools，请直接按浏览器 F12');
      case 'app.closing': return null;

      /* ---- config ---- */
      case 'config.get': return clone(state.config);
      case 'config.set': {
        if (!args || typeof args.config !== 'object' || !args.config) {
          return fail('invalid_args', 'config.set 缺少 config 参数');
        }
        state.config = saneConfig(args.config);
        reconcileEntries();
        persist();
        return { saved: true };
      }
      case 'config.export':
        return { path: 'D:\\AIproject\\keyclicker-next\\clicker_config.json' };

      /* ---- 任务 ---- */
      case 'task.add': {
        var pageIndex = clampInt(args && args.pageIndex, 0, 0, 9999);
        var page = state.config.pages[pageIndex];
        if (!page) return fail('not_found', '页面不存在：' + pageIndex);
        var spec = (args && args.task && typeof args.task === 'object') ? clone(args.task) : {};
        var entry = makeEntry(spec);
        while (state.entries.length <= pageIndex) state.entries.push([]);
        state.entries[pageIndex].push(entry);
        page.tasks.push(spec);
        emitStats();
        return { id: entry.id };
      }
      case 'task.remove': {
        var hit = findEntry(args && args.id);
        if (!hit) return fail('not_found', '任务不存在：' + (args && args.id));
        state.entries[hit.pageIndex].splice(hit.index, 1);
        if (state.config.pages[hit.pageIndex] && state.config.pages[hit.pageIndex].tasks) {
          state.config.pages[hit.pageIndex].tasks.splice(hit.index, 1);
        }
        emitStats();
        return null;
      }
      case 'task.start':
      case 'task.pause':
      case 'task.resume':
      case 'task.stop': {
        var target = findEntry(args && args.id);
        if (!target) return fail('not_found', '任务不存在：' + (args && args.id));
        var e = target.entry;
        if (cmd === 'task.start') {
          if (e.state !== 'running') { e.state = 'running'; e.elapsedMs = 0; }
        } else if (cmd === 'task.pause') {
          if (e.state === 'running') e.state = 'paused';
        } else if (cmd === 'task.resume') {
          if (e.state === 'paused') e.state = 'running';
        } else {
          e.state = 'idle'; e.count = 0; e.elapsedMs = 0;
        }
        emitState(e);
        emitStats();
        return null;
      }
      case 'task.startAll':
      case 'task.stopAll': {
        var pi = clampInt(args && args.pageIndex, 0, 0, 9999);
        var row = state.entries[pi];
        if (!row) return fail('not_found', '页面不存在：' + pi);
        for (var r = 0; r < row.length; r++) {
          if (cmd === 'task.startAll') {
            if (row[r].state !== 'running') { row[r].state = 'running'; row[r].elapsedMs = 0; }
          } else {
            row[r].state = 'idle'; row[r].count = 0; row[r].elapsedMs = 0;
          }
          emitState(row[r]);
        }
        emitStats();
        return null;
      }
      case 'task.stopEverywhere': {
        for (var sp = 0; sp < state.entries.length; sp++) {
          for (var si = 0; si < state.entries[sp].length; si++) {
            var se = state.entries[sp][si];
            se.state = 'idle'; se.count = 0; se.elapsedMs = 0;
            emitState(se);
          }
        }
        emitStats();
        return null;
      }
      case 'task.list': return { tasks: snapshot() };

      /* ---- 按键 ---- */
      case 'keys.validate':
        return parseCombo(args && args.text);   // 非法直接 throw → reject invalid_key
      case 'record.begin':
        startRecording(args && args.mode);
        return { recording: true };
      case 'record.cancel':
        cancelRecording();
        return { recording: false };

      /* ---- 窗口 ---- */
      case 'window.foreground':
        return { title: '记事本 - notepad.exe', process: 'notepad.exe' };
      case 'window.list':
        return { titles: WINDOW_TITLES.slice() };
      case 'window.grabStart':
        return grabStart(args);

      /* ---- 热键 ---- */
      case 'hotkey.get':
        return { toggle: state.config.hotkeys.toggle, panic: state.config.hotkeys.panic };
      case 'hotkey.set': {
        var toggle = args && args.toggle;
        var panic = args && args.panic;
        var next = {
          toggle: typeof toggle === 'string' && toggle ? parseCombo(toggle).normalized : state.config.hotkeys.toggle,
          panic: typeof panic === 'string' && panic ? parseCombo(panic).normalized : state.config.hotkeys.panic
        };
        state.config.hotkeys = next;
        persist();
        return { toggle: next.toggle, panic: next.panic };
      }

      default:
        return fail('internal', 'mock 宿主未实现命令：' + cmd);
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.id == null) return;
    var id = msg.id;
    var cmd = msg.cmd;
    var args = (msg.args && typeof msg.args === 'object') ? msg.args : {};

    // 异步结算，模拟真实宿主的消息往返
    global.setTimeout(function () {
      var data;
      try {
        data = dispatch(cmd, args);
      } catch (err) {
        var e = (err && typeof err === 'object') ? err : { code: 'internal', message: String(err) };
        post({ id: id, ok: false, error: { code: e.code || 'internal', message: e.message || 'mock 内部错误' } });
        return;
      }
      if (data && data.__error) {
        post({ id: id, ok: false, error: data.__error });
        return;
      }
      post({ id: id, ok: true, data: data === undefined ? null : data });
    }, 0);
  }

  /* ---------------------------------------------------------------- 生命周期 */

  function start() {
    if (state.started) return;
    state.started = true;

    var stored = readStorage();
    state.config = saneConfig(stored || sampleConfig());
    rebuildEntries();
    persist();

    state.lastGrowth = Date.now();
    ensureTicking();
    watchSystemTheme();
  }

  function stop() {
    state.started = false;
    cancelRecording();
    clearGrabTimers();
    if (state.statsTimer) { global.clearInterval(state.statsTimer); state.statsTimer = 0; }
    state.subs.length = 0;
  }

  function create() {
    if (hasWebView()) return null;      // 真宿主优先
    start();
    var mySub = null;

    return {
      isMock: true,
      send: handleMessage,
      onMessage: function (cb) {
        if (typeof cb !== 'function') return;
        mySub = cb;
        state.subs.push(cb);
      },
      dispose: function () {
        var idx = state.subs.indexOf(mySub);
        if (idx >= 0) state.subs.splice(idx, 1);
        mySub = null;
      }
    };
  }

  function reset() {
    try {
      if (global.localStorage) global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* ignore */ }
    stop();
    start();
    return clone(state.config);
  }

  KC.mockHost = {
    available: function () { return !hasWebView(); },
    create: create,
    reset: reset,
    isActive: function () { return state.started; },
    config: function () { return clone(state.config); },
    stats: function () { return snapshot(); },
    sampleConfig: sampleConfig
  };
})(typeof window !== 'undefined' ? window : this);
