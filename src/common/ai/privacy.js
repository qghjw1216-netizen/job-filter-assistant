// 发送给第三方 AI 前的隐私脱敏。默认隐去联系方式、个人链接等敏感信息。
// 岗位公司名一般是公开招聘信息，是否发送由设置控制（默认发送以提升分析质量）。

export function redactText(text) {
  let s = String(text || '');
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[邮箱已隐藏]');
  // 手机号（中国大陆）
  s = s.replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu, '[手机号已隐藏]');
  // 微信/QQ/电话等联系方式
  s = s.replace(/(?:微信|WeChat|weixin|QQ|电话|手机|联系方式|VX|vx)\s*[:：]?\s*[A-Za-z0-9_+@.-]{4,}/giu, '[联系方式已隐藏]');
  // 常见个人主页/作品集链接
  s = s.replace(
    /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|behance\.net|dribbble\.com|zhihu\.com|gitee\.com)\/[^\s)]+/giu,
    '[个人链接已隐藏]',
  );
  // 身份证号
  s = s.replace(/(?<!\d)\d{17}[\dXx](?!\d)/gu, '[证件号已隐藏]');
  return s;
}

// 对画像做脱敏拷贝：默认剥离本地展示用的姓名
export function redactProfileForAi(profile, { includeName = false } = {}) {
  const p = JSON.parse(JSON.stringify(profile || {}));
  if (!includeName && p.basics) p.basics.name = '';
  if (p.preference && typeof p.preference.notes === 'string') {
    p.preference.notes = redactText(p.preference.notes);
  }
  if (typeof p.workSummary === 'string') p.workSummary = redactText(p.workSummary);
  if (typeof p.projectSummary === 'string') p.projectSummary = redactText(p.projectSummary);
  return p;
}

// 对岗位做脱敏拷贝
export function redactJobForAi(job, { includeCompany = true } = {}) {
  const j = { ...job };
  delete j.raw;
  delete j.savedAt;
  j.hrName = '';
  if (!includeCompany) {
    j.company = '[公司名已隐藏]';
  }
  if (typeof j.description === 'string') j.description = redactText(j.description).slice(0, 2500);
  return j;
}
