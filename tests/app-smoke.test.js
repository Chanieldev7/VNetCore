const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");

test("application initializes and persists a device and port update", async () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "https://vnetcore.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function close(value = "") {
    this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };

  window.eval(fs.readFileSync(path.join(root, "core.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(root, "app.js"), "utf8"));

  const form = window.document.querySelector("#deviceForm");
  const customTypeLabel = window.document.querySelector(
    "#customDeviceTypeLabel",
  );
  assert.equal(customTypeLabel.classList.contains("visible"), false);
  assert.equal(form.elements.customType.disabled, true);
  form.elements.type.value = "Other";
  form.elements.type.dispatchEvent(
    new window.Event("change", { bubbles: true }),
  );
  assert.equal(customTypeLabel.classList.contains("visible"), true);
  assert.equal(form.elements.customType.disabled, false);
  form.elements.model.value = "Core router";
  form.elements.type.value = "Router";
  form.elements.type.dispatchEvent(
    new window.Event("change", { bubbles: true }),
  );
  assert.equal(customTypeLabel.classList.contains("visible"), false);
  assert.equal(form.elements.customType.disabled, true);
  form.elements.location.value = "MDF";
  form.elements.portLayout.value = "split";
  form.elements.wanPorts.value = "0";
  form.elements.lanPorts.value = "8";
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );

  assert.equal(window.document.querySelectorAll(".device-item").length, 1);
  assert.equal(window.document.querySelectorAll(".port").length, 8);
  assert.equal(
    window.document.querySelectorAll(".print-summary-device").length,
    1,
  );
  assert.equal(window.document.querySelectorAll(".print-port").length, 8);
  assert.equal(
    window.document.querySelector("#deviceName").textContent,
    "Core router",
  );
  const portGrid = window.document.querySelector("#portGrid");
  assert.equal(portGrid.dataset.layout, "split");
  assert.equal(portGrid.style.getPropertyValue("--port-columns"), "4");
  assert.deepEqual(
    Array.from(
      portGrid.querySelectorAll(".port-number"),
      (port) => port.textContent,
    ),
    ["LAN 1", "LAN 2", "LAN 3", "LAN 4", "LAN 5", "LAN 6", "LAN 7", "LAN 8"],
  );

  window.document.querySelector("#editDeviceBtn").click();
  form.elements.portLayout.value = "alternating";
  form.elements.portLayout.dispatchEvent(
    new window.Event("change", { bubbles: true }),
  );
  assert.equal(portGrid.dataset.layout, "alternating");
  window.document.querySelector("#cancelDeviceEditBtn").click();
  assert.equal(portGrid.dataset.layout, "split");

  window.document.querySelector("#editDeviceBtn").click();
  form.elements.portLayout.value = "alternating";
  form.elements.portLayout.dispatchEvent(
    new window.Event("change", { bubbles: true }),
  );
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.equal(portGrid.dataset.layout, "alternating");

  const firstPort = window.document.querySelector(".port");
  firstPort.click();
  const portForm = window.document.querySelector("#portForm");
  portForm.elements.status.value = "active";
  portForm.elements.connectedTo.value = "ISP router";
  portForm.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );

  const stored = JSON.parse(window.localStorage.getItem("vnetcore.project.v9"));
  assert.equal(stored.schemaVersion, 9);
  assert.equal(stored.devices.length, 1);
  assert.equal(stored.devices[0].portLayout, "alternating");
  assert.equal(stored.devices[0].ports[0].status, "active");
  assert.equal(stored.devices[0].ports[0].connectedTo, "ISP router");
  assert.match(
    window.document.querySelector("#saveStatus").textContent,
    /Saved locally/,
  );

  window.document.querySelector("#newBlankProjectBtn").click();
  const confirmDialog = window.document.querySelector("#confirmDialog");
  assert.equal(confirmDialog.open, true);
  assert.equal(window.document.querySelectorAll(".device-item").length, 1);
  confirmDialog.close("default");
  await Promise.resolve();
  const blankProject = JSON.parse(
    window.localStorage.getItem("vnetcore.project.v9"),
  );
  assert.equal(blankProject.projectName, "Unnamed project");
  assert.equal(blankProject.devices.length, 0);
  assert.equal(window.document.querySelectorAll(".device-item").length, 0);
  assert.equal(window.document.querySelector("#undoBtn").hidden, false);

  dom.window.close();
});
