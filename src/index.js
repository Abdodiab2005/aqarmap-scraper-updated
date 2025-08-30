require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const os = require("os");
const path = require("path");
const { db } = require("./db/mongo");
const cfg = require("./config");
const logger = require("./utils/logger");
const { seedFirstPages, collectAllPages } = require("./scrape/urlCollector");
const { processListing } = require("./scrape/detailScraper");
const { exportCollectionToExcel } = require("./exporter");
const { init: initTG, notify } = require("./utils/telegram");
const {
  loadResume,
  updatePage,
  updateCounters,
  updateLastUrl,
} = require("./utils/resume");
const { startTelegramController } = require("./telegram/controller");

function calcOptimalConcurrency(maxCap) {
  const freeMem = os.freemem();
  const cpu = os.cpus().length;
  const memLimit = Math.floor(freeMem / (220 * 1024 * 1024));
  const val = Math.max(3, Math.min(memLimit, cpu * 2, maxCap));
  logger.info({ freeMem, cpu, memLimit, chosen: val }, "concurrency computed");
  return val;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function workerPool({
  browser,
  urlsCol,
  detailsCol,
  docs,
  concurrency,
  resumeFile,
}) {
  logger.info({ batch: docs.length, concurrency }, "🚦 starting worker pool");
  const pages = await Promise.all(
    Array.from({ length: Math.min(concurrency, docs.length) }, async () => {
      const p = await browser.newPage();
      return p;
    })
  );

  let idx = 0;
  let ok = 0,
    fail = 0;

  const runWorker = async (page, workerId) => {
    logger.debug({ workerId }, "worker start");
    while (true) {
      const i = idx++;
      if (i >= docs.length) break;
      const doc = docs[i];
      try {
        await processListing(page, doc.url, detailsCol);
        await urlsCol.updateOne(
          { _id: doc._id },
          { $set: { scraped: true, scrapedAt: new Date(), lastErr: null } }
        );
        await updateLastUrl(resumeFile, doc.url);
        ok++;
      } catch (e) {
        const msg = String((e && e.message) || e);
        await urlsCol.updateOne(
          { _id: doc._id },
          { $set: { scraped: false, error: msg, failedAt: new Date() } }
        );
        fail++;
      }
      await sleep(200); // بريك بسيط بين جوبات نفس العامل
    }
    try {
      await page.close();
    } catch {}
    logger.debug({ workerId, ok, fail }, "worker end");
  };

  await Promise.all(pages.map((p, i) => runWorker(p, i + 1)));
  logger.info({ ok, fail }, "🏁 pool finished");
}

async function main() {
  initTG(cfg.telegram.token);
  const chatId = cfg.telegram.chatId;
  const _db = await db(cfg.mongo.uri, cfg.mongo.dbName);

  // ابدأ الكنترولر بتاع التلجرام (polling) علشان الأوامر تشتغل
  startTelegramController({
    token: cfg.telegram.token,
    chatId,
    mongoUri: cfg.mongo.uri,
    dbName: cfg.mongo.dbName,
    cfg,
  }).catch((e) =>
    logger.warn({ err: String(e?.message || e) }, "[tg] controller failed")
  );

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=PrivacySandboxAdsAPIs,AttributionReportingCrossAppWeb",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--mute-audio",
      "--unsafely-treat-insecure-origin-as-secure=http://localhost",
    ],
    defaultViewport: cfg.scraping.viewport,
  });

  const resumeFile = cfg.resumeFile || "./resume.json";

  try {
    logger.info("🚀 Pipeline started");
    if (chatId) await notify(chatId, "🚀 *Pipeline started*");

    for (const target of cfg.targets) {
      const { url: searchUrl, name } = target;
      const urlsCol = _db.collection(`${name}_urls`);
      const detailsCol = _db.collection(name);

      await urlsCol.createIndex({ url: 1 }, { unique: true });
      await detailsCol.createIndex({ url: 1 }, { unique: true });

      logger.info({ target: name, searchUrl }, "🎯 starting target");
      if (chatId) await notify(chatId, `🧭 Target: *${name}*\n🔗 ${searchUrl}`);

      // Load resume to know from which page to continue
      const resume = await loadResume(resumeFile);
      const startPage = (resume.targets && resume.targets[name]?.page) || 1;
      const resumeApi = {
        updatePage: (page) => updatePage(resumeFile, name, page),
        updateCounters: (p) => updateCounters(resumeFile, name, p),
      };

      // 1) SEED (أول 5 صفحات)
      await seedFirstPages({
        browser,
        baseUrl: cfg.baseUrl,
        searchUrl,
        listSelector: cfg.scraping.listSelector,
        pagesCount: cfg.seed.firstPages,
        viewport: cfg.scraping.viewport,
        userAgents: cfg.scraping.userAgents,
        saveUrl: async (url) => {
          try {
            await urlsCol.updateOne(
              { url },
              { $setOnInsert: { url, insertedAt: new Date(), scraped: false } },
              { upsert: true }
            );
          } catch {}
        },
      });

      // 2) جامع كامل — يكمل من resume (page) إلى أن يقف
      await collectAllPages({
        browser,
        searchUrl,
        listSelector: cfg.scraping.listSelector,
        viewport: cfg.scraping.viewport,
        userAgents: cfg.scraping.userAgents,
        startPage,
        resumeApi,
        targetName: name,
        saveUrl: async (url) => {
          try {
            await urlsCol.updateOne(
              { url },
              { $setOnInsert: { url, insertedAt: new Date(), scraped: false } },
              { upsert: true }
            );
          } catch {}
        },
      });

      // حساب pending وتخزينه في resume
      const pendingCount = await urlsCol.countDocuments({
        scraped: { $ne: true },
      });
      await updateCounters(resumeFile, name, { pending: pendingCount });

      // 3) تفاصيل — على دفعات
      const concurrency = calcOptimalConcurrency(
        cfg.scraping.maxConcurrentPages
      );
      const batchSize = cfg.scraping.batchSize;
      while (true) {
        const docs = await urlsCol
          .find({ scraped: { $ne: true } }, { projection: { url: 1 } })
          .limit(batchSize)
          .toArray();
        if (!docs.length) break;
        await workerPool({
          browser,
          urlsCol,
          detailsCol,
          docs,
          concurrency,
          resumeFile,
        });
        const left = await urlsCol.countDocuments({ scraped: { $ne: true } });
        await updateCounters(resumeFile, name, { pending: left });
        if (chatId)
          await notify(chatId, `✅ Batch done for *${name}* — left: *${left}*`);
      }

      if (chatId) await notify(chatId, `🏁 Target *${name}* finished`);
    }

    if (chatId) await notify(chatId, "🎉 *All targets finished*");
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}

// graceful save last state on crash
process.on("uncaughtException", async (err) => {
  try {
    logger.error({ err: String(err?.stack || err) }, "uncaughtException");
  } finally {
    process.exit(1);
  }
});
process.on("unhandledRejection", async (err) => {
  try {
    logger.error({ err: String(err) }, "unhandledRejection");
  } finally {
    process.exit(1);
  }
});

if (require.main === module) {
  main().catch((e) => {
    logger.error({ err: String(e?.stack || e) }, "fatal");
    process.exit(1);
  });
}
