'use strict';

const readline = require('readline');
const {
  STATE_FILE, CAPTCHA_FILE, ensureData, log, resolveUrl, launch, checkLogin,
  readStudyTime, formatMinutes, sleep
} = require('./lib');

const LOGIN_URL = 'index.php?user-app-login';

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function saveSession(cfg, context) {
  ensureData();
  await context.storageState({ path: STATE_FILE });
  const minutes = await readStudyTime(context, cfg);
  log(`登录成功，会话已保存到 ${STATE_FILE}`);
  if (minutes !== null) {
    log(`当前累计学习时长：${formatMinutes(minutes)} / 目标 ${cfg.targetHours} 学时`);
  }
  log('提示：state.json 等同于登录凭证，请勿分享或提交到代码仓库');
}

// 方式一：打开有头浏览器，人工完成登录（含验证码），脚本自动检测并保存会话
async function headedLogin(cfg) {
  log('打开有头浏览器进行登录（只需做一次，之后挂课全部无头运行）');
  const { browser, context } = await launch(cfg, { headed: true, useState: false });
  try {
    const page = await context.newPage();
    await page.goto(resolveUrl(cfg, LOGIN_URL), { waitUntil: 'domcontentloaded' });

    const username = process.env.GIS_USERNAME || '';
    const password = process.env.GIS_PASSWORD || '';
    if (username) await page.fill('input[name="args[username]"]', username).catch(() => {});
    if (password) await page.fill('input[name="args[userpassword]"]', password).catch(() => {});

    console.log('');
    console.log('  请在浏览器窗口中完成登录：用户名(身份证) / 密码 / 图片验证码');
    console.log('  登录成功后本脚本会自动保存会话，窗口会自动关闭。');
    console.log(`  最长等待 ${cfg.loginTimeoutSec} 秒。`);
    console.log('');

    const deadline = Date.now() + cfg.loginTimeoutSec * 1000;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(3000);
      const state = await checkLogin(context, cfg);
      if (state.ok) { ok = true; break; }
    }
    if (!ok) {
      log('登录超时，会话未保存。请重新执行 npm run login', 'warn');
      return;
    }
    await saveSession(cfg, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

// 方式二：全程无头，验证码截图保存为图片由本人识别后在终端输入
async function headlessLogin(cfg) {
  log('无头登录模式：验证码会保存为图片，请按提示打开查看并输入');
  const { browser, context } = await launch(cfg, { headed: false, useState: false });
  try {
    const page = await context.newPage();
    await page.goto(resolveUrl(cfg, LOGIN_URL), { waitUntil: 'domcontentloaded' });

    const username = process.env.GIS_USERNAME || await ask('用户名(身份证号): ');
    const password = process.env.GIS_PASSWORD || await ask('密码(会明文显示，注意周围环境): ');

    for (let attempt = 1; attempt <= 3; attempt++) {
      ensureData();
      await page.locator('img.randCode').screenshot({ path: CAPTCHA_FILE });
      const code = await ask(`验证码图片已保存 -> ${CAPTCHA_FILE} ，请打开查看后输入验证码: `);

      await page.fill('input[name="args[username]"]', username);
      await page.fill('input[name="args[userpassword]"]', password);
      await page.fill('input[name="args[randcode]"]', code);
      await page.locator('#loginfrm button:has-text("登录")').click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(1500);

      const state = await checkLogin(context, cfg);
      if (state.ok) {
        await saveSession(cfg, context);
        return;
      }
      log(`登录未成功（第 ${attempt} 次），通常是验证码过期或填错，刷新后重试`, 'warn');
      await page.goto(resolveUrl(cfg, LOGIN_URL), { waitUntil: 'domcontentloaded' });
    }
    log('连续 3 次登录失败，请检查账号密码，或改用 npm run login 在浏览器里手动登录', 'error');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function run(cfg, opts = {}) {
  if (opts.headless) return headlessLogin(cfg);
  return headedLogin(cfg);
}

module.exports = { run };
