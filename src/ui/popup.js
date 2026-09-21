import { MSG, MODE, PLATFORM_META } from '../common/constants.js';
import { send, h, toast } from './ui-common.js';

const app = document.getElementById('app');
let settings = null;
let jobs = [];
let ctx = { platform: null, platformName: '' };

async function boot() {
  try {
    [settings, jobs, ctx] = await Promise.all([
      send(MSG.SETTINGS_GET),
      send(MSG.JOB_LIST_REQUEST),
      send(MSG.ACTIVE_CONTEXT_REQUEST),
    ]);
  } catch (e) {
    app.innerHTML = `<div class="empty"><div class="icon">⚠️</div>后台未就绪，请重载扩展<br><span class="tiny">${e.message}</span></div>`;
    return;
  }
  render();
}

function render() {
  app.innerHTML = '';
  const scored = jobs.filter((j) => j.match).length;
  const strong = jobs.filter((j) => j.match && (j.match.verdict === 'strong' || j.match.verdict === 'good')).length;

  // header
  app.appendChild(
    h('div', { class: 'popup-header' }, [
      h('div', { class: 'popup-logo', text: '🎯' }),
      h('div', {}, [
        h('div', { class: 'popup-title', text: '岗位筛选助手' }),
        h('div', { class: 'popup-sub', text: 'BOSS直聘 · 前程无忧' }),
      ]),
    ]),
  );

  // 当前站点上下文
  const onSite = !!ctx.platform;
  app.appendChild(
    h('div', { class: 'ctx-pill' }, [
      h('span', { class: 'ctx-dot' + (onSite ? ' on' : '') }),
      h('span', { text: onSite ? `当前：${ctx.platformName}（正在监听）` : '当前不在招聘站点' }),
    ]),
  );

  // 模式切换
  app.appendChild(
    h('div', { class: 'mode-seg' }, [
      segmented(
        [
          { v: MODE.auto, label: '自动' },
          { v: MODE.boss, label: 'BOSS' },
          { v: MODE.qcwy, label: '51job' },
        ],
        settings.mode,
        async (v) => {
          settings = await send(MSG.SETTINGS_SAVE, { patch: { mode: v } });
          render();
        },
      ),
    ]),
  );

  // 统计
  app.appendChild(
    h('div', { class: 'stat-grid' }, [
      stat(jobs.length, '已收录岗位'),
      stat(scored, '已 AI 分析'),
    ]),
  );
  if (scored > 0) {
    app.appendChild(
      h('div', { class: 'stat-grid' }, [
        stat(strong, '较匹配以上'),
        stat(jobs.filter((j) => j.star).length, '已收藏'),
      ]),
    );
  }

  // 开关
  app.appendChild(
    toggle('自动收录', '浏览时抓取岗位', settings.autoCapture, async (val) => {
      settings = await send(MSG.SETTINGS_SAVE, { patch: { autoCapture: val } });
    }),
  );
  app.appendChild(
    toggle('自动分析', '收录后自动 AI 打分（耗 token）', settings.autoScore, async (val) => {
      settings = await send(MSG.SETTINGS_SAVE, { patch: { autoScore: val } });
    }),
  );

  // 操作
  app.appendChild(
    h('div', { class: 'popup-actions' }, [
      h('button', {
        class: 'btn btn-primary btn-block',
        text: '📋 打开岗位面板',
        onclick: openSidePanel,
      }),
      h('button', {
        class: 'btn btn-block',
        text: '⚙️ 画像与设置',
        onclick: () => send(MSG.OPEN_OPTIONS).then(() => window.close()),
      }),
    ]),
  );
}

function stat(num, lbl) {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'num', text: String(num) }),
    h('div', { class: 'lbl', text: lbl }),
  ]);
}

function toggle(label, desc, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked).catch((e) => toast(e.message, true)));
  return h('div', { class: 'toggle-row' }, [
    h('div', {}, [
      h('div', { class: 't-label', text: label }),
      h('div', { class: 't-desc', text: desc }),
    ]),
    h('label', { class: 'switch' }, [input, h('span', { class: 'slider' })]),
  ]);
}

function segmented(options, current, onPick) {
  const seg = h('div', { class: 'segmented' });
  for (const o of options) {
    seg.appendChild(
      h('button', {
        class: o.v === current ? 'active' : '',
        text: o.label,
        onclick: () => onPick(o.v),
      }),
    );
  }
  return seg;
}

async function openSidePanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    }
  } catch (e) {
    toast('请点击工具栏图标打开侧边栏', true);
  }
}

boot();
