// 本地岗位筛选（不消耗 AI）：关键词、薪资、城市、经验、学历、屏蔽公司、风险词标注。
// 用于在 AI 打分之前先粗筛，或在列表里即时过滤。

// 对单个岗位应用筛选，返回 { keep, matchedInclude[], matchedExclude[], risks[], reasons[] }
export function evaluateJob(job, filters) {
  const f = filters || {};
  const hay = buildHaystack(job);
  const result = { keep: true, matchedInclude: [], matchedExclude: [], risks: [], reasons: [] };

  // 屏蔽公司
  const company = (job.company || '').toLowerCase();
  for (const c of arr(f.excludeCompanies)) {
    if (c && company.includes(c.toLowerCase())) {
      result.keep = false;
      result.reasons.push(`公司被屏蔽：${c}`);
    }
  }

  // 排除关键词（命中即弃）
  for (const kw of arr(f.keywordsExclude)) {
    if (kw && hay.includes(kw.toLowerCase())) {
      result.matchedExclude.push(kw);
      result.keep = false;
      result.reasons.push(`命中排除词：${kw}`);
    }
  }

  // 包含关键词（有配置时，须命中任一）
  const inc = arr(f.keywordsInclude);
  if (inc.length) {
    const hit = inc.filter((kw) => kw && hay.includes(kw.toLowerCase()));
    result.matchedInclude = hit;
    if (hit.length === 0) {
      result.keep = false;
      result.reasons.push('未命中任何包含关键词');
    }
  }

  // 城市
  const cities = arr(f.cities);
  if (cities.length) {
    const jc = (job.city || '') + (job.district || '');
    const hit = cities.some((c) => c && jc.includes(c));
    if (!hit) {
      result.keep = false;
      result.reasons.push('城市不匹配');
    }
  }

  // 薪资（岗位薪资区间与期望有交集即可）
  if (num(f.salaryMinK) || num(f.salaryMaxK)) {
    const jobMin = num(job.salaryMinK) ? job.salaryMinK : null;
    const jobMax = num(job.salaryMaxK) ? job.salaryMaxK : null;
    if (jobMin != null || jobMax != null) {
      const wantMin = num(f.salaryMinK) ? f.salaryMinK : 0;
      const jMax = jobMax ?? jobMin;
      if (jMax != null && jMax < wantMin) {
        result.keep = false;
        result.reasons.push(`薪资低于期望下限 ${wantMin}k`);
      }
    }
  }

  // 经验/学历（软匹配：有配置且岗位有值且不含任一档位则记原因，但不强制排除，避免误杀）
  const exps = arr(f.experience);
  if (exps.length && job.experience) {
    if (!exps.some((e) => job.experience.includes(e))) result.reasons.push('经验档位不在偏好内');
  }
  const degs = arr(f.degrees);
  if (degs.length && job.degree) {
    if (!degs.some((d) => job.degree.includes(d))) result.reasons.push('学历档位不在偏好内');
  }

  // 风险词标注（不排除，仅提示）
  for (const rk of arr(f.riskKeywords)) {
    if (rk && hay.includes(rk.toLowerCase())) result.risks.push(rk);
  }

  return result;
}

// 批量：返回保留的岗位（附带评估元信息挂在 _filter 上）
export function applyFilters(jobs, filters) {
  if (!filters || !filters.enabled) {
    return jobs.map((j) => ({ ...j, _filter: { keep: true, risks: collectRisks(j, filters) } }));
  }
  const out = [];
  for (const j of jobs) {
    const ev = evaluateJob(j, filters);
    if (ev.keep) out.push({ ...j, _filter: ev });
  }
  return out;
}

function collectRisks(job, filters) {
  const hay = buildHaystack(job);
  return arr(filters && filters.riskKeywords).filter((rk) => rk && hay.includes(rk.toLowerCase()));
}

function buildHaystack(job) {
  return [
    job.title,
    job.company,
    job.companyIndustry,
    job.description,
    (job.skills || []).join(' '),
    (job.tags || []).join(' '),
    (job.welfare || []).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function arr(x) {
  return Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.trim()) : [];
}
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
