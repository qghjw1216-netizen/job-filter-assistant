// UI 层共享小工具：消息封装、DOM 构造、toast、转义。
import { VERDICT_LABELS } from '../common/ai/prompts.js';

// 向 background 发消息，抛错友好。
// 带超时：MV3 service worker 可能在长任务中被回收，导致回调永不触发。
// 超时后 reject，避免上层 await 永久挂起（进而卡住 batchBusy 之类的状态）。
export function send(type, extra = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('操作超时（后台无响应），请重试')),
      timeoutMs,
    );
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return finish(reject, new Error(err.message));
        if (!resp) return finish(reject, new Error('无响应（后台可能未就绪）'));
        if (!resp.ok) return finish(reject, new Error(resp.error || '操作失败'));
        finish(resolve, resp.data);
      });
    } catch (e) {
      finish(reject, e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    // 布尔属性（disabled/checked/hidden…）：HTML 里「有该属性即生效」，与值无关。
    // 所以 v===false 必须「不设置」，否则 disabled="false" 反而把按钮禁用了。
    else if (v === false) continue;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

let toastEl = null;
let toastTimer = null;
export function toast(message, isError = false) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast' + (isError ? ' err' : '');
  }, 2600);
}

export function verdictLabel(v) {
  return VERDICT_LABELS[v] || '';
}

// 逗号/换行分隔字符串 <-> 数组
export function toList(str) {
  return String(str || '')
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
export function fromList(arr) {
  return Array.isArray(arr) ? arr.join('、') : '';
}

// 防抖
export function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
