/* =============================================================================
   KeyClicker Next —— core.js（ui-foundation）
   全局命名空间：window.KC
   提供：KC.dom / KC.bus / KC.theme / KC.fmt / KC.toast / KC.icon
         KC.dialog / KC.util / KC.ready / KC.boot
   经典脚本（非 module），必须第一个加载。
   ========================================================================== */
(function (window, document) {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.VERSION = '1.0.0';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var hasOwn = Object.prototype.hasOwnProperty;

  function isNode(value) {
    return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !isArray(value) && !isNode(value) &&
      Object.prototype.toString.call(value) === '[object Object]';
  }

  function noop() {}

  /* ===========================================================================
     KC.dom
     =========================================================================== */
  function addClass(el, value) {
    if (value == null || value === false) return;
    if (typeof value === 'string') {
      value.split(/\s+/).forEach(function (name) {
        if (name) el.classList.add(name);
      });
      return;
    }
    if (isArray(value)) {
      value.forEach(function (v) { addClass(el, v); });
      return;
    }
    if (typeof value === 'object') {
      Object.keys(value).forEach(function (name) {
        if (value[name]) el.classList.add(name);
      });
    }
  }

  function camelKey(key) {
    if (key.indexOf('-') < 0) return key;
    return key.replace(/-([a-z])/g, function (m, ch) { return ch.toUpperCase(); });
  }

  function setStyle(el, style) {
    if (style == null) return;
    if (typeof style === 'string') {
      el.style.cssText = style;
      return;
    }
    if (typeof style !== 'object') return;
    Object.keys(style).forEach(function (key) {
      var value = style[key];
      if (value == null) return;
      if (key.indexOf('--') === 0) el.style.setProperty(key, String(value));
      else el.style[camelKey(key)] = value;
    });
  }

  function setDataset(el, data) {
    if (data == null || typeof data !== 'object') return;
    Object.keys(data).forEach(function (key) {
      var value = data[key];
      if (value == null) return;
      el.dataset[camelKey(key)] = String(value);
    });
  }

  function bindEvents(el, map) {
    if (map == null || typeof map !== 'object') return;
    Object.keys(map).forEach(function (type) {
      var handler = map[type];
      var options;
      if (isArray(handler)) {
        options = handler[1];
        handler = handler[0];
      }
      if (typeof handler !== 'function') return;
      el.addEventListener(type, handler, options);
    });
  }

  function setAttributes(el, attrs) {
    if (attrs == null || typeof attrs !== 'object') return;
    Object.keys(attrs).forEach(function (name) {
      var value = attrs[name];
      if (value == null || value === false) return;
      el.setAttribute(name, value === true ? '' : String(value));
    });
  }

  function appendChildren(el, children) {
    if (children == null || children === false) return;
    if (isArray(children)) {
      children.forEach(function (child) { appendChildren(el, child); });
      return;
    }
    if (isNode(children)) {
      el.appendChild(children);
      return;
    }
    if (typeof children === 'function') return;
    el.appendChild(document.createTextNode(String(children)));
  }

  var DOM_PROPS = {
    value: true, checked: true, selected: true, disabled: true, readOnly: true,
    multiple: true, required: true, tabIndex: true, htmlFor: true, indeterminate: true,
    autofocus: true, spellcheck: true
  };

  /**
   * 创建元素。
   * h(tag, attrs?, children?)
   * attrs 支持：class（字符串/数组/对象）、text、html、dataset、style（对象/字符串）、
   *             on（{事件名: 处理函数 | [处理函数, options]}）、attrs（原生属性对象）、
   *             ref（回调，拿到元素）、children（与第三参数合并）、
   *             aria-* / data-* / role / 普通属性 / value、checked 等属性。
   * children 支持：字符串、数字、节点、数组（可嵌套）、null/false 自动忽略。
   */
  function h(tag, attrs, children) {
    if (attrs != null && !isPlainObject(attrs)) {
      children = attrs;
      attrs = null;
    }
    var el = document.createElement(String(tag || 'div'));
    var extraChildren = null;

    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value == null) return;
        switch (key) {
          case 'class':
          case 'className':
            addClass(el, value);
            break;
          case 'text':
            el.textContent = String(value);
            break;
          case 'html':
            el.innerHTML = String(value);
            break;
          case 'dataset':
            setDataset(el, value);
            break;
          case 'style':
            setStyle(el, value);
            break;
          case 'on':
            bindEvents(el, value);
            break;
          case 'attrs':
            setAttributes(el, value);
            break;
          case 'children':
            extraChildren = value;
            break;
          case 'ref':
            if (typeof value === 'function') value(el);
            break;
          default:
            if (hasOwn.call(DOM_PROPS, key)) {
              el[key] = value;
            } else if (key.indexOf('aria-') === 0 || key.indexOf('data-') === 0 || key === 'role') {
              el.setAttribute(key, value === true ? '' : String(value));
            } else if (typeof value === 'function' && key.indexOf('on') === 0 && key.length > 2) {
              el.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (value === true) {
              el.setAttribute(key, '');
            } else if (value === false) {
              /* 布尔属性 false：不设置 */
            } else {
              el.setAttribute(key, String(value));
            }
        }
      });
    }

    if (extraChildren != null) {
      children = children == null ? extraChildren : [children, extraChildren];
    }
    appendChildren(el, children);
    return el;
  }

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function clear(el) {
    if (!el) return el;
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  function on(el, type, handler, options) {
    if (!el || !type || typeof handler !== 'function') return noop;
    el.addEventListener(type, handler, options);
    return function () { el.removeEventListener(type, handler, options); };
  }

  function off(el, type, handler, options) {
    if (!el) return;
    el.removeEventListener(type, handler, options);
  }

  function frag(children) {
    var f = document.createDocumentFragment();
    appendChildren(f, children);
    return f;
  }

  function closest(el, selector) {
    if (!el) return null;
    if (el.closest) return el.closest(selector);
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /* ===========================================================================
     KC.icon —— 16×16 内联 SVG 图标（不引外部图标库）
     =========================================================================== */
  var ICONS = {
    minimize: { sw: 1.2, items: [{ d: 'M3.2 8h9.6' }] },
    maximize: { sw: 1.2, items: [{ d: 'M3.7 3.7h8.6v8.6H3.7z' }] },
    restore: { sw: 1.2, items: [
      { d: 'M5.9 5.9h6.4v6.4H5.9z' },
      { d: 'M3.7 10.1V3.7h6.4' }
    ] },
    close: { sw: 1.2, items: [{ d: 'M4.2 4.2 11.8 11.8' }, { d: 'M11.8 4.2 4.2 11.8' }] },

    sun: { items: [
      { d: 'M8 2.1v1.6M8 12.3v1.6M13.9 8h-1.6M3.7 8H2.1M12.2 3.8l-1.2 1.2M5 11l-1.2 1.2M12.2 12.2 11 11M5 5 3.8 3.8' },
      { tag: 'circle', attrs: { cx: 8, cy: 8, r: 2.4 } }
    ] },
    moon: { items: [
      { d: 'M13 9.6A5.7 5.7 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6Z' }
    ] },
    plus: { items: [{ d: 'M8 3.2v9.6' }, { d: 'M3.2 8h9.6' }] },
    pencil: { items: [
      { d: 'm10.9 2.8 2.3 2.3-8 8-3 .7.7-3z' },
      { d: 'M9.6 4.1 12 6.5' }
    ] },
    trash: { items: [
      { d: 'M2.9 4.4h10.2' },
      { d: 'M6.4 4.4V2.9h3.2v1.5' },
      { d: 'M4.2 4.4l.6 8.3h6.4l.6-8.3' },
      { d: 'M6.7 6.8v3.7M9.3 6.8v3.7' }
    ] },
    chevronDown: { items: [{ d: 'M4 6.4 8 10.4 12 6.4' }] },
    chevronRight: { items: [{ d: 'M6.4 4 10.4 8 6.4 12' }] },
    chevronUp: { items: [{ d: 'M4 9.6 8 5.6 12 9.6' }] },
    check: { items: [{ d: 'M3.4 8.5 6.4 11.4 12.7 5.1' }] },
    info: { items: [
      { tag: 'circle', attrs: { cx: 8, cy: 8, r: 5.7 } },
      { d: 'M8 7.3v3.9' },
      { d: 'M8 5h.01' }
    ] },
    warn: { items: [
      { d: 'M8 2.7 14 13H2Z' },
      { d: 'M8 6.5v3' },
      { d: 'M8 11.2h.01' }
    ] },
    error: { items: [
      { tag: 'circle', attrs: { cx: 8, cy: 8, r: 5.7 } },
      { d: 'M8 4.9v3.8' },
      { d: 'M8 11h.01' }
    ] },
    play: { fill: true, items: [{ d: 'M5.4 3.4 12.4 8 5.4 12.6Z' }] },
    pause: { fill: true, items: [
      { d: 'M4.9 3.4h2.2v9.2H4.9z' },
      { d: 'M8.9 3.4h2.2v9.2H8.9z' }
    ] },
    stop: { fill: true, items: [{ d: 'M4.6 4.6h6.8v6.8H4.6z' }] },
    cursor: { fill: true, items: [{ d: 'M4.7 2.5 12.5 9.7l-3.2.5-1.5 3.3Z' }] },
    timer: { items: [
      { tag: 'circle', attrs: { cx: 8, cy: 8.7, r: 4.9 } },
      { d: 'M8 5.9v3l1.7 1.1' },
      { d: 'M6.4 2.2h3.2' }
    ] },
    keyboard: { items: [
      { d: 'M2.3 4.4h11.4v7.2H2.3z' },
      { d: 'M4.6 6.6h.01M6.8 6.6h.01M9 6.6h.01M11.2 6.6h.01M5.6 9.4h4.8' }
    ] },
    target: { items: [
      { tag: 'circle', attrs: { cx: 8, cy: 8, r: 4.7 } },
      { d: 'M8 1.6v2.1M8 12.3v2.1M13.9 8h-2.1M4.2 8H2.1' },
      { tag: 'circle', attrs: { cx: 8, cy: 8, r: 1.1 } }
    ] },
    folder: { items: [{ d: 'M2.6 4.5h4l1.3 1.6h5.5v6.6H2.6z' }] },
    refresh: { items: [
      { d: 'M13 8a5 5 0 1 1-1.4-3.5' },
      { d: 'M13.2 2.6v2.9h-2.9' }
    ] },
    settings: { items: [
      { d: 'M2.6 5.1h10.8M2.6 10.9h10.8' },
      { tag: 'circle', attrs: { cx: 6, cy: 5.1, r: 1.5 } },
      { tag: 'circle', attrs: { cx: 10, cy: 10.9, r: 1.5 } }
    ] },
    copy: { items: [
      { d: 'M5.6 5.6h7.2v7.2H5.6z' },
      { d: 'M10.4 5.6V3.2H3.2v7.2h2.4' }
    ] },
    dot: { fill: true, items: [{ tag: 'circle', attrs: { cx: 8, cy: 8, r: 2.4 } }] },
    empty: { items: [
      { d: 'M2.9 3.9h10.2v8.2H2.9z' },
      { d: 'M2.9 7.2h10.2' },
      { d: 'M6.1 10.3h3.8' }
    ] }
  };

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        node.setAttribute(key, String(attrs[key]));
      });
    }
    return node;
  }

  function icon(name, options) {
    var spec = ICONS[name] || ICONS.info;
    var size = (options && options.size) || 16;
    var svg = svgEl('svg', {
      viewBox: '0 0 16 16',
      width: size,
      height: size,
      fill: spec.fill ? 'currentColor' : 'none',
      stroke: spec.fill ? 'none' : 'currentColor',
      'stroke-width': spec.sw || 1.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      class: 'kc-icon kc-icon-' + name
    });
    spec.items.forEach(function (item) {
      if (item.tag) {
        svg.appendChild(svgEl(item.tag, item.attrs));
      } else {
        svg.appendChild(svgEl('path', { d: item.d }));
      }
    });
    return svg;
  }

  KC.dom = {
    h: h,
    qs: qs,
    qsa: qsa,
    clear: clear,
    on: on,
    off: off,
    frag: frag,
    closest: closest,
    icon: icon,
    appendChildren: appendChildren
  };
  KC.icon = icon;

  /* ===========================================================================
     KC.util
     =========================================================================== */
  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, wait == null ? 300 : wait);
    };
  }

  function throttle(fn, wait) {
    var last = 0;
    var timer = null;
    return function () {
      var now = Date.now();
      var args = arguments;
      var self = this;
      var remain = wait - (now - last);
      if (remain <= 0) {
        last = now;
        fn.apply(self, args);
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = null;
          last = Date.now();
          fn.apply(self, args);
        }, remain);
      }
    };
  }

  function clamp(value, min, max) {
    var n = Number(value);
    if (isNaN(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var uidSeq = 0;
  function uid(prefix) {
    uidSeq += 1;
    return (prefix || 'kc') + '-' + uidSeq.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  KC.util = {
    debounce: debounce,
    throttle: throttle,
    clamp: clamp,
    escapeHtml: escapeHtml,
    uid: uid,
    noop: noop,
    isNode: isNode,
    isArray: isArray,
    camelKey: camelKey
  };

  /* ===========================================================================
     KC.fmt —— 数字 / 时间格式化
     =========================================================================== */
  function pad(value, length) {
    var str = String(Math.abs(Math.trunc(Number(value) || 0)));
    var len = length || 2;
    while (str.length < len) str = '0' + str;
    return str;
  }

  function group(n) {
    var parts = String(n).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  var fmt = {
    /** 千分位数字，非法值返回 — */
    num: function (value) {
      if (value == null || value === '' || isNaN(Number(value))) return '—';
      var n = Number(value);
      var rounded = Math.round(n * 100) / 100;
      return group(rounded);
    },
    /** 毫秒：<1000 → “100 ms”，否则 “1.5 s” */
    ms: function (value) {
      if (value == null || isNaN(Number(value))) return '—';
      var n = Math.max(0, Math.round(Number(value)));
      if (n < 1000) return n + ' ms';
      return (Math.round((n / 1000) * 100) / 100) + ' s';
    },
    /** 秒 → mm:ss（超过 1 小时为 h:mm:ss） */
    clock: function (value) {
      var total = Math.max(0, Math.round(Number(value) || 0));
      var h = Math.floor(total / 3600);
      var m = Math.floor((total % 3600) / 60);
      var s = total % 60;
      return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
    },
    /** 0~1 或 0~100 → 百分比 */
    pct: function (value, digits) {
      var n = Number(value) || 0;
      var ratio = n <= 1 ? n * 100 : n;
      return (Math.round(ratio * Math.pow(10, digits == null ? 0 : digits)) /
        Math.pow(10, digits == null ? 0 : digits)) + '%';
    },
    /** 时间戳 → HH:mm:ss */
    time: function (value) {
      var d = new Date(Number(value) || Date.now());
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    },
    /** 补齐位数 */
    pad: pad,
    /** 文本截断 */
    truncate: function (text, max) {
      var str = String(text == null ? '' : text);
      if (!max || str.length <= max) return str;
      return str.slice(0, Math.max(0, max - 1)) + '…';
    }
  };
  KC.fmt = fmt;

  /* ===========================================================================
     KC.bus —— 极简事件总线
     =========================================================================== */
  var busMap = Object.create(null);

  var bus = {
    on: function (name, fn) {
      if (!name || typeof fn !== 'function') return noop;
      var list = busMap[name] || (busMap[name] = []);
      list.push(fn);
      return function () { bus.off(name, fn); };
    },
    once: function (name, fn) {
      var off = bus.on(name, function (payload) {
        off();
        fn(payload);
      });
      return off;
    },
    off: function (name, fn) {
      var list = busMap[name];
      if (!list) return;
      if (!fn) {
        delete busMap[name];
        return;
      }
      var index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
      if (!list.length) delete busMap[name];
    },
    emit: function (name, payload) {
      var list = busMap[name];
      if (!list) return;
      list.slice().forEach(function (fn) {
        try {
          fn(payload);
        } catch (err) {
          if (window.console && console.error) {
            console.error('[KC.bus] 事件处理异常：' + name, err);
          }
        }
      });
    },
    listeners: function (name) {
      return (busMap[name] || []).slice();
    }
  };
  KC.bus = bus;

  /* ===========================================================================
     KC.theme —— 深浅主题 + Mica
     =========================================================================== */
  var THEME_KEY = 'kc.theme';

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* file:// 或隐私模式下静默失败 */
    }
  }

  function systemTheme() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        return 'light';
      }
    } catch (err) { /* ignore */ }
    return 'dark';
  }

  var themeState = {
    mode: 'dark',      /* 请求的模式：dark | light | system */
    theme: 'dark',     /* 解析后的实际主题：dark | light */
    systemBound: false
  };

  function normalizeTheme(value) {
    return value === 'light' ? 'light' : 'dark';
  }

  function resolveTheme(mode) {
    if (mode === 'system') return systemTheme();
    return normalizeTheme(mode);
  }

  function suppressTransitions() {
    var root = document.documentElement;
    root.classList.add('kc-no-transition');
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      root.classList.remove('kc-no-transition');
    };
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(finish);
      });
    }
    setTimeout(finish, 160);
  }

  function bindSystemTheme() {
    if (themeState.systemBound) return;
    themeState.systemBound = true;
    try {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var handler = function () {
        if (themeState.mode === 'system') applyTheme('system');
      };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    } catch (err) { /* ignore */ }
  }

  function applyTheme(mode) {
    var requested = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'dark';
    var resolved = resolveTheme(requested);
    var root = document.documentElement;
    var previous = root.getAttribute('data-theme');

    themeState.mode = requested;
    themeState.theme = resolved;
    if (requested === 'system') bindSystemTheme();

    if (previous !== resolved) suppressTransitions();
    root.setAttribute('data-theme', resolved);
    storageSet(THEME_KEY, resolved);

    if (previous !== resolved || requested === 'system') {
      bus.emit('theme:changed', { theme: resolved, mode: requested });
    }
    return resolved;
  }

  KC.theme = {
    /** 应用主题：'dark' | 'light' | 'system'，返回解析后的实际主题 */
    apply: applyTheme,
    /** 当前实际主题 */
    current: function () {
      return normalizeTheme(document.documentElement.getAttribute('data-theme') || themeState.theme);
    },
    /** 当前请求模式（含 system） */
    mode: function () { return themeState.mode; },
    toggle: function () {
      return applyTheme(KC.theme.current() === 'dark' ? 'light' : 'dark');
    },
    /** 系统主题（仅解析） */
    system: systemTheme,
    /** 监听主题变化，返回取消函数 */
    onChange: function (fn) {
      return bus.on('theme:changed', fn);
    },
    /** Mica 开关：宿主支持时传 true，透出窗口背景 */
    setMica: function (enabled) {
      document.documentElement.setAttribute('data-mica', enabled ? 'on' : 'off');
    },
    isMica: function () {
      return document.documentElement.getAttribute('data-mica') === 'on';
    }
  };

  /* ===========================================================================
     KC.toast —— 渲染到 #toasts，自动消失
     =========================================================================== */
  var MAX_TOASTS = 4;
  var toastCount = 0;

  function toastRoot() {
    var root = document.getElementById('toasts');
    if (!root) {
      root = h('div', { id: 'toasts' });
      document.body.appendChild(root);
    }
    if (!root.getAttribute('aria-live')) {
      root.setAttribute('aria-live', 'polite');
      root.setAttribute('aria-atomic', 'false');
    }
    return root;
  }

  function dismissToast(el) {
    if (!el || el.__kcClosing) return;
    el.__kcClosing = true;
    if (el.__kcTimer) clearTimeout(el.__kcTimer);
    el.classList.add('is-out');
    var removed = false;
    var remove = function () {
      if (removed) return;
      removed = true;
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 420);
  }

  var TOAST_ICON = { info: 'info', warn: 'warn', error: 'error', success: 'check' };
  var TOAST_DEFAULT_MS = { info: 3200, warn: 4200, error: 5200, success: 3200 };

  function toast(level, message, options) {
    // 按需求关闭弹窗反馈：不渲染右下角提示，仅保留 API 形状避免调用点报错
    return function dismiss() {};
    // eslint-disable-next-line no-unreachable
    var opts;
    if (level && typeof level === 'object') {
      opts = level;
      message = opts.message;
      level = opts.level;
    } else {
      opts = options || {};
    }

    var normalized = level === 'warning' ? 'warn' : (level || 'info');
    if (!hasOwn.call(TOAST_ICON, normalized)) normalized = 'info';
    if (message == null) message = '';

    var root = toastRoot();
    var existing = Array.prototype.slice.call(root.children);
    while (existing.length >= MAX_TOASTS) {
      var oldest = existing.shift();
      if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest);
    }

    toastCount += 1;
    var el = h('div', {
      class: 'toast ' + normalized,
      role: normalized === 'error' ? 'alert' : 'status',
      dataset: { toastId: 'toast-' + toastCount }
    }, [
      h('span', { class: 'toast-icon' }, [icon(TOAST_ICON[normalized])]),
      h('div', { class: 'toast-body', text: String(message) }),
      h('button', {
        class: 'toast-close',
        type: 'button',
        'aria-label': '关闭提示',
        title: '关闭',
        on: { click: function () { dismissToast(el); } }
      }, [icon('close')])
    ]);

    root.appendChild(el);

    var duration = opts.duration != null ? opts.duration : TOAST_DEFAULT_MS[normalized];
    if (duration > 0) {
      el.__kcTimer = setTimeout(function () { dismissToast(el); }, duration);
      el.addEventListener('mouseenter', function () {
        if (el.__kcTimer) clearTimeout(el.__kcTimer);
        el.__kcTimer = null;
      });
      el.addEventListener('mouseleave', function () {
        if (el.__kcClosing) return;
        el.__kcTimer = setTimeout(function () { dismissToast(el); }, 1400);
      });
    }

    return function dismiss() { dismissToast(el); };
  }

  toast.info = function (message, options) { return toast('info', message, options); };
  toast.warn = function (message, options) { return toast('warn', message, options); };
  toast.error = function (message, options) { return toast('error', message, options); };
  toast.success = function (message, options) { return toast('success', message, options); };
  toast.clear = function () {
    var root = document.getElementById('toasts');
    if (!root) return;
    Array.prototype.slice.call(root.children).forEach(function (child) {
      if (child.parentNode) child.parentNode.removeChild(child);
    });
  };
  KC.toast = toast;

  /* ===========================================================================
     KC.dialog —— 弹层 / 确认框（挂在 #overlay-root）
     =========================================================================== */
  var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  /**
   * 打开对话框。返回 Promise，resolve 为所选 action 的 value（关闭/Esc/遮罩为 null）。
   * options: { title, body(node|string), actions:[{label, kind, value}], closable, narrow, wide, onOpen }
   */
  function openDialog(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var host = document.getElementById('overlay-root') || document.body;
      var previousFocus = document.activeElement;
      var settled = false;
      // 传空数组表示不要底部按钮区；完全不传才给默认「确定」
      var actions = isArray(opts.actions) ? opts.actions : [
        { label: '确定', kind: 'primary', value: true }
      ];

      var actionEls = actions.map(function (action) {
        var kind = action.kind === 'danger' ? 'danger'
          : action.kind === 'primary' ? 'primary' : 'ghost';
        return h('button', {
          class: 'btn ' + kind,
          type: 'button',
          on: {
            click: function () {
              if (typeof action.onClick === 'function') {
                var keepOpen = action.onClick();
                if (keepOpen === true) return; // 例如「应用」按钮：保存但不关闭
              }
              close(action.value !== undefined ? action.value : action.label);
            }
          }
        }, [action.label]);
      });

      function close(value) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.classList.add('is-closing');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          if (previousFocus && typeof previousFocus.focus === 'function') {
            try { previousFocus.focus(); } catch (err) { /* ignore */ }
          }
          resolve(value == null ? null : value);
        }, 130);
      }

      function onKeyDown(event) {
        if (event.key === 'Escape' || event.key === 'Esc') {
          if (opts.closable === false) return;
          event.preventDefault();
          event.stopPropagation();
          close(null);
          return;
        }
        if (event.key !== 'Tab') return;
        var items = focusables(dialog);
        if (!items.length) return;
        var first = items[0];
        var last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

      var bodyNode = null;
      if (opts.body != null) {
        if (isNode(opts.body)) bodyNode = opts.body;
        else bodyNode = h('div', { class: 'dialog-text', text: String(opts.body) });
      }

      var headerChildren = [h('span', { class: 'dialog-title', text: opts.title || '' })];
      if (opts.closable !== false) {
        headerChildren.push(h('button', {
          class: 'btn icon ghost dialog-close',
          type: 'button',
          'aria-label': '关闭',
          title: '关闭',
          on: { click: function () { close(null); } }
        }, [icon('close')]));
      }

      var footerChildren = actionEls;
      if (opts.footerLeft) {
        footerChildren = [h('div', { class: 'grow' }, [opts.footerLeft])].concat(actionEls);
      }

      var dialog = h('div', {
        class: 'dialog' + (opts.narrow ? ' narrow' : opts.wide ? ' wide' : ''),
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': opts.title || '对话框'
      }, [
        h('div', { class: 'dialog-header' }, headerChildren),
        bodyNode ? h('div', { class: 'dialog-body' }, [bodyNode]) : null,
        h('div', { class: 'dialog-footer' }, footerChildren)
      ]);

      var overlay = h('div', {
        class: 'overlay',
        on: {
          mousedown: function (event) {
            if (event.target === overlay && opts.closable !== false) close(null);
          }
        }
      }, [dialog]);

      document.addEventListener('keydown', onKeyDown, true);
      host.appendChild(overlay);

      var firstAction = actionEls[0];
      setTimeout(function () {
        if (firstAction && firstAction.focus) firstAction.focus();
        if (typeof opts.onOpen === 'function') opts.onOpen(dialog);
      }, 0);
    });
  }

  function confirmDialog(options) {
    var opts = options || {};
    return openDialog({
      title: opts.title || '确认操作',
      body: opts.message || '',
      narrow: opts.narrow !== false,
      closable: opts.closable !== false,
      actions: [
        {
          label: opts.okText || '确定',
          kind: opts.danger ? 'danger' : 'primary',
          value: true
        },
        { label: opts.cancelText || '取消', value: false }
      ]
    }).then(function (value) { return value === true; });
  }

  KC.dialog = {
    open: openDialog,
    confirm: confirmDialog,
    closeAll: function () {
      var root = document.getElementById('overlay-root');
      if (!root) return;
      Array.prototype.slice.call(root.children).forEach(function (child) {
        if (child.parentNode) child.parentNode.removeChild(child);
      });
    }
  };

  /* ===========================================================================
     KC.boot —— 启动骨架（#view 内 #boot-view，真实视图出现后自动移除）
     =========================================================================== */
  var bootObserver = null;

  var boot = {
    hide: function () {
      var el = document.getElementById('boot-view');
      if (bootObserver) {
        bootObserver.disconnect();
        bootObserver = null;
      }
      if (el && el.parentNode) el.parentNode.removeChild(el);
    },
    watch: function () {
      var view = document.getElementById('view');
      var el = document.getElementById('boot-view');
      if (!view || !el || typeof window.MutationObserver !== 'function') return;
      bootObserver = new window.MutationObserver(function () {
        var hasContent = Array.prototype.some.call(view.children, function (child) {
          return child !== el;
        });
        if (hasContent) boot.hide();
      });
      bootObserver.observe(view, { childList: true });
    }
  };
  KC.boot = boot;

  /* ===========================================================================
     KC.ready / 初始化
     =========================================================================== */
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }
  KC.ready = ready;

  function initTheme() {
    var root = document.documentElement;
    var attr = root.getAttribute('data-theme');
    var stored = storageGet(THEME_KEY);
    var initial = normalizeTheme(attr === 'light' || attr === 'dark' ? attr : (stored || 'dark'));
    /* index.html 的头部内联脚本已提前设置 data-theme，这里只同步内部状态 */
    themeState.theme = initial;
    themeState.mode = initial;
    root.setAttribute('data-theme', initial);

    /* WebView2 环境默认认为 Mica 可用；宿主可通过 KC.theme.setMica(false) 覆盖 */
    if (window.chrome && window.chrome.webview && !root.hasAttribute('data-mica')) {
      KC.theme.setMica(true);
    }
  }

  function init() {
    initTheme();
    var root = document.getElementById('toasts');
    if (root) {
      root.setAttribute('aria-live', 'polite');
      root.setAttribute('aria-atomic', 'false');
    }
    boot.watch();
    bus.emit('kc:ready', { dom: KC.dom, version: KC.VERSION });
  }

  ready(init);
})(window, document);

/* 键盘事件 → 组合键名（录入兜底：钩子不工作时改由页面捕获） */
(function () {
  var KEY_MAP = {
    " ": "space",
    Enter: "enter",
    Escape: "escape",
    Backspace: "backspace",
    Tab: "tab",
    Delete: "delete",
    Insert: "insert",
    Home: "home",
    End: "end",
    PageUp: "page up",
    PageDown: "page down",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    CapsLock: "caps lock",
    NumLock: "num lock",
    ScrollLock: "scroll lock",
    PrintScreen: "print screen",
    Pause: "pause",
    ContextMenu: "menu",
    "~": "`"
  };
  KC.keys = KC.keys || {};
  KC.keys.comboFromEvent = function (e) {
    if (!e) return "";
    var mods = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.shiftKey) mods.push("shift");
    if (e.altKey) mods.push("alt");
    if (e.metaKey) mods.push("windows");
    var key = e.key;
    if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
      return mods.join("+");
    }
    var name = KEY_MAP[key];
    if (!name) {
      name = String(key).toLowerCase();
      if (name === "unidentified" || name.length > 12) return "";
    }
    mods.push(name);
    return mods.join("+");
  };
  KC.keys.onlyModifiers = function (combo) {
    return !combo || /^(ctrl|shift|alt|windows)(\+(ctrl|shift|alt|windows))*$/.test(combo);
  };
})();
