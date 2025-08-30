require("dotenv").config();
const os = require("os");
const { exec } = require("child_process");
const util = require("util");
const execp = util.promisify(exec);
const puppeteer = require("puppeteer");
const logger = require("../utils/logger");
const { getBot, init: initTG, sendPhoto, notify } = require("../utils/telegram");
const { getPublicIP, ifaceExists } = require("../utils/wgcf");
const { loadResume } = require("../utils/resume");
const { db: getDb } = require("../db/mongo");

/**
 * Attach Telegram command handlers
 */
async function startTelegramController({ token, chatId, mongoUri, dbName, cfg }) {
  initTG(token, { polling: true });
  const bot = getBot();
  const _db = await getDb(mongoUri, dbName);

  bot.onText(/^\/help$/, async (msg) => {
    if (String(msg.chat.id) !== String(chatId)) return;
    const help = [
      "*Commands:*",
      "/status — حالة التشغيل والـ IP والصفحة الحالية",
      "/stats — إحصائيات عامة (URLs/Details)",
      "/screenshot — لقطة من صفحة البحث الحالية",
      "/sh <command> — تنفيذ أمر شيل (10s timeout)",
    ].join("\n");
    await notify(chatId, help);
  });

  bot.onText(/^\/status$/, async (msg) => {
    if (String(msg.chat.id) !== String(chatId)) return;
    try {
      const ip = await getPublicIP().catch(() => "");
      const wgUp = await ifaceExists();
      const resume = await loadResume(cfg.resumeFile);
      const active = resume.activeTarget || "-";
      const page = (resume.targets?.[active]?.page) || 1;
      const pending = (resume.targets?.[active]?.urls?.pending) ?? "-";
      const collected = (resume.targets?.[active]?.urls?.collected) ?? 0;
      const out = [
        `*Status*`,
        `IP: \`${ip || "?"}\`  WGCF: \`${wgUp ? "UP" : "DOWN"}\``,
        `Active Target: *${active}*  Page: *${page}*`,
        `Collected (run): *${collected}*  Pending: *${pending}*`,
        `Last URL: ${resume.lastUrl || "-"}`,
        `Updated: ${resume.updatedAt || "-"}`,
      ].join("\n");
      await notify(chatId, out);
    } catch (e) {
      await notify(chatId, "status error: " + String(e?.message || e));
    }
  });

  bot.onText(/^\/stats$/, async (msg) => {
    if (String(msg.chat.id) !== String(chatId)) return;
    try {
      const lines = ["*Stats*"];
      for (const t of cfg.targets) {
        const urlsCol = _db.collection(`${t.name}_urls`);
        const detailsCol = _db.collection(t.name);
        const totalUrls = await urlsCol.estimatedDocumentCount();
        const scraped = await urlsCol.countDocuments({ scraped: true });
        const pending = await urlsCol.countDocuments({ scraped: { $ne: true } });
        const detailsCount = await detailsCol.estimatedDocumentCount();
        lines.push(
          `• *${t.name}* — URLs: *${totalUrls}* (scraped: ${scraped}, pending: ${pending}) — Details: *${detailsCount}*`
        );
      }
      await notify(chatId, lines.join("\n"));
    } catch (e) {
      await notify(chatId, "stats error: " + String(e?.message || e));
    }
  });

  bot.onText(/^\/screenshot$/, async (msg) => {
    if (String(msg.chat.id) !== String(chatId)) return;
    let browser;
    try {
      const resume = await loadResume(cfg.resumeFile);
      const active = resume.activeTarget || cfg.targets[0].name;
      const target = cfg.targets.find((x) => x.name === active) || cfg.targets[0];
      const pageNum = (resume.targets?.[active]?.page) || 1;
      const url = `${target.url}${target.url.includes("?") ? "&" : "?"}page=${pageNum}`;

      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"],
        defaultViewport: cfg.scraping.viewport,
      });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1200);
      const buf = await page.screenshot({ fullPage: true });
      await sendPhoto(chatId, buf, `Screenshot: ${url}`);
      await page.close();
    } catch (e) {
      await notify(chatId, "screenshot error: " + String(e?.message || e));
    } finally {
      try { await browser?.close(); } catch {}
    }
  });

  // /sh <command>
  bot.onText(/^\/sh (.+)$/s, async (msg, match) => {
    if (String(msg.chat.id) !== String(chatId)) return;
    const cmd = (match?.[1] || "").trim();
    if (!cmd) return notify(chatId, "Usage: /sh <command>");
    try {
      const { stdout, stderr } = await execp(cmd, { timeout: 10_000 });
      let out = stdout || stderr || "(no output)";
      if (out.length > 3800) out = out.slice(0, 3800) + "\n...(truncated)";
      await notify(chatId, "```\n" + out + "\n```");
    } catch (e) {
      let out = String(e?.stderr || e?.stdout || e?.message || e);
      if (out.length > 3800) out = out.slice(0, 3800) + "\n...(truncated)";
      await notify(chatId, "```\n" + out + "\n```");
    }
  });

  logger.info("[tg] Telegram controller started");
  await notify(chatId, "🤖 Telegram controller *ready*");
}

module.exports = { startTelegramController };