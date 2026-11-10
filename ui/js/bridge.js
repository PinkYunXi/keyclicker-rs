/*!
 * KeyClicker Next — ui/js/bridge.js
 * 归属：ui-bridge。实现 docs/PROTOCOL.md 的 JS 侧（宿主 ↔ UI 传输层）。
 *
 * 对外接口（docs/UI_CONTRACT.md §4）：
 *   await KC.host.init()            -> Promise<app.ready 的 data>
 *   KC.host.call(cmd, args)         -> Promise<data>；失败 reject {code, message}
 *   KC.host.on(eventName, fn)       -> 取消订阅函数
 *   KC.host.off(eventName, fn)      -> void
 *   KC.host.isMock()                -> boolean
 * 附加（非契约，调试用）：KC.host.dispose() / KC.host.readyInfo() / KC.host.uiVersion
 *
 * 实现要点：
 *   1. 请求 id 从 1 递增，同一个 id 只结算一次；5 秒未响应 reject {code:'timeout'}。
 *   2. 宿主 ok:false 统一 reject {code, message}（宿主 message 是中文人话，可直接展示）。
 *   3. init 完成前（以及 ready 后的下一个宏任务前）到达的事件先入队，init 后按序补发，
 *      这样 main.js 即使“await init() 之后再订阅”也不会丢事件。
 *   4. 传输层：window.chrome.webview 优先；缺失则交给 KC.mockHost（mock-host.js）。
 */
(function (global) {
  'use strict';

  var KC = global.KC = global.KC || {};

  var UI_VERSION = '1.0.0';
  var REQUEST_TIMEOUT_MS = 5000;

  var transport = null;
  var requestSeq = 0;
  var pending = Object.create(null);      // id -> {resolve, reject, timer, cmd}
  var listeners = Object.create(null);    // eventName -> [fn]
  var eventQueue = [];                    // [{name, data}] init 前缓存
  var flushTimer = 0;
  var flushDone = false;                  // 首次补发完成，之后事件直通
  var initialized = false;
  var initPromise = null;
  var initError = null;
  var readyInfo = null;

  /* ---------------------------------------------------------------- 错误归一 */

  function makeError(code, message) {
    return { code: code || 'internal', message: message || '宿主返回了未知错误' };
  }

  function normalizeError(err, fallbackCode) {
    if (err && typeof err === 'object') {
      return makeError(
        typeof err.code === 'string' && err.code ? err.code : (fallbackCode || 'internal'),
        typeof err.message === 'string' && err.message ? err.message : '宿主返回了未知错误'
      );
    }
    if (typeof err === 'string' && err) return makeError(fallbackCode || 'internal', err);
    return makeError(fallbackCode || 'internal', '宿主返回了未知错误');
  }

  function warn() {
    try {
      console.warn.apply(console, ['[KC.host]'].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* 极端环境下 console 不可用，忽略 */ }
  }

  /* ---------------------------------------------------------------- 事件分发 */

  function invoke(fn, payload, name) {
    try {
      fn(payload);
    } catch (e) {
      warn('事件处理抛错：' + name, e);
    }
  }

  function emitEvent(name, data) {
    var list = listeners[name];
    if (list && list.length) {
      list = list.slice();                       // 允许回调里反订阅
      for (var i = 0; i < list.length; i++) invoke(list[i], data, name);
    }
    var any = listeners['*'];
    if (any && any.length) {
      any = any.slice();
      for (var j = 0; j < any.length; j++) invoke(any[j], { event: name, data: data }, name);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = global.setTimeout(flushEvents, 0);
  }

  function flushEvents() {
    flushTimer = 0;
    if (!initialized) return;                   // 还没 ready，继续攒着
    flushDone = true;
    var queue = eventQueue;
    eventQueue = [];
    for (var i = 0; i < queue.length; i++) emitEvent(queue[i].name, queue[i].data);
    if (eventQueue.length) scheduleFlush();      // 补发期间又进来的（理论不会）
  }

  function deliverEvent(name, data) {
    if (!initialized || !flushDone) {
      eventQueue.push({ name: name, data: data });
      scheduleFlush();
      return;
    }
    emitEvent(name, data);
  }

  /* ---------------------------------------------------------------- 请求/响应 */

  function rawRequest(cmd, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!transport) {
        reject(makeError('webview_init', '宿主桥接未初始化'));
        return;
      }
      var id = ++requestSeq;
      var ttl = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : REQUEST_TIMEOUT_MS;
      var timer = global.setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        reject(makeError('timeout', '宿主响应超时（' + Math.round(ttl / 1000) + ' 秒）：' + cmd));
      }, ttl);

      pending[id] = { resolve: resolve, reject: reject, timer: timer, cmd: cmd };

      try {
        transport.send({ id: id, cmd: cmd, args: args == null ? {} : args });
      } catch (e) {
        global.clearTimeout(timer);
        delete pending[id];
        reject(makeError('internal', '消息发送失败：' + (e && e.message ? e.message : e)));
      }
    });
  }

  function settle(msg) {
    var entry = pending[msg.id];
    if (!entry) {
      warn('收到未知或已超时的响应 id=' + msg.id);
      return;
    }
    delete pending[msg.id];
    global.clearTimeout(entry.timer);
    if (msg.ok === true) {
      entry.resolve(msg.data === undefined ? null : msg.data);
    } else {
      entry.reject(normalizeError(msg.error, 'internal'));
    }
  }

  function handleMessage(raw) {
    var msg = raw;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (e) { warn('无法解析宿主消息', raw); return; }
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.id != null && (msg.ok === true || msg.ok === false)) { settle(msg); return; }
    if (typeof msg.event === 'string' && msg.event) {
      deliverEvent(msg.event, msg.data === undefined ? null : msg.data);
      return;
    }
    warn('无法识别的宿主消息', msg);
  }

  /* ---------------------------------------------------------------- 传输层 */

  function hasWebView() {
    try {
      return !!(global.chrome && global.chrome.webview &&
        typeof global.chrome.webview.postMessage === 'function' &&
        typeof global.chrome.webview.addEventListener === 'function');
    } catch (e) {
      return false;
    }
  }

  function createWebViewTransport() {
    var webview = global.chrome.webview;
    var subs = [];

    function onMessage(ev) {
      var data = ev && ev.data;
      for (var i = 0; i < subs.length; i++) {
        try { subs[i](data); } catch (e) { warn('传输层回调抛错', e); }
      }
    }

    webview.addEventListener('message', onMessage);

    return {
      isMock: false,
      send: function (msg) { webview.postMessage(msg); },
      onMessage: function (cb) { if (typeof cb === 'function') subs.push(cb); },
      dispose: function () {
        try { webview.removeEventListener('message', onMessage); } catch (e) { /* ignore */ }
        subs.length = 0;
      }
    };
  }

  // wry（Rust 版）通道：宿主注入 window.__kcWryBridge，底层走 window.ipc
  function hasWry() {
    try {
      return !!(global.__kcWryBridge && typeof global.__kcWryBridge.send === 'function');
    } catch (e) {
      return false;
    }
  }

  function createWryTransport() {
    var bridge = global.__kcWryBridge;
    var subs = [];
    if (typeof bridge.onMessage === 'function') {
      bridge.onMessage(function (ev) {
        var data = ev && ev.data;
        for (var i = 0; i < subs.length; i++) {
          try { subs[i](data); } catch (e) { warn('传输层回调抛错', e); }
        }
      });
    }
    return {
      isMock: false,
      send: function (msg) { bridge.send(msg); },
      onMessage: function (cb) { if (typeof cb === 'function') subs.push(cb); },
      dispose: function () { subs.length = 0; }
    };
  }

  function createTransport() {
    if (hasWry()) return createWryTransport();
    if (hasWebView()) return createWebViewTransport();
    var mock = KC.mockHost;
    if (mock && typeof mock.create === 'function') {
      var t = mock.create();
      if (t) { t.isMock = true; return t; }
    }
    return null;
  }

  /* ---------------------------------------------------------------- 公共 API */

  function init() {
    if (initPromise) return initPromise;
    initError = null;

    initPromise = Promise.resolve().then(function () {
      var t = createTransport();
      if (!t) throw makeError('webview_init', '未检测到 WebView2 宿主，且 mock 宿主不可用');
      transport = t;
      t.onMessage(handleMessage);
      // PROTOCOL §8：UI 就绪后立即发 app.ready（带 UI 版本号）
      return rawRequest('app.ready', { uiVersion: UI_VERSION });
    }).then(function (data) {
      readyInfo = (data && typeof data === 'object') ? data : {};
      initialized = true;
      scheduleFlush();
      return readyInfo;
    }, function (err) {
      initError = normalizeError(err, 'webview_init');
      throw initError;
    });

    return initPromise;
  }

  function call(cmd, args) {
    if (typeof cmd !== 'string' || !cmd) {
      return Promise.reject(makeError('invalid_args', '命令名不能为空'));
    }
    if (args != null && typeof args !== 'object') {
      return Promise.reject(makeError('invalid_args', '命令参数必须是对象：' + cmd));
    }
    if (initialized) return rawRequest(cmd, args);
    if (initError) return Promise.reject(makeError(initError.code, initError.message));
    if (initPromise) {
      return initPromise.then(function () { return rawRequest(cmd, args); });
    }
    // 视图可能在 main 之前调用：按需自动初始化，避免直接炸
    return init().then(function () { return rawRequest(cmd, args); });
  }

  function on(name, fn) {
    if (typeof name !== 'string' || !name) throw new TypeError('KC.host.on(eventName, fn)：eventName 必须是非空字符串');
    if (typeof fn !== 'function') throw new TypeError('KC.host.on(eventName, fn)：fn 必须是函数');
    (listeners[name] || (listeners[name] = [])).push(fn);
    return function unsubscribe() { off(name, fn); };
  }

  function off(name, fn) {
    var list = listeners[name];
    if (!list) return;
    if (!fn) { delete listeners[name]; return; }
    var idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
    if (!list.length) delete listeners[name];
  }

  function isMock() {
    if (transport) return !!transport.isMock;
    return !hasWebView();
  }

  function dispose() {
    var ids = Object.keys(pending);
    for (var i = 0; i < ids.length; i++) {
      var entry = pending[ids[i]];
      global.clearTimeout(entry.timer);
      entry.reject(makeError('internal', '桥接已释放：' + entry.cmd));
    }
    pending = Object.create(null);

    if (transport && typeof transport.dispose === 'function') {
      try { transport.dispose(); } catch (e) { warn('释放传输层失败', e); }
    }
    transport = null;
    initialized = false;
    flushDone = false;
    eventQueue.length = 0;
    if (flushTimer) { global.clearTimeout(flushTimer); flushTimer = 0; }
    initPromise = null;
    initError = null;
    readyInfo = null;
  }

  KC.host = {
    uiVersion: UI_VERSION,
    timeoutMs: REQUEST_TIMEOUT_MS,
    init: init,
    call: call,
    on: on,
    off: off,
    isMock: isMock,
    dispose: dispose,
    readyInfo: function () { return readyInfo; }
  };
})(typeof window !== 'undefined' ? window : this);
