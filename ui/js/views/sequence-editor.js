/* ui/js/views/sequence-editor.js — 按键序列编辑弹层（ui-tasks）
 *
 * 能力：逐个录入（record.begin mode=sequence + record.captured 追加，Esc → record.finished）、
 *       手动逗号分隔输入（ctrl+f9, 1, enter）、清空、保存回调。
 *
 * 用法：
 *   KC.views.sequenceEditor.open({ seq: ['f5'], onSave: function (seq) {} })
 *     .then(function (seq) { if (seq) { ... } });   // 取消/关闭时 resolve(null)
 */
(function () {
  'use strict';

  var KC = window.KC = window.KC || {};
  KC.views = KC.views || {};

  function h(tag, attrs, kids) {
    return KC.dom.h(tag, attrs, kids);
  }

  function toast(level, message) {
    try { KC.toast(level, message); } catch (e) {
      if (window.console) window.console.warn('[sequence-editor] toast', level, message);
    }
  }

  function svg(inner) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" ' +
      'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      inner + '</svg>';
  }

  function errText(err) {
    if (err && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return '操作失败，请重试';
  }

  function overlayRoot() {
    return document.getElementById('overlay-root') || document.body;
  }

  function normalizeSeq(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (item) {
      return String(item == null ? '' : item).trim();
    }).filter(Boolean);
  }

  /* ── 事件：全模块只订阅一次，转发给当前会话 ─────────────────────────── */
  var session = null;
  var bound = false;

  function onHost(name, fn) {
    try { KC.host.on(name, fn); } catch (e) { /* 忽略不支持的事件名 */ }
  }

  function bindHostEvents() {
    if (bound) return;
    bound = true;
    onHost('record.captured', function (data) {
      if (session) session.onCaptured(data || {});
    });
    onHost('record.finished', function (data) {
      if (session) session.onFinished(data || {});
    });
  }

  /* ── 打开弹层 ──────────────────────────────────────────────────────── */
  function open(opts) {
    opts = opts || {};
    bindHostEvents();

    if (session) {
      // 同一时间只允许一个序列编辑器
      session.focus();
      return session.promise;
    }

    var seq = normalizeSeq(opts.seq);
    var recording = false;
    var busy = false;
    var closed = false;
    var resolveFn = null;

    var promise = new Promise(function (resolve) { resolveFn = resolve; });

    /* 头部 */
    var title = h('h2', { class: 'kct-dialog-title', text: '按键序列' });
    var sub = h('span', { class: 'kct-dialog-sub', text: '支持组合键（如 ctrl+f9）；录入时按 Esc 结束' });
    var btnClose = h('button', { class: 'btn icon kct-dialog-close', html: svg('<path d="M4.2 4.2 11.8 11.8"/><path d="M11.8 4.2 4.2 11.8"/>') });
    btnClose.type = 'button';
    btnClose.title = '关闭';
    btnClose.setAttribute('aria-label', '关闭');

    var header = h('div', { class: 'dialog-header kct-dialog-head' }, [
      h('div', { class: 'kct-dialog-headtext' }, [title, sub]),
      btnClose
    ]);

    /* 序列展示 */
    var seqBox = h('div', { class: 'kct-seq-box' });
    var seqCount = h('span', { class: 'kct-seq-count' });

    /* 录入 */
    var recBtn = h('button', { class: 'btn kct-btn-rec', text: '开始录入' });
    recBtn.type = 'button';
    recBtn.title = '逐个按下按键，Esc 结束录入';
    var recHint = h('span', { class: 'field-hint kct-rec-hint', text: '录入会追加到序列末尾' });

    /* 手动输入 */
    var manual = h('input', { class: 'input kct-seq-manual' });
    manual.type = 'text';
    manual.placeholder = '例: a, ctrl+f9, space, enter';
    manual.spellcheck = false;
    manual.setAttribute('aria-label', '手动输入按键序列');

    var btnAppend = h('button', { class: 'btn kct-seq-append', text: '追加到序列' });
    btnAppend.type = 'button';

    var manualRow = h('div', { class: 'kct-seq-manual-row' }, [manual, btnAppend]);
    var manualHint = h('div', { class: 'field-hint', text: '支持逗号分隔批量输入，组合键用 + 连接；无法识别的按键不会加入序列。' });

    /* 底部 */
    var btnClear = h('button', { class: 'btn ghost kct-seq-clear', text: '清空' });
    btnClear.type = 'button';
    var btnCancel = h('button', { class: 'btn ghost kct-seq-cancel', text: '取消' });
    btnCancel.type = 'button';
    var btnSave = h('button', { class: 'btn primary kct-seq-save', text: '保存' });
    btnSave.type = 'button';

    var footer = h('div', { class: 'dialog-footer kct-dialog-foot' }, [
      btnClear,
      h('span', { class: 'kct-dialog-spacer' }),
      btnCancel,
      btnSave
    ]);

    var body = h('div', { class: 'dialog-body kct-dialog-body' }, [
      h('div', { class: 'kct-field-head' }, [
        h('span', { class: 'field-label kct-field-label', text: '当前序列' }),
        seqCount
      ]),
      seqBox,
      h('div', { class: 'kct-rec-row' }, [recBtn, recHint]),
      h('div', { class: 'kct-field-head' }, [
        h('span', { class: 'field-label kct-field-label', text: '或手动输入' })
      ]),
      manualRow,
      manualHint
    ]);

    var dialog = h('div', { class: 'dialog kct-seq-dialog' }, [header, body, footer]);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '按键序列');
    dialog.tabIndex = -1;

    var overlay = h('div', { class: 'overlay kct-overlay kct-seq-overlay' }, [dialog]);

    /* ── 渲染 ── */
    function render() {
      seqBox.textContent = '';
      if (!seq.length) {
        seqBox.appendChild(h('span', { class: 'kct-seq-empty', text: '（空）还没有按键，请录入或手动输入' }));
      } else {
        seq.forEach(function (combo, index) {
          if (index > 0) seqBox.appendChild(h('span', { class: 'kct-seq-arrow', text: '→' }));
          var chip = h('span', { class: 'kct-chip' }, [
            h('span', { class: 'kct-chip-text', text: combo })
          ]);
          var x = h('button', { class: 'kct-chip-x', html: svg('<path d="M4.6 4.6 11.4 11.4"/><path d="M11.4 4.6 4.6 11.4"/>') });
          x.type = 'button';
          x.title = '从序列中移除「' + combo + '」';
          x.setAttribute('aria-label', '移除 ' + combo);
          x.disabled = recording;
          x.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (recording) return;
            seq.splice(index, 1);
            render();
          });
          chip.appendChild(x);
          seqBox.appendChild(chip);
        });
      }
      seqCount.textContent = seq.length ? '共 ' + seq.length + ' 步' : '';
      seqBox.classList.toggle('kct-seq-recording', recording);
      btnClear.disabled = recording || seq.length === 0;
      btnClear.classList.toggle('is-disabled', btnClear.disabled);
      btnSave.disabled = busy;
      btnSave.classList.toggle('is-disabled', busy);
    }

    function setRecording(on) {
      recording = on;
      recBtn.textContent = on ? '停止录入' : '开始录入';
      recBtn.classList.toggle('kct-recording', on);
      recBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      recHint.textContent = on ? '正在录入：逐个按下按键，按 Esc 结束' : '录入会追加到序列末尾';
      manual.disabled = on;
      btnAppend.disabled = on;
      btnAppend.classList.toggle('is-disabled', on);
      if (on) {
        // 录入期间不让输入框抢焦点，避免空格 / 回车误触
        try {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        } catch (e) { /* ignore */ }
      }
      render();
    }

    /* ── 录入 ── */

    function onRecordKeydown(e) {
      if (!recording || closed) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { stopRecording(true); return; }
      var combo = KC.keys.comboFromEvent(e);
      if (KC.keys.onlyModifiers(combo)) return;
      if (session) session.onCaptured({ combo: combo });
    }
    async function startRecording() {
      if (recording || busy) return;
      busy = true;
      try {
        await KC.host.call('record.begin', { mode: 'sequence' });
        busy = false;
        setRecording(true);
        window.addEventListener("keydown", onRecordKeydown, true);
      } catch (err) {
        busy = false;
        setRecording(false);
        toast('error', errText(err) + '（也可以直接在下方手动输入按键名）');
        render();
      }
    }

    async function stopRecording(cancel) {
      if (!recording) return;
      window.removeEventListener("keydown", onRecordKeydown, true);
      setRecording(false);
      if (cancel !== false) {
        try { await KC.host.call('record.cancel', {}); } catch (e) { /* 已结束则忽略 */ }
      }
    }

    recBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (recording) stopRecording(true);
      else startRecording();
    });

    /* ── 手动输入 ── */
    async function appendManual() {
      var raw = String(manual.value || '').trim();
      if (!raw) { manual.focus(); return; }
      var parts = raw.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!parts.length) { manual.focus(); return; }

      btnAppend.disabled = true;
      btnAppend.classList.add('is-disabled');
      var bad = [];
      var added = 0;

      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i];
        try {
          var data = await KC.host.call('keys.validate', { text: part });
          if (data && data.valid === false) {
            bad.push(part + '（' + ((data && data.message) || '无法识别的键名') + '）');
            continue;
          }
          var normalized = data && typeof data.normalized === 'string' && data.normalized ? data.normalized : part.toLowerCase();
          seq.push(normalized);
          added += 1;
        } catch (err) {
          bad.push(part + '（' + errText(err) + '）');
        }
      }

      btnAppend.disabled = recording;
      btnAppend.classList.toggle('is-disabled', recording);
      manual.value = '';
      render();
      if (added) manual.focus();

      if (bad.length) {
        toast('error', '以下按键未加入序列：' + bad.join('；'));
      }
    }

    btnAppend.addEventListener('click', function (ev) {
      ev.preventDefault();
      appendManual();
    });

    manual.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        appendManual();
      }
    });

    /* ── 关闭 ── */
    function cleanup() {
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (session && session.promise === promise) session = null;
      if (recording) {
        // 弹层被关掉时一定要停掉钩子录入
        try { KC.host.call('record.cancel', {}); } catch (e) { /* ignore */ }
        recording = false;
      }
    }

    function finish(result) {
      if (closed) return;
      cleanup();
      if (result && typeof opts.onSave === 'function') {
        try { opts.onSave(result); } catch (e) {
          if (window.console) window.console.error('[sequence-editor] onSave 抛错', e);
        }
      }
      resolveFn(result);
    }

    function requestClose() {
      if (recording) { stopRecording(true); return; }
      finish(null);
    }

    btnCancel.addEventListener('click', function (ev) { ev.preventDefault(); requestClose(); });
    btnClose.addEventListener('click', function (ev) { ev.preventDefault(); requestClose(); });
    overlay.addEventListener('mousedown', function (ev) {
      if (ev.target === overlay) requestClose();
    });

    btnClear.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (recording) return;
      seq = [];
      render();
    });

    btnSave.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (recording) stopRecording(true);
      var cleaned = normalizeSeq(seq);
      if (!cleaned.length) {
        toast('error', '按键序列不能为空，请先录入或手动输入按键');
        manual.focus();
        return;
      }
      finish(cleaned);
    });

    function onKeydown(ev) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      if (recording) {
        // 录制中 Esc = 结束录入（弹层保留）
        stopRecording(true);
        return;
      }
      finish(null);
    }
    document.addEventListener('keydown', onKeydown, true);

    /* ── 组装 ── */
    overlayRoot().appendChild(overlay);
    render();
    session = {
      promise: promise,
      focus: function () { try { dialog.focus(); } catch (e) { /* ignore */ } },
      onCaptured: function (data) {
        if (!recording || closed) return;
        var combo = data && (data.combo || data.keys);
        if (typeof combo !== 'string' || !combo.trim()) return;
        seq.push(combo.trim());
        render();
      },
      onFinished: function (data) {
        if (!recording || closed) return;
        var combos = data && data.combos;
        if (Array.isArray(combos) && combos.length) {
          // 宿主返回完整序列时以它为准，避免重复追加
          seq = normalizeSeq(combos);
        }
        setRecording(false);
        render();
      }
    };
    try { dialog.focus(); } catch (e) { /* ignore */ }

    return promise;
  }

  KC.views.sequenceEditor = { open: open };
})();
