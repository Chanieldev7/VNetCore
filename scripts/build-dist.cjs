// Copies only the files the browser needs into dist/, so deployments never
// publish node_modules, tests, agent tooling or source images by accident.
// It then generates dist/sw.js with the exact file list and a content hash, so
// every deploy gets a fresh offline cache.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const entries = [
  "index.html",
  "landing.html",
  "landing.css",
  "landing.js",
  "demo-project.js",
  "boot.js",
  "app.js",
  "date-picker.js",
  "core.js",
  "styles.css",
  "manifest.webmanifest",
  "assets",
  // Only the images the app and landing page reference; source artwork stays out.
  "img/VnetCore-logo-108.png",
  "img/VnetCore-logo-192.png",
  "img/VnetCore-logo-512.png",
  "img/cjota-logo-80.webp",
  "img/cjota-logo-120.webp",
  "img/landing-ports.webp",
  "img/landing-rack.webp",
  "img/landing-links.webp",
];

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

async function writeServiceWorker() {
  const files = (await listFiles(dist))
    .map((file) => path.relative(dist, file).split(path.sep).join("/"))
    // License notices ship with the site but are not needed offline.
    .filter((file) => !/\.txt$/i.test(file))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(await fs.readFile(path.join(dist, file)));
  }
  const template = await fs.readFile(
    path.join(root, "scripts", "sw-template.js"),
    "utf8",
  );
  const precache = ["./", ...files];
  const worker = template
    .replace("__VERSION__", hash.digest("hex").slice(0, 12))
    .replace("__PRECACHE__", JSON.stringify(precache, null, 2));
  await fs.writeFile(path.join(dist, "sw.js"), worker);
  return precache.length;
}

async function main() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });
  for (const entry of entries) {
    await fs.cp(path.join(root, entry), path.join(dist, entry), {
      recursive: true,
    });
  }
  const cached = await writeServiceWorker();
  console.log(
    `dist/ ready with ${entries.length} entries; sw.js precaches ${cached} files.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
