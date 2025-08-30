const fs = require("fs").promises;
const path = require("path");
const logger = require("./logger");

async function readJSONSafe(file, def = {}) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return def;
  }
}
async function writeJSONAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp`);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
  return file;
}

function ensureTarget(resume, targetName) {
  if (!resume.targets) resume.targets = {};
  if (!resume.targets[targetName]) resume.targets[targetName] = { page: 1, urls: { collected: 0, pending: 0 } };
  return resume;
}

/**
 * Load resume.json (or create structure in memory only)
 */
async function loadResume(file) {
  const data = await readJSONSafe(file, { activeTarget: null, targets: {}, lastUrl: null, updatedAt: null });
  return data;
}
async function saveResume(file, resume) {
  resume.updatedAt = new Date().toISOString();
  await writeJSONAtomic(file, resume);
  return resume;
}

async function updatePage(file, targetName, page) {
  const resume = await loadResume(file);
  ensureTarget(resume, targetName);
  resume.activeTarget = targetName;
  resume.targets[targetName].page = page;
  await saveResume(file, resume);
  return resume;
}

async function updateCounters(file, targetName, { collectedDelta = 0, pending = null } = {}) {
  const resume = await loadResume(file);
  ensureTarget(resume, targetName);
  const t = resume.targets[targetName];
  t.urls.collected += collectedDelta;
  if (pending !== null) t.urls.pending = pending;
  await saveResume(file, resume);
  return resume;
}

async function updateLastUrl(file, url) {
  const resume = await loadResume(file);
  resume.lastUrl = url || null;
  await saveResume(file, resume);
  return resume;
}

module.exports = {
  loadResume,
  saveResume,
  ensureTarget,
  updatePage,
  updateCounters,
  updateLastUrl,
};