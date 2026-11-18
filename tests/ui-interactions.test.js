const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");

function openApp(t, { compact = false, empty = false } = {}) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "index.html"), "utf8"),
    {
      url: "https://vnetcore.test/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  t.after(() => window.close());
  window.matchMedia = (query) => ({
    matches: query.includes("reduced-motion") || compact,
  });
  window.HTMLElement.prototype.scrollIntoView = function (options) {
    window.lastScroll = options;
  };
  if (!empty) {
    window.localStorage.setItem(
      "vnetcore.project.v9",
      JSON.stringify({
        projectName: "Interaction test",
        devices: ["first", "second"].map((id) => ({
          id,
          name: `Switch ${id}`,
          type: "Switch",
          ports: [1, 2].map((number) => ({
            id: `port-${number}`,
            number,
            portKind: "LAN",
            status: "available",
          })),
        })),
      }),
    );
  }
  for (const file of ["core.js", "app.js"]) {
    window.eval(fs.readFileSync(path.join(root, file), "utf8"));
  }
  return { window, document: window.document };
}

test("selection preserves keyboard focus on device and port buttons", (t) => {
  const { document } = openApp(t);
  const device = document.querySelectorAll(".device-item")[1];
  device.focus();
  device.click();
  assert.equal(
    document.activeElement.textContent.includes("Switch second"),
    true,
  );
  assert.equal(document.activeElement.getAttribute("aria-pressed"), "true");

  const port = document.querySelectorAll(".port")[1];
  port.focus();
  port.click();
  assert.equal(document.activeElement.classList.contains("port"), true);
  assert.equal(document.activeElement.getAttribute("aria-pressed"), "true");
  assert.equal(
    document.activeElement.querySelector(".port-number").textContent,
    "LAN 2",
  );
});

test("port drafts survive navigation, remain device-scoped, and save explicitly", (t) => {
  const { window, document } = openApp(t);
  document.querySelector(".port").click();
  const form = document.querySelector("#portForm");
  form.elements.connectedTo.value = "Draft destination";
  form.elements.connectedTo.dispatchEvent(
    new window.Event("input", { bubbles: true }),
  );
  assert.equal(document.querySelector("#portDraftSummary").hidden, false);
  const leaving = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  assert.equal(leaving.defaultPrevented, true);

  document.querySelectorAll(".port")[1].click();
  assert.equal(form.elements.connectedTo.value, "");
  document.querySelector(".port").click();
  assert.equal(form.elements.connectedTo.value, "Draft destination");

  document.querySelectorAll(".device-item")[1].click();
  document.querySelector(".port").click();
  assert.equal(form.elements.connectedTo.value, "");
  document.querySelector(".device-item").click();
  document.querySelector(".port").click();
  assert.equal(form.elements.connectedTo.value, "Draft destination");

  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  const stored = JSON.parse(window.localStorage.getItem("vnetcore.project.v9"));
  assert.equal(stored.devices[0].ports[0].connectedTo, "Draft destination");
  assert.equal(stored.devices[1].ports[0].connectedTo, "");
  assert.equal(document.querySelector("#portDraftSummary").hidden, true);
  const savedLeaving = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(savedLeaving);
  assert.equal(savedLeaving.defaultPrevented, false);
});

test("discarding a draft restores saved values and a visible focus target", (t) => {
  const { window, document } = openApp(t);
  document.querySelector(".port").click();
  const form = document.querySelector("#portForm");
  form.elements.notes.value = "Temporary notes";
  form.elements.notes.dispatchEvent(
    new window.Event("input", { bubbles: true }),
  );
  const discard = document.querySelector("#discardPortDraftBtn");
  discard.focus();
  discard.click();
  assert.equal(form.elements.notes.value, "");
  assert.equal(document.activeElement, form.elements.status);
  assert.equal(discard.hidden, true);
  assert.equal(document.querySelector("#portDraftSummary").hidden, true);
});

test("Edit opens collapsed panels and labels the form correctly", (t) => {
  const { document } = openApp(t, { compact: true });
  assert.equal(document.querySelector(".add-device-card").open, false);
  document.querySelector("#toggleSidebarBtn").click();
  document.querySelector("#editDeviceBtn").click();
  assert.equal(
    document.querySelector("#sidebar").classList.contains("is-collapsed"),
    false,
  );
  assert.equal(
    document.querySelector("#toggleSidebarBtn").getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(document.querySelector(".add-device-card").open, true);
  assert.equal(
    document.querySelector("#deviceFormTitle").textContent,
    "Edit device",
  );
  assert.equal(
    document.activeElement,
    document.querySelector("#deviceForm").elements.model,
  );
  document.querySelector("#cancelDeviceEditBtn").click();
  assert.equal(
    document.querySelector("#deviceFormTitle").textContent,
    "Add device",
  );
});

test("file menus support arrows, Home, End, Escape and focus-out dismissal", (t) => {
  const { window, document } = openApp(t);
  const trigger = document.querySelector("#importMenuBtn");
  const key = (value) =>
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  trigger.focus();
  key("ArrowDown");
  assert.equal(document.activeElement.id, "importJsonBtn");
  key("ArrowUp");
  assert.equal(document.activeElement.id, "importGuideBtn");
  key("Home");
  assert.equal(document.activeElement.id, "importJsonBtn");
  key("End");
  assert.equal(document.activeElement.id, "importGuideBtn");
  key("Escape");
  assert.equal(document.activeElement, trigger);
  assert.equal(document.querySelector("#importMenuOptions").hidden, true);
  key("ArrowUp");
  assert.equal(document.activeElement.id, "importGuideBtn");
  document.querySelector("#exportMenuBtn").focus();
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement.id, "exportMenuBtn");
  trigger.focus();
  key("ArrowDown");
  key("Tab");
  assert.equal(document.querySelector("#importMenuOptions").hidden, true);
  assert.equal(document.activeElement, trigger);
});

test("summary navigation respects reduced motion", (t) => {
  const { window, document } = openApp(t);
  document.querySelectorAll(".summary-device")[1].click();
  assert.equal(window.lastScroll.behavior, "instant");
});

test("empty state action opens the device form even with the panel hidden", (t) => {
  const { document } = openApp(t, { empty: true });
  document.querySelector("#toggleSidebarBtn").click();
  document.querySelector("#portGrid button").click();
  assert.equal(
    document.querySelector("#sidebar").classList.contains("is-collapsed"),
    false,
  );
  assert.equal(document.querySelector(".add-device-card").open, true);
  assert.equal(
    document.activeElement,
    document.querySelector("#deviceForm").elements.model,
  );
});
