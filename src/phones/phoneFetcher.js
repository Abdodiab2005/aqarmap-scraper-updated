require("dotenv").config();
const axios = require("axios");
const fs = require("fs").promises;
const logger = require("../utils/logger");
const { rotate, ensureUp, getPublicIP } = require("../utils/wgcf");
const { refreshAuthViaBrowser } = require("../auth/refresh");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function buildHeaders(auth, referer) {
  return {
    "User-Agent": "...",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Expires: "-1",
    Origin: "https://aqarmap.com.eg",
    Referer: referer || "https://aqarmap.com.eg/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-GPC": "1",
    DNT: "1",
    TE: "Trailers",
    Cookie: auth.cookie || "",
    authorization: auth.authorization || "",
  };
}

async function loadAuth(authFile) {
  try {
    return JSON.parse(await fs.readFile(authFile, "utf8"));
  } catch {
    return { cookie: "", authorization: "" };
  }
}
async function saveAuth(authFile, obj) {
  await fs.writeFile(authFile, JSON.stringify(obj, null, 2));
}

function extractListingId(url) {
  const m = url.match(/listing\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchPhonesOnce({ listingId, isWhatsApp, apiBase, leadEndpoint, headers }) {
  const payload = {
    fullName: "Abdo Diab",
    email: "awkward.anaconda.pszq@rapidletter.net",
    phone: { number: "+447414848196", country_code: "+44" },
    source: "ws-listing_details_fixed_buttons",
    type: isWhatsApp ? 11 : 1,
  };
  const url = `${apiBase}/${listingId}${leadEndpoint}`;
  const res = await axios.post(url, payload, { headers, timeout: 30000 });
  const phones = res?.data?.lead?.listing?.listing_phones || [];
  return { phones: phones.map((p) => p.number), leadId: res?.data?.lead_id };
}

/**
 * Stage التليفونات — متسلسلة (أكثر أمانًا ضد الـ rate limit)
 * - تدوير wgcf بعد N طلبات أو عند 429
 * - عند 401: تدوير + تجديد توكن Headless + إعادة المحاولة
 * - Logs تفصيلية لكل خطوة
 */
async function runPhoneStage({
  baseUrl,
  authFile,
  cookiesFile,
  detailsCollection,
  targetsName,
  cfgPhones, // { apiBase, leadEndpoint, rotateEvery, delayBetween, maxRetries }
}) {
  const rotateEvery = Number(process.env.PHONE_ROTATE_EVERY || cfgPhones.rotateEvery || 8);
  const delayBetween = Number(process.env.PHONE_DELAY_BETWEEN_MS || cfgPhones.delayBetween || 1000);
  const maxRetries = Number(process.env.PHONE_MAX_RETRIES || cfgPhones.maxRetries || 3);

  await ensureUp().catch((e) =>
    logger.warn({ err: String(e?.message || e) }, "[phones] wgcf ensureUp failed (continuing)")
  );
  let auth = await loadAuth(authFile);

  if (!auth.cookie || !auth.authorization) {
    logger.info("[phones] no auth found, refreshing first…");
    auth = await refreshAuthViaBrowser({ baseUrl, cookiesFile, authFile }).catch((e) => {
      logger.warn({ err: String(e?.message || e) }, "[phones] initial refresh failed");
      return auth;
    });
  }

  const query = {
    $or: [{ phoneNumber: null }, { phoneNumber: { $exists: false } }],
  };

  const cursor = detailsCollection.find(query, { projection: { url: 1 } });
  let processed = 0;
  let rotateCounter = 0;
  const t0 = Date.now();

  logger.info({ target: targetsName }, "[phones] starting");

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const listingId = extractListingId(doc.url);
    if (!listingId) {
      logger.debug({ url: doc.url }, "[phones] skipped (no listingId)");
      continue;
    }

    if (rotateCounter >= rotateEvery) {
      const beforeIP = await getPublicIP().catch(() => "");
      logger.info({ rotateEvery, beforeIP }, "[phones] rotating wgcf (periodic)");
      await rotate();
      const afterIP = await getPublicIP().catch(() => "");
      logger.info({ rotateEvery, beforeIP, afterIP }, "[phones] rotate done (periodic)");
      rotateCounter = 0;
      await delay(1200);
    }

    let attempt = 0;
    let ok = false;

    while (attempt < maxRetries && !ok) {
      attempt++;
      try {
        const referer = `https://aqarmap.com.eg/ar/listing/${listingId}/`;
        const headers = buildHeaders(auth, referer);
        logger.debug({ listingId, attempt }, "[phones] request (normal)");
        const { phones, leadId } = await fetchPhonesOnce({
          listingId,
          isWhatsApp: false,
          apiBase: cfgPhones.apiBase,
          leadEndpoint: cfgPhones.leadEndpoint,
          headers,
        });

        await detailsCollection.updateOne(
          { url: doc.url },
          { $set: { phoneNumber: phones || [], phoneUpdatedAt: new Date() } }
        );

        ok = true;
        rotateCounter++;
        processed++;
        await delay(delayBetween);
      } catch (e) {
        const msg = String((e && e.message) || e);
        const status = Number((e?.response?.status) || 0);
        logger.warn({ listingId, attempt, status, err: msg }, "[phones] error");

        if (status === 429) {
          logger.info("[phones] 429 — rotate and retry");
          await rotate();
          await delay(1500);
        } else if (status === 401) {
          logger.info("[phones] 401 — refresh auth and retry");
          try {
            const newAuth = await refreshAuthViaBrowser({ baseUrl, cookiesFile, authFile });
            if (newAuth) {
              auth = newAuth;
              await saveAuth(authFile, auth);
            }
          } catch (e2) {
            logger.warn({ err: String(e2?.message || e2) }, "[phones] refresh failed");
          }
          await delay(1200);
        } else {
          await delay(800 * attempt);
        }
      }
    }
  }

  logger.info({ processed, tookMs: Date.now() - t0 }, "[phones] finished");
}

module.exports = { runPhoneStage };