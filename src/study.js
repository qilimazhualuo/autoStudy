'use strict';

const {
  COURSES_FILE, PROGRESS_FILE, VERIFIED_FILE, log, resolveUrl, relativeUrl,
  isLoginPage, hasStudyTimer, formatMinutes, launch, checkLogin,
  readStudyTime, readJson, writeJson, sleep
} = require('./lib');

function loadCourseList() {
  const raw = readJson(COURSES_FILE, []);
  const verified = new Set(readJson(VERIFIED_FILE, []));
  if (!Array.isArray(raw)) return [];
  const list = raw
    .map((x) => (typeof x === 'string' ? { url: x, text: '' } : { url: x.url, text: x.text || '' }))
    .filter((x) => x && x.url);
  // 曾经成功产生学时上报的页面排到前面
  list.sort((a, b) => (verified.has(b.url) ? 1 : 0) - (verified.has(a.url) ? 1 : 0));
  return list;
}

function recordVerified(url) {
  const list = readJson(VERIFIED_FILE, []);
  if (!Array.isArray(list)) return;
  if (!list.includes(url)) {
    list.push(url);
    writeJson(VERIFIED_FILE, list);
  }
}

// 模拟真实用户操作：CDP 派发的 trusted 事件 + 页面级事件，规避「2 分钟无操作不计时」
async function simulateActivity(page, tick) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const cx = Math.round(vp.width * (0.35 + 0.12 * Math.sin(tick)));
  const cy = Math.round(vp.height * (0.45 + 0.1 * Math.cos(tick)));
  await page.mouse.move(cx - 40, cy - 20, { steps: 3 });
  await page.mouse.move(cx, cy, { steps: 4 });
  await page.mouse.wheel(0, tick % 2 ? 40 : -40);
  await page.evaluate(() => {
    const el = document.documentElement || document.body;
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: 100, clientY: 100 }));
    el.dispatchEvent(new MouseEvent('mousewheel', { bubbles: true, cancelable: true, view: window, detail: -1 }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Shift', code: 'ShiftLeft' }));
  });
}

async function ensureVideo(page, cfg) {
  return page.evaluate(({ autoPlay, mute }) => {
    const videos = Array.from(document.querySelectorAll('video'));
    videos.forEach((v) => {
      if (mute) v.muted = true;
      if (autoPlay && v.paused) {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    });
    return { count: videos.length, ended: videos.some((v) => v.ended) };
  }, { autoPlay: cfg.autoPlayVideo, mute: cfg.muteVideo });
}

async function fallbackHeartbeat(page, cfg, state) {
  const p = state.observed.path || cfg.heartbeatPath;
  let body = state.observed.postData || `userhash=${Math.random()}`;
  if (body.includes('userhash=')) {
    body = body.replace(/userhash=[^&]*/, `userhash=${Math.random()}`);
  } else {
    body += `&userhash=${Math.random()}`;
  }
  state.expectFallback = true;
  await page.evaluate(async ({ p, body }) => {
    await fetch(p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body
    });
  }, { p, body });
}

async function studyItem(page, context, cfg, item, state) {
  const target = resolveUrl(cfg, item.url);
  state.organicHeartbeats = 0;
  state.fallbacks = 0;
  state.lastHeartbeatAt = 0;
  state.observed = { path: '', postData: '' };
  state.itemStartedAt = Date.now();
  state.pageHasTimer = false;

  await page.goto(target, { waitUntil: 'domcontentloaded' });
  const html = await page.content().catch(() => '');
  if (isLoginPage(html)) {
    const e = new Error('会话失效');
    e.code = 'SESSION';
    throw e;
  }

  // 只有带 50 秒计时脚本的页面才会真正累加学时，否则立刻切走，不浪费时间
  state.pageHasTimer = hasStudyTimer(html);
  if (!state.pageHasTimer) {
    log(`跳过：该页没有学时计时脚本（${relativeUrl(cfg, target)}）。请重新执行 npm run discover`, 'warn');
    return;
  }

  const title = item.text || (await page.title().catch(() => '')) || relativeUrl(cfg, target);
  log(`打开学习内容：${title}（已检测到 50 秒计时上报脚本）`);

  const endAt = Date.now() + cfg.minutesPerItem * 60 * 1000;
  const noHeartbeatDeadline = Date.now() + 125 * 1000;
  let tick = 0;

  while (Date.now() < endAt && !state.stopping) {
    const remain = endAt - Date.now();
    await sleep(Math.max(1000, Math.min(cfg.actionIntervalSec * 1000, remain)));
    if (state.stopping) break;
    tick++;

    await simulateActivity(page, tick).catch((e) => log(`模拟操作失败：${e.message}`, 'warn'));
    const video = await ensureVideo(page, cfg).catch(() => ({ count: 0, ended: false }));

    const idle = state.lastHeartbeatAt
      ? Date.now() - state.lastHeartbeatAt
      : Date.now() - state.itemStartedAt;
    if (cfg.enableHeartbeatFallback && state.pageHasTimer && idle > cfg.heartbeatIntervalSec * 1000 * 1.6) {
      await fallbackHeartbeat(page, cfg, state)
        .catch((e) => log(`兜底上报失败：${e.message}`, 'warn'));
      state.expectFallback = false;
    }

    if (tick % 2 === 0) {
      // 学时一律来自服务端：每次都重新 GET 站点页面解析顶栏，不做任何本地累加
      const m = await readStudyTime(context, cfg);
      const mins = Math.floor((Date.now() - state.itemStartedAt) / 60000);
      log(`  已停留 ${mins} 分钟｜自发上报 ${state.organicHeartbeats} 次｜兜底 ${state.fallbacks} 次｜视频 ${video.count} 个${m !== null ? `｜服务端累计 ${formatMinutes(m)}` : '｜服务端累计读取失败'}`);
      if (m !== null && m >= cfg.targetHours * 60) {
        log(`服务端累计已达 ${formatMinutes(m)}，达到目标，停止挂课`);
        state.reachedTarget = true;
        break;
      }
    }

    // 页面自身迟迟不上报，说明不是有效学习内容页，别浪费时间
    if (Date.now() > noHeartbeatDeadline && state.organicHeartbeats === 0 && state.fallbacks === 0) {
      log('该页 2 分钟内无任何学时上报，判定为无效内容页，提前切换', 'warn');
      break;
    }
    if (video.ended && video.count > 0 && Date.now() - state.itemStartedAt > 70 * 1000) {
      log('视频已播放结束，提前切换到下一个内容');
      break;
    }
  }

  const spent = ((Date.now() - state.itemStartedAt) / 60000).toFixed(1);
  log(`  本页结束：停留 ${spent} 分钟｜页面自身上报 ${state.organicHeartbeats} 次｜兜底 ${state.fallbacks} 次` +
    (state.organicHeartbeats === 0 ? '（未检测到页面自身计时，请确认 courses.json 里是真正的课程学习页）' : ''));
  if (state.organicHeartbeats > 0) {
    recordVerified(target);
  }
}

async function run(cfg) {
  const courses = loadCourseList();
  if (!courses.length) {
    log(`未找到学习内容列表，请先执行 npm run discover，或手工填写 ${COURSES_FILE}`, 'warn');
    return;
  }

  const { browser, context } = await launch(cfg);
  const page = await context.newPage();
  const state = {
    stopping: false,
    reachedTarget: false,
    expectFallback: false,
    observed: { path: '', postData: '' },
    organicHeartbeats: 0,
    fallbacks: 0,
    lastHeartbeatAt: 0,
    itemStartedAt: Date.now(),
    startedAt: Date.now()
  };

  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('request', (req) => {
    const u = req.url();
    if (!/updatestudytime|studytime/i.test(u)) return;
    if (state.expectFallback) {
      state.fallbacks++;
      state.lastHeartbeatAt = Date.now();
      return;
    }
    state.organicHeartbeats++;
    state.lastHeartbeatAt = Date.now();
    state.observed.path = relativeUrl(cfg, u);
    if (req.postData()) state.observed.postData = req.postData();
  });

  const onSigint = () => {
    if (state.stopping) return;
    state.stopping = true;
    log('收到 Ctrl+C，完成当前动作后安全退出（进度已保留）', 'warn');
  };
  process.on('SIGINT', onSigint);

  try {
    const auth = await checkLogin(context, cfg);
    if (!auth.ok) {
      log('会话已失效或尚未登录，请先执行 npm run login', 'warn');
      return;
    }

    const targetMinutes = cfg.targetHours * 60;
    let minutes = await readStudyTime(context, cfg);
    log(`开始挂课｜共 ${courses.length} 个学习内容｜每个停留 ${cfg.minutesPerItem} 分钟｜目标 ${cfg.targetHours} 学时（${targetMinutes} 分钟）`);
    if (minutes !== null) log(`当前服务端累计学习时长：${formatMinutes(minutes)}（来自站点页面，非本地累计）`);

    let index = 0;
    let consecutiveNoOrganic = 0;
    while (!state.stopping && !state.reachedTarget) {
      if (minutes !== null && minutes >= targetMinutes) {
        log(`已达到目标学时：${formatMinutes(minutes)}，自动停止`);
        break;
      }

      const item = courses[index % courses.length];
      index++;
      try {
        await studyItem(page, context, cfg, item, state);
        if (state.organicHeartbeats === 0) {
          consecutiveNoOrganic++;
          if (consecutiveNoOrganic === 3) {
            log('连续 3 个页面都没有页面自身的学时上报，请检查 data/courses.json；可打开 data/links.json 找真正的课程播放/阅读页', 'warn');
          }
        } else {
          consecutiveNoOrganic = 0;
        }
      } catch (e) {
        if (e.code === 'SESSION') {
          log('会话已失效，请重新执行 npm run login 后再继续', 'error');
          break;
        }
        log(`页面异常（${e.message}），${cfg.retryWaitSec} 秒后继续下一个内容`, 'warn');
        await sleep(cfg.retryWaitSec * 1000);
      }

      minutes = await readStudyTime(context, cfg);
      writeJson(PROGRESS_FILE, {
        updatedAt: new Date().toISOString(),
        startedAt: new Date(state.startedAt).toISOString(),
        currentMinutes: minutes,
        targetHours: cfg.targetHours,
        rounds: index,
        lastUrl: resolveUrl(cfg, item.url)
      });
      if (minutes !== null) log(`服务端累计学习时长：${formatMinutes(minutes)} / ${cfg.targetHours} 学时`);
    }

    const elapsed = Math.round((Date.now() - state.startedAt) / 60000);
    log(`本次运行结束，共运行 ${elapsed} 分钟，累计 ${minutes === null ? '未知' : formatMinutes(minutes)}。再次执行 npm run study 可继续累计。`);
  } finally {
    process.removeListener('SIGINT', onSigint);
    await browser.close().catch(() => {});
  }
}

module.exports = { run };
