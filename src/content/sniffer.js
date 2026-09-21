// MAIN world 嗅探器：劫持 fetch / XHR，捕获 BOSS / 51job 的岗位接口 JSON 响应，
// 通过 window.postMessage 转发给 ISOLATED world 的 collector。
// 不改请求、不碰令牌/WAF —— 只被动读取页面自己发出的请求的响应。
(function () {
  const FLAG = '__jobHelperSnifferInstalled';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const CHANNEL = 'job-helper:sniffer';

  // 与 common/platforms.js 的 matchPlatformApi 保持一致（此处为独立副本）
  function matchApi(urlStr) {
    let u;
    try {
      u = new URL(urlStr, location.href);
    } catch {
      return null;
    }
    const host = u.hostname;
    const path = u.pathname;
    if (/(^|\.)zhipin\.com$/i.test(host)) {
      // 列表 + 详情/卡片（点开某个岗位时触发，用于识别「当前岗位」）
      if (/\/wapi\/zpgeek\/(search\/joblist|pc\/recommend\/job\/list|mobile\/search\/joblist|job\/detail(?:\/[a-z]+)?|job\/card|geek\/job\/detail)\.json/.test(path)) {
        return 'boss';
      }
    }
    if (/(^|\.)51job\.com$/i.test(host)) {
      if (/\/api\/job\/(search-(pc|h5)|detail)/.test(path)) return 'qcwy';
    }
    return null;
  }

  function post(platform, url, payload) {
    try {
      window.postMessage({ source: CHANNEL, platform, url, payload }, location.origin);
    } catch {}
  }

  // —— fetch ——
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      const promise = origFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const platform = matchApi(url);
        if (platform) {
          promise
            .then((res) => res.clone().json().then((data) => post(platform, url, data)))
            .catch(() => {});
        }
      } catch {}
      return promise;
    };
  }

  // —— XHR ——
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (...args) {
    this.__jhUrl = String(args[1] ?? '');
    return origOpen.apply(this, args);
  };
  proto.send = function (...args) {
    const url = this.__jhUrl || '';
    const platform = url && matchApi(url);
    if (platform) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(String(this.responseText));
          post(platform, url, data);
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };
})();
