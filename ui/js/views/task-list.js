/* ui/js/views/task-list.js — 任务列表（ui-tasks）
 *
 * 类型图标 / 按键或序列摘要 / 状态徽标 / 统计（次数·剩余秒）/ 窗口不匹配提示 /
 * 暂停·继续·停止·删除 / 空状态。
 *
 * 契约：KC.views.taskList.mount(el, ctx) / .refresh(runtimes)
 * 说明：视图自己订阅 task.stats / task.state（按 id 增量更新，幂等），
 *       main.js 再调 refresh(runtimes) 不会冲突。
 */
(function () {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.views = KC.views || {};

  var MODE_LABELS = { contains: '包含', exact: '精确', regex: '正则' };

  function h(tag, attrs, kids) {
    return KC.dom.h(tag, attrs, kids);
  }

  function toast(level, message) {
    try { KC.toast(level, message); } catch (e) {
      if (window.console) window.console.warn('[task-list] toast', level, message);
    }
  }

  function svg(inner) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" ' +
      'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      inner + '</svg>';
  }

  var ICON = {
    click: '<rect x="2.4" y="4.4" width="11.2" height="7.2" rx="1.6"/><path d="M5.4 8h5.2"/>',
    timer: '<circle cx="8" cy="8.6" r="5.1"/><path d="M8 5.8v2.9l1.9 1.1"/><path d="M6.2 1.9h3.6"/>',
    play: '<path d="M5.6 3.6 12.2 8l-6.6 4.4z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="5" y="3.6" width="2.2" height="8.8" rx=".6" fill="currentColor" stroke="none"/><rect x="8.8" y="3.6" width="2.2" height="8.8" rx=".6" fill="currentColor" stroke="none"/>',
    stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" fill="currentColor" stroke="none"/>',
    trash: '<path d="M3.4 4.8h9.2"/><path d="M6.4 4.8V3.4h3.2v1.4"/><path d="M5 4.8l.6 7.4h4.8l.6-7.4"/><path d="M6.9 7.2v2.8"/><path d="M9.1 7.2v2.8"/>'
  };

  function errText(err) {
    if (err && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return '操作失败，请重试';
  }

  function pad2(n) {
    n = Math.max(0, Number(n) || 0);
    return n < 10 ? '0' + n : String(n);
  }

  function clockText(totalSeconds) {
    var seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return pad2(m) + ':' + pad2(s);
  }

  function fmtNum(value) {
    var n = Number(value) || 0;
    try {
      if (KC.fmt && typeof KC.fmt.num === 'function') return KC.fmt.num(n);
    } catch (e) { /* 退回简单实现 */ }
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function pageIndexOf(ctx) {
    // config.selectedPage 是当前页的权威值；ctx.pageIndex 仅作兜底
    var cfg = KC.state && KC.state.config;
    if (cfg && Number.isInteger(cfg.selectedPage) && cfg.selectedPage >= 0) return cfg.selectedPage;
    if (ctx && Number.isInteger(ctx.pageIndex) && ctx.pageIndex >= 0) return ctx.pageIndex;
    return 0;
  }

  function ensurePage(cfg, pi) {
    if (!cfg || typeof cfg !== 'object') return null;
    if (!Array.isArray(cfg.pages) || !cfg.pages.length) cfg.pages = [{ name: '配置1', tasks: [] }];
    var page = cfg.pages[pi];
    if (!page) page = cfg.pages[pi] = { name: '配置' + (pi + 1), tasks: [] };
    if (!Array.isArray(page.tasks)) page.tasks = [];
    return page;
  }

  function commitConfig(mutator) {
    try {
      return KC.state.update(function (cfg) {
        mutator(cfg || (KC.state && KC.state.config));
      });
    } catch (e) {
      if (window.console) window.console.error('[task-list] 保存配置失败', e);
    }
    return undefined;
  }

  /* ── 宿主事件：模块级只订阅一次，转发给当前挂载实例 ─────────────────── */
  var active = null;
  var bound = false;

  function onHost(name, fn) {
    try { KC.host.on(name, fn); } catch (e) { /* 忽略不支持的事件名 */ }
  }

  function bindHostEvents() {
    if (bound) return;
    bound = true;

    onHost('task.stats', function (data) {
      if (active) active.onStats(data || {});
    });
    onHost('task.state', function (data) {
      if (active) active.onState(data || {});
    });

    try {
      if (KC.state && typeof KC.state.onChange === 'function') {
        KC.state.onChange(function () {
          if (active) active.onConfig();
        });
      }
    } catch (e) { /* ignore */ }
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────── */
  function mount(el, ctx) {
    if (!el) return;
    bindHostEvents();
    ctx = ctx || {};

    var runtimes = [];      // 最近一次全量 task.stats / refresh
    var items = [];         // 当前渲染的 { spec, rt, index }
    var rows = {};          // key -> row 对象
    var order = [];         // key 顺序（用于判断结构变化）
    var busy = false;

    /* 头部 */
    var statText = h('span', { class: 'kct-list-stat' });
    var clearBtn = h('button', { class: 'btn ghost kct-btn-clear', text: '清空' });
    clearBtn.type = 'button';
    clearBtn.title = '停止并删除本页所有任务';

    var card = h('section', { class: 'card kct-card kct-task-card' }, [
      h('div', { class: 'card-header kct-card-head' }, [
        h('div', { class: 'kct-card-headtext' }, [
          h('h2', { class: 'kct-card-title', text: '任务列表' }),
          h('p', { class: 'kct-card-sub', text: '本页任务；运行中可暂停 / 继续 / 停止' })
        ]),
        h('div', { class: 'kct-list-tools' }, [statText, clearBtn])
      ])
    ]);

    var listEl = h('div', { class: 'kct-task-list' });
    var emptyEl = h('div', { class: 'kct-empty' }, [
      h('div', { class: 'kct-empty-ico', html: svg('<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6"/><path d="M5.2 6.4h5.6"/><path d="M5.2 9.2h3.4"/>') }),
      h('div', { class: 'kct-empty-title', text: '暂无任务' }),
      h('div', { class: 'kct-empty-sub', text: '在上方「连点」或「定时序列」卡片里设置参数，然后点「添加到任务列表」' })
    ]);

    var body = h('div', { class: 'card-body kct-task-body' }, [listEl, emptyEl]);
    card.appendChild(body);
    el.appendChild(card);

    /* ── 数据 ── */
    function normalizeRuntimes(input) {
      if (!input) return [];
      if (Array.isArray(input)) return input.filter(Boolean);
      if (Array.isArray(input.tasks)) return input.tasks.filter(Boolean);
      return [];
    }

    function pageRuntimes(pi) {
      return runtimes.filter(function (rt) { return rt && rt.pageIndex === pi; });
    }

    function buildItems() {
      var cfg = KC.state && KC.state.config;
      var pi = pageIndexOf(ctx);
      var page = cfg && cfg.pages && cfg.pages[pi];
      var specs = (page && Array.isArray(page.tasks)) ? page.tasks : [];
      var rtList = pageRuntimes(pi);
      return specs.map(function (spec, index) {
        return {
          spec: spec || {},
          rt: rtList[index] || null,
          index: index
        };
      });
    }

    function rowKey(item) {
      return (item.rt && item.rt.id) ? String(item.rt.id) : ('idx:' + item.index);
    }

    function statusOf(item) {
      var state = item.rt ? item.rt.state : 'idle';
      if (state === 'running') return { key: 'running', text: '● 运行', cls: 'badge success' };
      if (state === 'paused') return { key: 'paused', text: '● 暂停', cls: 'badge warn' };
      return { key: 'idle', text: '○ 停止', cls: 'badge' };
    }

    function specKeys(item) {
      var spec = item.spec || {};
      if (spec.type === 'timer') {
        var seq = Array.isArray(spec.seq) ? spec.seq : [];
        return seq.length ? seq.join(' → ') : '(空序列)';
      }
      return String(spec.keys == null ? '' : spec.keys) || '(未设置按键)';
    }

    function specInfo(item) {
      var spec = item.spec || {};
      if (spec.type === 'timer') {
        var total = (Number(spec.minutes) || 0) * 60 + (Number(spec.seconds) || 0);
        return clockText(total) + ' 触发 · 间隔 ' + (Number(spec.gap) || 0) + ' ms';
      }
      return '间隔 ' + (Number(spec.interval) || 0) + ' ms';
    }

    /* ── 行构建 ── */
    function buildRow(item) {
      var isTimer = item.spec && item.spec.type === 'timer';
      var icon = h('span', {
        class: 'kct-task-ico ' + (isTimer ? 'kct-task-ico-timer' : 'kct-task-ico-click'),
        html: svg(isTimer ? ICON.timer : ICON.click)
      });
      icon.title = isTimer ? '定时序列任务' : '连点任务';
      icon.setAttribute('aria-hidden', 'false');

      var keyEl = h('span', { class: 'kct-task-key' });
      var infoEl = h('span', { class: 'kct-task-info' });
      var winEl = h('div', { class: 'kct-task-win' });
      var main = h('div', { class: 'kct-task-main' }, [
        h('div', { class: 'kct-task-line' }, [keyEl, infoEl]),
        winEl
      ]);

      var statMain = h('span', { class: 'kct-task-stat-main' });
      var statSub = h('span', { class: 'kct-task-stat-sub' });
      var stats = h('div', { class: 'kct-task-stats' }, [statMain, statSub]);

      var badge = h('span', { class: 'badge kct-task-badge' });

      var playBtn = h('button', { class: 'btn icon kct-op kct-op-play', html: svg(ICON.play) });
      playBtn.type = 'button';
      playBtn.title = '开始';
      playBtn.setAttribute('aria-label', '开始或暂停');

      var stopBtn = h('button', { class: 'btn icon kct-op kct-op-stop', html: svg(ICON.stop) });
      stopBtn.type = 'button';
      stopBtn.title = '停止';
      stopBtn.setAttribute('aria-label', '停止');

      var delBtn = h('button', { class: 'btn icon kct-op kct-op-del', html: svg(ICON.trash) });
      delBtn.type = 'button';
      delBtn.title = '删除任务';
      delBtn.setAttribute('aria-label', '删除');

      var ops = h('div', { class: 'kct-task-ops' }, [playBtn, stopBtn, delBtn]);

      var root = h('div', { class: 'kct-task-row' }, [icon, main, stats, badge, ops]);

      var row = {
        key: rowKey(item),
        item: item,
        root: root,
        keyEl: keyEl,
        infoEl: infoEl,
        winEl: winEl,
        statMain: statMain,
        statSub: statSub,
        badge: badge,
        playBtn: playBtn,
        stopBtn: stopBtn,
        delBtn: delBtn,
        playMode: '',
        textCache: {}
      };

      playBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        toggleTask(row);
      });
      stopBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        stopTask(row);
      });
      delBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        deleteTask(row);
      });

      return row;
    }

    function setText(node, value, row, cacheKey) {
      var text = value == null ? '' : String(value);
      if (row && row.textCache[cacheKey] === text) return;
      node.textContent = text;
      if (row) row.textCache[cacheKey] = text;
    }

    function updateRow(row, item) {
      row.item = item;
      var spec = item.spec || {};
      var rt = item.rt || null;
      var status = statusOf(item);
      var blocked = !!(rt && rt.state === 'running' && rt.windowBlocked);

      row.root.dataset.state = status.key;
      row.root.dataset.type = spec.type === 'timer' ? 'timer' : 'click';
      row.root.classList.toggle('kct-row-blocked', blocked);

      // 按钮实际可用性取决于 runtime 是否存在
      var ready = !!(rt && rt.id);
      row.playBtn.disabled = !ready;
      row.stopBtn.disabled = !ready;
      row.playBtn.classList.toggle('is-disabled', !ready);
      row.stopBtn.classList.toggle('is-disabled', !ready);
      row.stopBtn.classList.toggle('kct-op-hidden', !(rt && (rt.state === 'running' || rt.state === 'paused')));

      // 播放按钮：idle → 开始；running → 暂停；paused → 继续
      var mode = status.key === 'running' ? 'pause' : (status.key === 'paused' ? 'resume' : 'play');
      if (row.playMode !== mode) {
        row.playMode = mode;
        row.playBtn.innerHTML = svg(mode === 'pause' ? ICON.pause : ICON.play);
        row.playBtn.title = mode === 'pause' ? '暂停' : (mode === 'resume' ? '继续' : '开始');
        row.playBtn.setAttribute('aria-label', row.playBtn.title);
      }

      // 摘要
      var keyText = specKeys(item);
      setText(row.keyEl, keyText, row, 'key');
      row.keyEl.title = keyText;
      setText(row.infoEl, specInfo(item), row, 'info');

      // 窗口提示
      var pattern = String(spec.windowMatch == null ? '' : spec.windowMatch).trim();
      if (pattern) {
        var label = MODE_LABELS[spec.windowMode] || '包含';
        if (blocked) {
          setText(row.winEl, '窗口不匹配（当前前台窗口未命中，按键未发送）', row, 'win');
          row.winEl.title = '窗口' + label + '：' + pattern;
        } else {
          setText(row.winEl, '窗口' + label + '：' + pattern, row, 'win');
          row.winEl.title = '';
        }
        row.winEl.hidden = false;
        row.winEl.classList.toggle('kct-task-win-warn', blocked);
      } else {
        row.winEl.hidden = true;
        row.winEl.classList.remove('kct-task-win-warn');
      }

      // 统计
      var count = Number(rt ? rt.count : 0) || 0;
      if (spec.type === 'timer') {
        var left = rt && rt.remaining != null ? rt.remaining : ((Number(spec.minutes) || 0) * 60 + (Number(spec.seconds) || 0));
        setText(row.statMain, clockText(left), row, 'statMain');
        setText(row.statSub, fmtNum(count) + ' 次', row, 'statSub');
        row.statMain.title = '本次剩余时间';
      } else {
        setText(row.statMain, fmtNum(count), row, 'statMain');
        setText(row.statSub, '次', row, 'statSub');
        row.statMain.title = '已发送次数';
      }

      // 状态徽标
      setText(row.badge, status.text, row, 'badge');
      var badgeCls = status.cls + ' kct-task-badge' + (blocked ? ' kct-badge-blocked' : '');
      if (row.badge.className !== badgeCls) row.badge.className = badgeCls;
      row.badge.title = blocked ? '窗口不匹配：任务在跑但不会发送按键' : status.text;
    }

    /* ── 渲染 ── */
    function render() {
      items = buildItems();
      var nextOrder = items.map(rowKey);
      var sameStructure = nextOrder.length === order.length && nextOrder.every(function (key, i) { return key === order[i]; });

      if (!sameStructure) {
        listEl.textContent = '';
        rows = {};
        items.forEach(function (item) {
          var row = buildRow(item);
          rows[row.key] = row;
          listEl.appendChild(row.root);
        });
        order = nextOrder;
      }

      items.forEach(function (item) {
        var row = rows[rowKey(item)];
        if (row) updateRow(row, item);
      });

      // 空状态 / 统计
      var has = items.length > 0;
      listEl.hidden = !has;
      emptyEl.hidden = has;
      clearBtn.disabled = !has;
      clearBtn.classList.toggle('is-disabled', !has);

      var running = items.filter(function (item) { return item.rt && item.rt.state === 'running'; }).length;
      var text = has ? ('共 ' + items.length + ' 个任务 · ' + running + ' 运行中') : '共 0 个任务';
      if (statText.textContent !== text) statText.textContent = text;
    }

    /* ── 操作 ── */
    async function toggleTask(row) {
      var item = row.item;
      var rt = item && item.rt;
      if (!rt || !rt.id) {
        toast('warn', '任务尚未就绪，请稍候重试');
        return;
      }
      try {
        if (rt.state === 'running') {
          await KC.host.call('task.pause', { id: rt.id });
          rt.state = 'paused';
        } else if (rt.state === 'paused') {
          await KC.host.call('task.resume', { id: rt.id });
          rt.state = 'running';
        } else {
          await KC.host.call('task.start', { id: rt.id });
          rt.state = 'running';
        }
        render();
      } catch (err) {
        toast('error', errText(err));
      }
    }

    async function stopTask(row) {
      var rt = row.item && row.item.rt;
      if (!rt || !rt.id) return;
      try {
        await KC.host.call('task.stop', { id: rt.id });
        rt.state = 'idle';
        rt.count = rt.count;
        rt.remaining = rt.remaining;
        render();
      } catch (err) {
        toast('error', errText(err));
      }
    }

    async function deleteTask(row) {
      if (busy) return;
      busy = true;
      var item = row.item;
      var rt = item && item.rt;
      try {
        if (rt && rt.id) {
          if (rt.state !== 'idle') {
            try { await KC.host.call('task.stop', { id: rt.id }); } catch (e) { /* 已停止 */ }
          }
          await KC.host.call('task.remove', { id: rt.id });
        }
        var cfg = KC.state && KC.state.config;
        var pi = pageIndexOf(ctx);
        commitConfig(function (next) {
          var page = ensurePage(next, pi);
          if (!page) return;
          // 用当前渲染顺序删除（避免索引漂移）
          var idx = item.index;
          if (idx >= 0 && idx < page.tasks.length) page.tasks.splice(idx, 1);
        });
        // 本地 runtime 同步移除，避免等下一次 stats 才消失
        if (rt && rt.id) {
          runtimes = runtimes.filter(function (x) { return !(x && x.id === rt.id); });
        }
        render();
        toast('info', '已删除任务');
      } catch (err) {
        toast('error', errText(err));
      } finally {
        busy = false;
      }
    }

    async function clearAll() {
      if (busy) return;
      if (!items.length) return;
      var confirmed = false;
      try {
        confirmed = await KC.dialog.confirm({
          title: '清空任务列表',
          message: '确定清空本页全部任务吗？运行中的任务会先停止，该操作不可撤销。',
          okText: '清空',
          cancelText: '取消',
          danger: true
        });
      } catch (e) {
        confirmed = false;
      }
      if (!confirmed) return;
      busy = true;
      var snapshot = items.slice();
      try {
        for (var i = 0; i < snapshot.length; i += 1) {
          var rt = snapshot[i].rt;
          if (!rt || !rt.id) continue;
          if (rt.state !== 'idle') {
            try { await KC.host.call('task.stop', { id: rt.id }); } catch (e) { /* ignore */ }
          }
          await KC.host.call('task.remove', { id: rt.id });
        }
        var pi = pageIndexOf(ctx);
        commitConfig(function (next) {
          var page = ensurePage(next, pi);
          if (page) page.tasks = [];
        });
        runtimes = [];
        render();
        toast('info', '已清空本页任务');
      } catch (err) {
        toast('error', errText(err));
      } finally {
        busy = false;
      }
    }

    clearBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      clearAll();
    });

    /* ── 对外事件入口 ── */
    var api = {
      onStats: function (data) {
        runtimes = normalizeRuntimes(data.tasks || data);
        render();
      },
      onState: function (data) {
        if (!data || !data.id) return;
        var found = false;
        runtimes.forEach(function (rt) {
          if (rt && rt.id === data.id) {
            rt.state = data.state;
            found = true;
          }
        });
        if (!found && data.state) {
          // 还没有 runtime 时先记下（等待下一次 stats 补全其余字段）
          runtimes.push({ id: data.id, pageIndex: pageIndexOf(ctx), state: data.state });
        }
        render();
      },
      onConfig: function () {
        render();
      }
    };

    active = api;
    render();

    card.__kctUnmount = function () {
      if (active === api) active = null;
    };
  }

  function refresh(runtimes) {
    if (active) active.onStats({ tasks: runtimes && runtimes.tasks ? runtimes.tasks : runtimes });
  }

  KC.views.taskList = { mount: mount, refresh: refresh };
})();
