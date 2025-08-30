require("dotenv").config();
const { MongoClient } = require("mongodb");
const logger = require("./src/utils/logger");
const { runPhoneStage } = require("./src/phones/phoneFetcher");
const cfg = require("./src/config");

async function main() {
  logger.info("[phones] standalone runner starting…");

  const client = new MongoClient(cfg.mongo.uri, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(cfg.mongo.dbName);

  const targets = cfg.targets.map(t => ({ url: t.url, name: t.name }));

  for (const target of targets) {
    const detailsCollection = db.collection(target.name);
    logger.info({ target: target.name, url: target.url }, "☎️ starting phones (standalone)");

    await runPhoneStage({
      baseUrl: cfg.baseUrl,
      authFile: cfg.authFile,
      cookiesFile: cfg.cookiesFile,
      detailsCollection,
      targetsName: target.name,
      cfgPhones: cfg.phones,
    });
  }

  await client.close();
  logger.info("[phones] done");
}

main().catch((e) => {
  logger.error({ err: String(e?.stack || e) }, "phones fatal");
  process.exit(1);
});