const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const { randomInt } = require("crypto");
const logger = require("../utils/logger");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function humanLikeScroll(page) {
  await page.evaluate(async () => {
    function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
    let total = 0;
    const step = Math.floor(window.innerHeight * 0.7);
    while (total < document.body.scrollHeight) {
      window.scrollBy(0, step);
      total += step;
      await delay(500 + Math.random() * 2500);
      if (Math.random() < 0.2) {
        window.scrollBy(0, -Math.floor(Math.random() * 200));
        await delay(Math.random() * 1000);
      }
    }
  });
}

function pickUA(userAgents) {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

async function withStealthPage(browser, { viewport, userAgents }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const ua = pickUA(userAgents);
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "DNT": "1",
    "Sec-GPC": "1"
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en", "ar"] });
  });

  // Logging للشبكة أثناء الـ seeding
  page.on("requestfailed", (req) => {
    const fail = req.failure()?.errorText;
    logger.debug({ url: req.url(), method: req.method(), fail }, "[seed] request failed");
  });
  page.on("response", (res) => {
    const s = res.status();
    if (s >= 400) logger.debug({ url: res.url(), status: s }, "[seed] response >= 400");
  });

  return page;
}

/**
 * يجمع URLs من أول N صفحات (seeding) — بدون لمس السلكتور
 * يوقف لو مفيش روابط جديدة (بدأ تكرار) أو خلّص العدد المطلوب من الصفحات.
 */
async function seedFirstPages({
  browser, baseUrl, searchUrl, listSelector, pagesCount, viewport, userAgents, saveUrl,
}) {
  const page = await withStealthPage(browser, { viewport, userAgents });

  const seen = new Set();
  let pageNum = 1;
  let ended = false;

  logger.info({ searchUrl, pagesCount }, "[seed] start");

  while (pageNum <= pagesCount && !ended) {
    const url = `${searchUrl}${searchUrl.includes("?") ? "&" : "?"}page=${pageNum}`;
    logger.debug({ pageNum, url }, "[seed] opening page");

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      if (resp && resp.status() === 403) throw new Error("HTTP_403");
      await humanLikeScroll(page);
      await page.waitForSelector(listSelector, { timeout: 15000 });
    } catch (e) {
      const msg = String((e && e.message) || e);
      logger.warn({ pageNum, url, err: msg }, "[seed] navigation/selector error — retry once");

      // محاولة تانية خفيفة
      try {
        await sleep(1200);
        const resp2 = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (resp2 && resp2.status() === 403) throw new Error("HTTP_403");
        await humanLikeScroll(page);
        await page.waitForSelector(listSelector, { timeout: 15000 });
      } catch (e2) {
        logger.error({ pageNum, url, err: String((e2 && e2.message) || e2) }, "[seed] page skipped");
        pageNum++;
        continue;
      }
    }

    const links = await page.$$eval(listSelector, (as) => as.map((a) => a.href).filter(Boolean));
    let newCount = 0;
    for (const link of links) {
      if (!seen.has(link)) {
        seen.add(link);
        newCount++;
        await saveUrl(link);
      }
    }
    logger.info({ page: pageNum, newCount }, "[seed] collected links");
    if (newCount === 0) ended = true;
    pageNum++;
    await sleep(500 + Math.random() * 1200);
  }

  try { await page.close(); } catch {}
}

/**
 * جامع كامل لكل الصفحات مع حفظ واستئناف من resume.json
 * - لو ظهر 403: نغير UA + نعيد تشغيل الصفحة/المتصفح ونكمل (من غير VPN علشان SSH)
 * - لا نغيّر أيSelectors/روابط نهائيًا
 */
async function collectAllPages({
  browser, searchUrl, listSelector, viewport, userAgents, startPage = 1, resumeApi, targetName, saveUrl,
  maxRetriesPerPage = 3, consecutiveNoNewStop = 2,
}) {
  const seenThisRun = new Set();
  let pageNum = Math.max(1, startPage);
  let noNewStreak = 0;

  let page = await withStealthPage(browser, { viewport, userAgents });

  logger.info({ searchUrl, startPage }, "[collect] start");
  while (true) {
    const url = `${searchUrl}${searchUrl.includes("?") ? "&" : "?"}page=${pageNum}`;
    let attempt = 0;
    let ok = false;
    let newCount = 0;

    while (attempt < maxRetriesPerPage && !ok) {
      attempt++;
      const ua = pickUA(userAgents);
      await page.setUserAgent(ua);

      try {
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (resp && resp.status() === 403) throw new Error("HTTP_403");
        await humanLikeScroll(page);
        await page.waitForSelector(listSelector, { timeout: 15000 });

        const links = await page.$$eval(listSelector, (as) => as.map((a) => a.href).filter(Boolean));
        for (const link of links) {
          if (!seenThisRun.has(link)) {
            seenThisRun.add(link);
            newCount++;
            await saveUrl(link);
          }
        }
        ok = true;
      } catch (e) {
        const msg = String((e && e.message) || e);
        const is403 = msg.includes("HTTP_403") || msg.includes("403");
        logger.warn({ page: pageNum, attempt, is403, err: msg }, "[collect] failed, will retry");

        if (is403) {
          // Reset context fingerprint (بدون VPN علشان SSH)
          try { await page.close(); } catch {}
          page = await withStealthPage(browser, { viewport, userAgents });
          await sleep(2000 + Math.random() * 2000);
        } else {
          await sleep(1200 * attempt);
        }
      }
    }

    // بعد المحاولات
    await resumeApi.updatePage(pageNum); // persist
    await resumeApi.updateCounters({ collectedDelta: newCount });

    if (!ok) {
      logger.error({ page: pageNum }, "[collect] page failed permanently, moving next");
    } else {
      logger.info({ page: pageNum, newCount }, "[collect] done");
    }

    noNewStreak = newCount === 0 ? noNewStreak + 1 : 0;
    if (noNewStreak >= consecutiveNoNewStop) {
      logger.info({ page: pageNum, noNewStreak }, "[collect] stopping (no new links)");
      break;
    }

    pageNum++;
    await sleep(600 + Math.random() * 1400);
  }

  try { await page.close(); } catch {}
}

module.exports = { seedFirstPages, collectAllPages };