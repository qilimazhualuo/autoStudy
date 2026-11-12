'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const STATE_FILE = path.join(AUTH_DIR, 'state.json');
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const LOG_FILE = path.join(DATA_DIR, 'study.log');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const VERIFIED_FILE = path.join(DATA_DIR, 'verified.json');
const CAPTCHA_FILE = path.join(DATA_DIR, 'captcha.png');

const DEFAULTS = {
  baseUrl: 'https://gistraining.webmap.cn/',
  headless: true,
  browserChannel: 'chrome',
  browserExecutablePath: '',
  targetHours: 12,
  minutesPerItem: 12,
  actionIntervalSec: 45,
  heartbeatIntervalSec: 50,
  enableHeartbeatFallback: true,
  heartbeatPath: 'index.php?course-app-course-ajax-updatestudytime&studytime=50',
  autoPlayVideo: true,
  muteVideo: true,
  loginTimeoutSec: 300,
  pageLoadTimeoutMs: 30000,
  retryWaitSec: 30,
  logLevel: 'info'
};

function loadConfig() {
  let user = {};
  const p = path.join(ROOT, 'config.json');
  if (fs.existsSync(p)) {
    try {
      user = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.error('config.json 解析失败，使用默认配置：' + e.message);
    }
  }
  return Object.assign({}, DEFAULTS, user);
}

function ensureData() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg, level = 'info') {
  const line = `[${stamp()}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  try {
    ensureData();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {
    // 日志写入失败不影响主流程
  }
}

function resolveUrl(cfg, p) {
  if (/^https?:\/\//i.test(p)) return p;
  return new URL(p, cfg.baseUrl).toString();
}

function relativeUrl(cfg, abs) {
  if (!abs.startsWith(cfg.baseUrl)) return abs;
  return abs.slice(cfg.baseUrl.length);
}

function isLoginPage(html) {
  return /id=["']loginfrm["']/.test(html) || /name=["']args\[randcode\]["']/.test(html);
}

// 真正计学时的课程页内嵌了这段脚本：每 50 秒 submitAjax 上报一次 studytime=50
function hasStudyTimer(html) {
  return /var\s+studytime\s*=\s*0|function\s+jstime|updatestudytime/.test(html || '');
}

function parseStudyMinutes(text) {
  if (!text) return null;
  const m = text.match(/学习时长[:：]\s*(\d+)\s*时\s*(\d+)\s*分\s*(\d+)\s*秒/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 60;
}

function formatMinutes(min) {
  const total = Math.floor(min * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}时${m}分${s}秒`;
}

async function launch(cfg, opts = {}) {
  const { headed = false, useState = true } = opts;
  const launchOpts = {
    headless: headed ? false : cfg.headless,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio'
    ]
  };
  if (cfg.browserExecutablePath) {
    launchOpts.executablePath = cfg.browserExecutablePath;
  } else if (cfg.browserChannel) {
    launchOpts.channel = cfg.browserChannel;
  }

  const browser = await chromium.launch(launchOpts);
  const contextOpts = {
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai'
  };
  if (useState && fs.existsSync(STATE_FILE)) {
    contextOpts.storageState = STATE_FILE;
  }
  const context = await browser.newContext(contextOpts);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  context.setDefaultTimeout(cfg.pageLoadTimeoutMs);
  return { browser, context };
}

// 用纯 HTTP GET 判断登录态：不渲染页面，因此不会请求/刷新登录页的图片验证码
// 两个信号取「或」，任一表明已登录即通过，避免模板差异导致误判
async function checkLogin(context, cfg) {
  const opts = { timeout: cfg.pageLoadTimeoutMs };
  try {
    const home = await context.request.get(resolveUrl(cfg, 'index.php'), opts);
    const homeHtml = await home.text();
    const homeLoggedIn = !/loginbox\.show\(\)/.test(homeHtml) ||
      /user-app-logout|退出登录|退出系统/.test(homeHtml);
    if (homeLoggedIn) return { ok: true };

    const course = await context.request.get(resolveUrl(cfg, 'index.php?course'), opts);
    const courseHtml = await course.text();
    return { ok: !isLoginPage(courseHtml) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readStudyTime(context, cfg) {
  try {
    const resp = await context.request.get(resolveUrl(cfg, 'index.php'), {
      timeout: cfg.pageLoadTimeoutMs
    });
    const html = await resp.text();
    return parseStudyMinutes(html);
  } catch (_) {
    return null;
  }
}

// 注意：只有首页 / 课程页 / 用户中心的顶栏学时是服务端动态渲染的；
// index.php?course-app-category&catid=N 分类页那一块是模板里写死的「0时0分 0秒」，不能作数。
async function readAccountId(context, cfg) {
  try {
    const resp = await context.request.get(resolveUrl(cfg, 'index.php'), {
      timeout: cfg.pageLoadTimeoutMs
    });
    const html = await resp.text();
    const i = html.search(/glyphicon-user/);
    const area = i >= 0 ? html.slice(i, i + 300) : html;
    const m = area.match(/\b(\d{17}[\dXx])\b/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function maskAccount(id) {
  if (!id || id.length < 10) return '(未识别)';
  return id.slice(0, 6) + '********' + id.slice(-4);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureData();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  ROOT, DATA_DIR, AUTH_DIR, STATE_FILE, COURSES_FILE, LINKS_FILE,
  LOG_FILE, PROGRESS_FILE, VERIFIED_FILE, CAPTCHA_FILE,
  loadConfig, ensureData, log, resolveUrl, relativeUrl, isLoginPage,
  parseStudyMinutes, formatMinutes, hasStudyTimer, launch, checkLogin, readStudyTime,
  readAccountId, maskAccount, readJson, writeJson, sleep
};
