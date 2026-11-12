'use strict';

const {
  COURSES_FILE, LINKS_FILE, log, resolveUrl, isLoginPage, hasStudyTimer,
  launch, checkLogin, writeJson, sleep
} = require('./lib');

function queryOf(u) {
  return u.includes('?') ? u.slice(u.indexOf('?') + 1) : '';
}

function normalize(u) {
  return u.split('#')[0];
}

function isCourseLink(u) {
  const q = queryOf(u);
  return q.includes('course-app-') && !/randcode|user-app-login|course-app-search/.test(q);
}

async function run(cfg) {
  const { browser, context } = await launch(cfg);
  try {
    const auth = await checkLogin(context, cfg);
    if (!auth.ok) {
      log('会话已失效或尚未登录，请先执行 npm run login', 'warn');
      return;
    }

    const page = await context.newPage();
    const queue = [
      { url: resolveUrl(cfg, 'index.php'), depth: 0 },
      { url: resolveUrl(cfg, 'index.php?course'), depth: 0 }
    ];
    const visited = new Set();
    const candidates = new Map();
    const MAX_PAGES = 60;
    const MAX_DEPTH = 2;

    // 第一阶段：广度抓取所有课程链接（含分页），不做 URL 猜测
    while (queue.length && visited.size < MAX_PAGES) {
      const item = queue.shift();
      const url = normalize(item.url);
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (e) {
        log(`页面打开失败，跳过：${url} (${e.message})`, 'warn');
        continue;
      }

      const html = await page.content().catch(() => '');
      if (isLoginPage(html)) {
        log('检测到登录页，会话已失效，请先执行 npm run login', 'warn');
        break;
      }

      const links = await page.$$eval('a[href]', (els) =>
        els.map((a) => ({ href: a.href, text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) }))
      ).catch(() => []);

      for (const l of links) {
        const u = normalize(l.href);
        if (!isCourseLink(u)) continue;
        if (!candidates.has(u)) candidates.set(u, l.text);
        if (item.depth < MAX_DEPTH && !visited.has(u)) {
          queue.push({ url: u, depth: item.depth + 1 });
        }
      }
      await sleep(120);
    }

    // 第二阶段：逐个实测，只保留「页面里真的带 50 秒计时上报脚本」的页
    const verified = [];
    const all = [];
    for (const [url, text] of candidates) {
      if (all.length >= 60) break;
      let timed = false;
      let video = 0;
      let error = '';
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const html = await page.content();
        timed = hasStudyTimer(html);
        video = (html.match(/<video\b/gi) || []).length;
      } catch (e) {
        error = e.message;
      }
      const row = { url, text, timed, video };
      if (error) row.error = error;
      all.push(row);
      if (timed) {
        verified.push({ url, text: text || (video ? `视频课程页 (${video})` : '学习页') });
      }
      await sleep(120);
    }

    all.sort((a, b) => a.url.localeCompare(b.url));
    writeJson(LINKS_FILE, {
      visited: Array.from(visited),
      all,
      scannedAt: new Date().toISOString()
    });
    writeJson(COURSES_FILE, verified);

    log(`已扫描 ${visited.size} 个页面、实测 ${all.length} 条课程链接，其中带计时脚本的有效学习页 ${verified.length} 条`);
    log(`全部链接与实测结果 -> ${LINKS_FILE}`);
    log(`挂课列表 -> ${COURSES_FILE}`);

    if (verified.length === 0) {
      log('没有找到带计时脚本的页面，请检查登录态，或打开 data/links.json 查看实测结果', 'warn');
    } else {
      verified.slice(0, 15).forEach((l, i) => log(`  ${i + 1}. ${l.text}  ${l.url}`));
      if (verified.length > 15) log(`  ... 其余 ${verified.length - 15} 条见 courses.json`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { run };
