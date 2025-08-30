require("dotenv").config();
const logger = require("../utils/logger");

// نضمن تحضير الصفحة مرة واحدة فقط
const preparedPages = new WeakSet();

async function humanLikeScroll(page) {
  await page.evaluate(async () => {
    function delay(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }
    let total = 0,
      step = Math.floor(window.innerHeight * 0.7);
    while (total < document.body.scrollHeight) {
      window.scrollBy(0, step);
      total += step;
      await delay(500 + Math.random() * 1000);
      if (Math.random() < 0.2) {
        window.scrollBy(0, -Math.floor(Math.random() * 200));
        await delay(Math.random() * 600);
      }
    }
  });
}

// goto مع محاولات/ريتراي للأخطاء الشائعة (يشمل 403)
async function gotoWithRetries(page, url, opts = {}, maxRetries = 3) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    attempt++;
    try {
      logger.debug({ url, attempt }, "[details] goto()");
      const resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
        ...opts,
      });
      if (resp && resp.status() === 403) throw new Error("HTTP_403");
      if (typeof page.waitForNetworkIdle === "function") {
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
      }
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retriable =
        msg.includes("HTTP_403") ||
        msg.includes("net::ERR_ABORTED") ||
        msg.includes("ERR_NETWORK_CHANGED") ||
        msg.includes("Timeout") ||
        msg.includes("Navigation");
      logger.warn({ url, attempt, retriable, err: msg }, "[details] goto failed");
      if (!retriable || attempt >= maxRetries) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

// تحضير صفحة واحد مرة واحدة + اعتراض طلبات آمن
async function preparePage(page) {
  if (preparedPages.has(page)) return;
  preparedPages.add(page);

  await page.setDefaultNavigationTimeout(60000);

  page.on("requestfailed", (req) => {
    const fail = req.failure()?.errorText;
    logger.debug({ url: req.url(), method: req.method(), fail }, "[details] request failed");
  });
  page.on("response", (res) => {
    const s = res.status();
    if (s >= 400) logger.debug({ url: res.url(), status: s }, "[details] response >= 400");
  });

  await page.setRequestInterception(true).catch(() => {});
  page.on("request", (req) => {
    try {
      if (typeof req.isInterceptResolutionHandled === "function" && req.isInterceptResolutionHandled()) return;
      const rtype = req.resourceType();
      if (rtype === "media" || rtype === "font") return req.abort().catch(() => {});
      return req.continue().catch(() => {});
    } catch (err) {
      try { req.continue().catch(() => {}); } catch {}
      logger.debug({ url: req.url(), err: String(err?.message || err) }, "[details] intercept error");
    }
  });
}

// ـــــ لا نكتب أي scrapedAt هنا نهائيًا ـــــ
async function extractDetails(page, url) {
  await gotoWithRetries(page, url);

  try {
    await humanLikeScroll(page);
    await page.waitForSelector("h1.text-body_1.text-gray__dark_2", { timeout: 15000 });
    await page.waitForTimeout(1200);
  } catch {}

  const details = await page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const href = (sel) => document.querySelector(sel)?.href || null;
    const data = {
      title: t("h1.text-body_1.text-gray__dark_2"),
      area: t("section.container-fluid div.flex div.text-gray__dark_2 p.text-body_1.truncated-text"),
      price: t("main.flex.flex-col section#stickyDiv span.text-title_3"),
      advertiserName: t("section.container-fluid div.justify-between div.flex-1 div.flex-col a"),
      advertiserLink: href("section.container-fluid div.justify-between div.flex-1 div.flex-col a"),
      advertiserAdsCount: t("section.container-fluid div.justify-between div.flex-1 p.pb-2x.text-gray__dark_1.text-body_2"),
      location: t("section.flex-col-reverse a p.text-body_2.text-gray__dark_2"),
      description: t("section.container-fluid div.flex-1 div.flex-col.gap-y-2x.text-gray__dark_2 p"),
      features: Array.from(document.querySelectorAll("div.grid.grid-cols-2.gap-3x li")).map(li => li.textContent.trim()),
      url: location.href,
    };
    return data;
  });

  return details;
}

async function processListing(page, url, detailsCollection) {
  await preparePage(page);
  const details = await extractDetails(page, url);
  await detailsCollection.updateOne(
    { url },
    { $set: { ...details, scrapedAt: new Date() } },
    { upsert: true }
  );
}

module.exports = { processListing, preparePage, extractDetails, gotoWithRetries };