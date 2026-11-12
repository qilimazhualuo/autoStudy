'use strict';

const fs = require('fs');
const {
  STATE_FILE, COURSES_FILE, PROGRESS_FILE, VERIFIED_FILE, LOG_FILE,
  loadConfig, log, launch, checkLogin, readStudyTime, readAccountId,
  maskAccount, formatMinutes, readJson
} = require('./src/lib');

const HELP = `
地理信息安全在线培训 - 无头浏览器自动挂课

用法:
  npm run login            打开有头浏览器手动登录一次（含验证码），保存会话到 data/auth/state.json
  npm run login:headless   全程无头登录，验证码保存为 data/captcha.png，由你打开图片后在终端输入
  npm run discover         自动抓取课程内容链接，生成 data/courses.json
  npm run status     从服务端首页读取当前会话账号与累计学习时长
  npm run study      启动无头挂课（Ctrl+C 安全退出，可反复运行继续累计）
  npm run reset      清空本地缓存（进度/有效页/日志），不影响服务端学时与登录会话

可选环境变量（仅 login 时用于自动填账号密码，不落盘）:
  GIS_USERNAME  登录用户名（身份证号）
  GIS_PASSWORD  登录密码

主要配置在 config.json:
  headless               是否无头运行（login 命令强制有头）
  targetHours            目标学时，默认 12
  minutesPerItem         每个学习内容停留分钟数，默认 12（规则要求 >1 且 <30）
  actionIntervalSec      模拟操作间隔秒数，默认 45（规则要求 <120）
  heartbeatIntervalSec   学时上报间隔秒数，默认 50
  enableHeartbeatFallback 页面未自发上报时是否兜底补发，默认 true
  browserChannel         浏览器，默认 chrome，可改为 msedge 或留空用内置 chromium
  browserExecutablePath  自定义浏览器可执行文件路径（优先级高于 browserChannel）
`;

// 只清理本地可再生缓存；服务端学时、课程列表、登录会话一律保留
function resetLocal() {
  const targets = [
    { file: PROGRESS_FILE, desc: '本地进度快照' },
    { file: VERIFIED_FILE, desc: '有效页缓存' },
    { file: LOG_FILE, desc: '运行日志' }
  ];
  let removed = 0;
  for (const t of targets) {
    if (fs.existsSync(t.file)) {
      fs.unlinkSync(t.file);
      removed++;
      console.log(`  已删除 ${t.desc}: ${t.file}`);
    }
  }
  console.log(`共清理 ${removed} 个本地文件`);
  console.log('保留: data/courses.json（课程列表）、data/links.json（链接实测）、data/auth/state.json（登录会话）');
  console.log('注意: 服务端累计学时不会因本操作改变；脚本不存储任何学时数据。');
  console.log('如 study 仍在运行会重新生成这些文件，请先 Ctrl+C 停掉再清空。');
}

async function status(cfg) {
  if (!require('fs').existsSync(STATE_FILE)) {
    log('尚未保存登录会话，请先执行 npm run login', 'warn');
    return;
  }
  const { browser, context } = await launch(cfg);
  try {
    const auth = await checkLogin(context, cfg);
    if (!auth.ok) {
      log('会话已失效，请重新执行 npm run login', 'warn');
      return;
    }
    const account = await readAccountId(context, cfg);
    log(`会话账号 ${maskAccount(account)}｜学时来源：首页顶栏（分类页显示的「0时0分 0秒」是站点写死的静态文本，不是真实学时）`);
    const minutes = await readStudyTime(context, cfg);
    log(minutes === null
      ? '已登录，但未能解析学习时长'
      : `已登录｜累计学习时长 ${formatMinutes(minutes)}｜目标 ${cfg.targetHours} 学时`);

    const courses = readJson(COURSES_FILE, []);
    const progress = readJson(PROGRESS_FILE, null);
    log(`本地学习内容 ${Array.isArray(courses) ? courses.length : 0} 条`);
    if (progress) {
      log(`上次挂课：${progress.updatedAt}，轮次 ${progress.rounds}，当时累计 ${progress.currentMinutes} 分钟`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const cfg = loadConfig();
  const cmd = process.argv[2];
  switch (cmd) {
    case 'login':
      await require('./src/login').run(cfg, { headless: process.argv.includes('--headless') });
      break;
    case 'discover':
      await require('./src/discover').run(cfg);
      break;
    case 'study':
      await require('./src/study').run(cfg);
      break;
    case 'status':
      await status(cfg);
      break;
    case 'reset':
      resetLocal();
      break;
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  log(`运行出错：${e.stack || e.message}`, 'error');
  process.exitCode = 1;
});
