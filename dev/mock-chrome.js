// 开发预览用的 chrome API 模拟：让 popup/sidepanel/options 能在普通浏览器里渲染，
// 便于视觉走查与捕获渲染期 JS 错误。仅用于本地预览，不进扩展包。
(function () {
  const listeners = [];
  // 内存态后端
  const state = {
    settings: {
      mode: 'auto', autoCapture: true, autoScore: false, showBadge: true, dedupe: true, maxJobs: 800,
      activeProviderId: 'demo',
      privacy: { redactPII: true, sendCompanyName: true, confirmBeforeSend: false },
      filters: { enabled: false, keywordsInclude: [], keywordsExclude: [], riskKeywords: ['外包','驻场','猎头'], cities: [], salaryMinK: null, salaryMaxK: null, experience: [], degrees: [], excludeCompanies: [] },
    },
    providers: [
      { id: 'demo', name: 'DeepSeek 深度求索', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-demo', model: 'deepseek-chat', anthropicVersion: '', extraHeaders: {}, temperature: 0.3, maxTokens: 2048, discoveredModels: ['deepseek-chat','deepseek-reasoner'] },
    ],
    profile: {
      schemaVersion: 1,
      target: { jobTitles: ['前端工程师','Web 前端'], cities: ['广州'], salaryMinK: 18, salaryMaxK: 30, industries: ['互联网'], companySizes: [], workModes: [] },
      basics: { name: '', yearsOfExperience: 4, education: '本科', currentTitle: '高级前端工程师' },
      capabilities: { skills: ['React','TypeScript','Vue','Webpack'], strengths: ['组件库建设','性能优化'], industryExperience: ['电商','SaaS'] },
      workSummary: '4年前端开发经验，主导过多个中后台项目。', projectSummary: '设计并落地公司组件库，覆盖 30+ 业务。', highlights: ['首屏加载优化 40%','沉淀通用组件库'],
      preference: { avoidKeywords: ['外包'], dealbreakers: [], notes: '' },
      updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    },
    jobs: [
      { uid:'boss:demo1', platform:'boss', jobId:'demo1', title:'高级前端工程师', salaryText:'25-40K·14薪', salaryMinK:25, salaryMaxK:40, city:'广州', district:'天河区·珠江新城', experience:'3-5年', degree:'本科', skills:['React','TypeScript','Node.js'], tags:['五险一金','弹性工作'], welfare:['补充医疗','年度体检'], company:'某互联网大厂', companyIndustry:'互联网', companyScale:'10000人以上', companyType:'', companyStage:'已上市', hrName:'', hrTitle:'技术经理', description:'', url:'https://www.zhipin.com/job_detail/demo1.html', publishedAt:'', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:true,
        match:{ score:88, verdict:'strong', reasons:['React/TS 技能高度契合','有中后台与组件库经验','城市与薪资匹配'], gaps:['缺少大规模 SSR 经验'], risks:[], summary:'技能与经历高度匹配，建议优先沟通。',
          greetings:{
            short:'您好，4年前端，精通 React/TS，做过组件库建设，对这个高级前端岗位很感兴趣。',
            standard:'您好，我有4年前端经验，精通 React 与 TypeScript，曾主导公司组件库建设并将首屏性能优化40%，对贵司这个高级前端岗位很感兴趣，期待进一步交流。',
            detailed:'您好，我有4年前端开发经验，技术栈以 React 与 TypeScript 为主。在上家公司主导了通用组件库的建设，覆盖 30+ 业务线，并通过懒加载与打包优化把首屏加载时间降低了 40%。看到贵司这个高级前端岗位对组件化与性能有要求，与我的经历高度契合，希望有机会进一步沟通。',
          },
          greeting:'您好，我有4年前端经验，精通 React 与 TypeScript，曾主导公司组件库建设并将首屏性能优化40%，对贵司这个高级前端岗位很感兴趣，期待进一步交流。', at:new Date().toISOString() } },
      { uid:'qcwy:demo2', platform:'qcwy', jobId:'demo2', title:'Web前端开发工程师', salaryText:'1.5-2.5万·13薪', salaryMinK:15, salaryMaxK:25, city:'广州', district:'海珠区', experience:'1-3年', degree:'本科', skills:['Vue','JavaScript','CSS'], tags:['双休','带薪年假'], welfare:['五险一金'], company:'某科技有限公司', companyIndustry:'计算机软件', companyScale:'150-500人', companyType:'民营', companyStage:'', hrName:'', hrTitle:'HR', description:'岗位职责：负责公司前端产品开发……', url:'https://jobs.51job.com/demo2.html', publishedAt:'2026-09-18', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:false, match:null },
      { uid:'boss:demo3', platform:'boss', jobId:'demo3', title:'前端外包驻场', salaryText:'12-18K', salaryMinK:12, salaryMaxK:18, city:'深圳', district:'南山区', experience:'3-5年', degree:'大专', skills:['jQuery','HTML'], tags:['外包'], welfare:[], company:'XX外包服务公司', companyIndustry:'人力资源', companyScale:'500-999人', companyType:'', companyStage:'', hrName:'', hrTitle:'招聘', description:'', url:'', publishedAt:'', raw:{}, savedAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), star:false, match:{ score:38, verdict:'weak', reasons:['基础技能匹配'], gaps:['技术栈偏旧'], risks:['疑似外包驻场'], summary:'匹配度偏低，注意外包性质。', greeting:'', at:new Date().toISOString() } },
    ],
    // 模拟「当前查看的岗位」上下文（可用 __mockSwitchJob 切换来验证实时跟随）
    ctx: { platform:'boss', url:'https://www.zhipin.com/job_detail/demo1.html', jobKey:'demo1', isChat:false },
  };

  // 广播给所有 onMessage 监听者（模拟真实扩展的 chrome.runtime.sendMessage 广播）
  function broadcast(msg) {
    listeners.forEach((fn) => { try { fn(msg, {}, () => {}); } catch {} });
  }

  function respond(msg) {
    const t = msg.type;
    switch (t) {
      case 'SETTINGS_GET': return state.settings;
      case 'SETTINGS_SAVE':
        state.settings = { ...state.settings, ...msg.patch, privacy:{...state.settings.privacy,...(msg.patch&&msg.patch.privacy)}, filters:{...state.settings.filters,...(msg.patch&&msg.patch.filters)} };
        return state.settings;
      case 'JOB_LIST_REQUEST': return state.jobs;
      case 'JOB_STAR_TOGGLE': state.jobs = state.jobs.map(j=>j.uid===msg.uid?{...j,star:!j.star}:j); return state.jobs;
      case 'JOB_DELETE': state.jobs = state.jobs.filter(j=>j.uid!==msg.uid); return state.jobs;
      case 'JOB_CLEAR_REQUEST': state.jobs = []; return state.jobs;
      case 'JOB_EXPORT_REQUEST': return { format: msg.format||'json', content: JSON.stringify(state.jobs,null,2), count: state.jobs.length };
      case 'GREETING_SAVE': state.jobs = state.jobs.map(j=>j.uid===msg.uid?{...j,greetingDraft:msg.text}:j); return state.jobs;
      case 'ACTIVE_CONTEXT_REQUEST': return { platform:state.ctx.platform, url:state.ctx.url, jobKey:state.ctx.jobKey, isChat:state.ctx.isChat, platformName: state.ctx.platform==='boss'?'BOSS 直聘':'前程无忧 51job' };
      case 'SEND_GREETING': console.log('[mock] SEND_GREETING:', msg.text); return { ok:true, mode:'sent' };
      case 'AI_PROVIDERS_GET': return state.providers;
      case 'AI_PROVIDERS_SAVE': state.providers = msg.providers; return state.providers;
      case 'AI_PROVIDER_TEST': return { ok:true, message:'连接成功', sample:'正常' };
      case 'AI_PROVIDER_MODELS': return ['deepseek-chat','deepseek-reasoner'];
      case 'PROFILE_GET': return state.profile;
      case 'PROFILE_SAVE': state.profile = msg.profile; return state.profile;
      case 'PROFILE_CLEAR': state.profile = null; return null;
      case 'AI_RESUME_EXTRACT': return { target:{jobTitles:['产品经理'],cities:['上海'],industries:[]}, basics:{yearsOfExperience:5,education:'硕士'}, capabilities:{skills:['需求分析','Axure'],strengths:['数据驱动'],industryExperience:['金融']}, workSummary:'5年产品经验', projectSummary:'', highlights:['DAU 提升30%'] };
      case 'AI_MATCH_SCORE': { const m={score:76,verdict:'good',reasons:['演示打分'],gaps:[],risks:[],summary:'演示总评',greeting:'演示开场白',at:new Date().toISOString()}; state.jobs=state.jobs.map(j=>j.uid===msg.uid?{...j,match:m}:j); return m; }
      case 'AI_MATCH_BATCH': return (msg.uids||[]).map(u=>({uid:u,ok:true,score:70}));
      case 'OPEN_OPTIONS': console.log('[mock] openOptionsPage'); return { ok:true };
      case 'OPEN_SIDEPANEL': console.log('[mock] open sidepanel'); return { ok:true };
      case 'OPEN_JOB_WINDOW': {
        if (!msg.url) throw new Error('该岗位没有可打开的链接');
        state.lastWindowOpen = { url: msg.url, platform: msg.platform, at: Date.now() };
        console.log('[mock] OPEN_JOB_WINDOW (focused:false):', msg.url);
        return { ok:true, mode:'window-new', windowId: 99, tabId: 199 };
      }
      default: return { ok:true };
    }
  }

  window.chrome = {
    runtime: {
      lastError: null,
      id: 'dev-mock',
      sendMessage: (msg, cb) => {
        let env;
        try { env = { ok:true, data: respond(msg) }; }
        catch (e) { env = { ok:false, error: e instanceof Error ? e.message : String(e) }; }
        if (typeof cb === 'function') setTimeout(()=>cb(env), 30);
        return Promise.resolve(env);
      },
      onMessage: { addListener: (fn)=>listeners.push(fn), removeListener: ()=>{} },
      openOptionsPage: () => console.log('[mock] openOptionsPage'),
      getURL: (p) => '/' + p,
    },
    storage: { local: { get: async()=>({}), set: async()=>{}, remove: async()=>{} } },
    // 测试辅助：模拟用户在网站上点开另一个岗位（触发 CURRENT_JOB 广播）
    __mockSwitchJob: (platform, jobKey, isChat) => {
      state.ctx = { platform, jobKey, isChat: !!isChat, url: platform==='boss'?`https://www.zhipin.com/web/geek/jobs`:`https://we.51job.com/pc/search` };
      broadcast({ type: 'CURRENT_JOB', platform, jobKey });
    },
    tabs: { query: async()=>[{ id:1, windowId:1, url:'https://www.zhipin.com/web/geek/jobs' }], create: (o)=>console.log('[mock] tabs.create', o.url) },
    sidePanel: { open: async()=>console.log('[mock] sidePanel.open'), setPanelBehavior: async()=>{} },
    downloads: { download: async(o)=>{ console.log('[mock] download', o.filename); return 1; } },
  };
})();
