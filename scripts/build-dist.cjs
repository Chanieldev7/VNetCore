// Builds dist/, the only folder that gets published:
//
//   dist/            the landing page (landing.html becomes index.html)
//   dist/app/        the application, with its own copy of what it needs
//
// Only the files the browser needs are copied, so deployments never publish
// node_modules, tests, agent tooling or source images by accident. The app
// gets a generated dist/app/sw.js with the exact file list and a content hash,
// so every deploy gets a fresh offline cache. The service worker lives inside
// /app/, so its scope never reaches the landing page.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const appDist = path.join(dist, "app");

// [source, destination relative to the output folder]
const landingEntries = [
  ["landing.html", "index.html"],
  ["landing.css", "landing.css"],
  ["landing.js", "landing.js"],
  ["assets/fonts.css", "assets/fonts.css"],
  ["assets/fonts", "assets/fonts"],
  ["img/VnetCore-logo-108.png", "img/VnetCore-logo-108.png"],
  ["img/VnetCore-logo-192.png", "img/VnetCore-logo-192.png"],
  ["img/cjota-logo-80.webp", "img/cjota-logo-80.webp"],
  ["img/landing-ports.webp", "img/landing-ports.webp"],
  ["img/landing-rack.webp", "img/landing-rack.webp"],
  ["img/landing-links.webp", "img/landing-links.webp"],
];

const appEntries = [
  "index.html",
  "boot.js",
  "app.js",
  "date-picker.js",
  "core.js",
  "demo-project.js",
  "styles.css",
  "manifest.webmanifest",
  "assets",
  // Only the images the app references; the large source artwork stays out.
  "img/VnetCore-logo-108.png",
  "img/VnetCore-logo-192.png",
  "img/VnetCore-logo-512.png",
  "img/cjota-logo-80.webp",
  "img/cjota-logo-120.webp",
].map((entry) => [entry, entry]);

async function listFiles(directory) {
  const items = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    items.map((item) => {
      const full = path.join(directory, item.name);
      return item.isDirectory() ? listFiles(full) : [full];
    }),
  );
  return files.flat();
}

async function copyEntries(entries, target) {
  for (const [source, destination] of entries) {
    const to = path.join(target, destination);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(path.join(root, source), to, { recursive: true });
  }
}

// In the repository the landing page links to the app at "./" so that
// `npm run dev` keeps working; once published the app lives at /app/.
async function pointLandingToApp() {
  const file = path.join(dist, "index.html");
  const html = await fs.readFile(file, "utf8");
  const pattern = /href="\.\/(\?demo=1)?"/g;
  const count = (html.match(pattern) || []).length;
  if (!count) {
    throw new Error('landing.html has no href="./" links to rewrite.');
  }
  await fs.writeFile(file, html.replace(pattern, 'href="app/$1"'));
  return count;
}

async function writeServiceWorker() {
  const files = (await listFiles(appDist))
    .map((file) => path.relative(appDist, file).split(path.sep).join("/"))
    // License notices ship with the site but are not needed offline.
    .filter((file) => !/\.txt$/i.test(file))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(await fs.readFile(path.join(appDist, file)));
  }
  const template = await fs.readFile(
    path.join(root, "scripts", "sw-template.js"),
    "utf8",
  );
  const precache = ["./", ...files];
  const worker = template
    .replace("__VERSION__", hash.digest("hex").slice(0, 12))
    .replace("__PRECACHE__", JSON.stringify(precache, null, 2));
  await fs.writeFile(path.join(appDist, "sw.js"), worker);
  return precache.length;
}

async function main() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(appDist, { recursive: true });
  await copyEntries(landingEntries, dist);
  await copyEntries(appEntries, appDist);
  const rewritten = await pointLandingToApp();
  const cached = await writeServiceWorker();
  console.log(
    `dist/ ready: landing at /, app at /app/ (${rewritten} links rewritten); app/sw.js precaches ${cached} files.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
