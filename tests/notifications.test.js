const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const initial = {
  projectName: "Toast tests",
  devices: [
    {
      id: "switch",
      name: "Office switch",
      type: "Switch",
      ports: [{ id: "p1", number: 1, portKind: "LAN", status: "available" }],
    },
  ],
};

async function openApp(t) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "index.html"), "utf8"),
    {
      url: "https://vnetcore.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const { window } = dom;
  window.matchMedia = (query) => ({
    matches: query.includes("reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function (value) {
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  window.localStorage.setItem("vnetcore.project.v9", JSON.stringify(initial));
  for (const file of ["assets/notifications.js", "core.js", "app.js"]) {
    window.eval(fs.readFileSync(path.join(root, file), "utf8"));
  }
  const settle = () =>
    new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
    );
  await settle();
  const latest = () =>
    window.document.querySelector(
      '#toastRoot [data-sonner-toast][data-index="0"] .vnet-toast',
    );
  return { window, document: window.document, settle, latest };
}

test("the real Sonner bundle mounts once and shows a success with a working Undo action", async (t) => {
  const { window, document, settle, latest } = await openApp(t);
  assert.equal(
    document.querySelectorAll('#toastRoot section[aria-live="polite"]').length,
    1,
  );
  document.querySelector("#duplicateDeviceBtn").click();
  await settle();
  assert.equal(latest().dataset.kind, "success");
  assert.match(latest().textContent, /Duplicated Office switch/);
  assert.equal(document.querySelector("#notification").hidden, true);
  assert.equal(
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9")).devices
      .length,
    2,
  );
  latest().querySelector(".vnet-toast-actions button").click();
  await settle();
  assert.equal(
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9")).devices
      .length,
    1,
  );
  assert.match(latest().textContent, /Change undone/);
  assert.equal(document.activeElement.classList.contains("device-item"), true);
});

test("deletion is confirmed in a styled dialog, cancellation is safe and success appears only after confirmation", async (t) => {
  const { window, document, settle, latest } = await openApp(t);
  document.querySelector(".delete-btn").click();
  const dialog = document.querySelector("#confirmDialog");
  assert.equal(dialog.dataset.intent, "danger");
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement.id, "confirmDialogCancel");
  assert.match(
    document.querySelector("#confirmDialogMessage").textContent,
    /Office switch/,
  );
  dialog.close("cancel");
  await settle();
  assert.equal(document.querySelectorAll(".device-item").length, 1);
  assert.equal(latest(), null);
  document.querySelector(".delete-btn").click();
  dialog.close("default");
  await settle();
  assert.equal(
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9")).devices
      .length,
    0,
  );
  assert.match(latest().textContent, /Deleted Office switch/);
  assert.equal(
    latest().querySelector(".vnet-toast-actions button").textContent,
    "Undo",
  );
});

test("a previous confirmed dialog cannot make a later Escape cancellation destructive", async (t) => {
  const { window, document, settle } = await openApp(t);
  document.querySelector(".delete-btn").click();
  const dialog = document.querySelector("#confirmDialog");
  dialog.close("default");
  await settle();
  document.querySelector("#newBlankProjectBtn").click();
  assert.equal(dialog.returnValue, "cancel");
  assert.equal(dialog.dataset.intent, "neutral");
  dialog.close();
  await settle();
  const workspace = JSON.parse(
    window.localStorage.getItem("vnetcore.workspace.v1"),
  );
  assert.equal(workspace.projects.length, 1);
});

test("a failed local write shows a persistent error with recovery instead of a false success", async (t) => {
  const { window, document, settle, latest } = await openApp(t);
  const original = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = function (key, value) {
    if (key === "vnetcore.project.v9")
      throw new window.DOMException("Storage is full", "QuotaExceededError");
    return original.call(this, key, value);
  };
  document.querySelector("#duplicateDeviceBtn").click();
  await settle();
  assert.equal(latest().dataset.kind, "error");
  assert.match(latest().textContent, /could not be saved|Storage is full/);
  assert.match(
    latest().querySelector(".vnet-toast-actions button").textContent,
    /Download recovery/,
  );
  assert.equal(
    document.querySelectorAll('.vnet-toast[data-kind="success"]').length,
    0,
  );
});

test("the recovery action downloads a copy without changing saved data", async (t) => {
  const { window, document, settle, latest } = await openApp(t);
  const saved = window.localStorage.getItem("vnetcore.project.v9");
  const original = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = function (key, value) {
    if (key === "vnetcore.project.v9")
      throw new window.DOMException("Storage is full", "QuotaExceededError");
    return original.call(this, key, value);
  };
  let downloaded;
  window.URL.createObjectURL = () => "blob:recovery-test";
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {
    downloaded = this.download;
  };
  document.querySelector("#duplicateDeviceBtn").click();
  await settle();
  latest().querySelector(".vnet-toast-actions button").click();
  await settle();
  assert.match(downloaded, /recovery\.json$/);
  assert.equal(window.localStorage.getItem("vnetcore.project.v9"), saved);
  assert.match(latest().textContent, /Backup exported/);
});

test("Sonner follows the chosen theme without mounting a second toaster", async (t) => {
  const { window, document, settle } = await openApp(t);
  window.VNetCoreNotifications.show("Saved");
  await settle();
  assert.equal(
    document.querySelector("[data-sonner-toaster]").dataset.sonnerTheme,
    "dark",
  );
  document.querySelector("#themeToggleBtn").click();
  await settle();
  assert.equal(
    document.querySelector("[data-sonner-toaster]").dataset.sonnerTheme,
    "light",
  );
  assert.equal(
    document.querySelectorAll('#toastRoot section[aria-live="polite"]').length,
    1,
  );
});

test("the Sonner bridge supports warning, info and safe text content", async (t) => {
  const { window, document, settle, latest } = await openApp(t);
  window.VNetCoreNotifications.show('<img src=x onerror="alert(1)">', {
    type: "warning",
    persistent: true,
  });
  await settle();
  assert.equal(latest().dataset.kind, "warning");
  assert.match(latest().textContent, /<img src=x/);
  assert.equal(document.querySelector("#toastRoot img"), null);
  window.VNetCoreNotifications.show("Project opened", { type: "info" });
  await settle();
  assert.equal(latest().dataset.kind, "info");
});

test("the production bundle uses external Sonner CSS and preserves the restrictive CSP", () => {
  const bundle = fs.readFileSync(
    path.join(root, "assets/notifications.js"),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(root, "assets/notifications.css"),
    "utf8",
  );
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.equal(bundle.includes("[data-sonner-toaster][dir=ltr]"), false);
  assert.match(css, /data-sonner-toaster/);
  assert.match(html, /href="assets\/notifications.css"/);
  assert.equal(html.includes("'unsafe-inline'"), false);
  assert.equal(html.includes("'unsafe-eval'"), false);
});
