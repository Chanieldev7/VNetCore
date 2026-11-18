const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../core.js");

const root = path.resolve(__dirname, "..");
const port = (id, number, status = "available", extra = {}) => ({
  id,
  number,
  portKind: "LAN",
  status,
  ...extra,
});

function fixture() {
  return {
    projectName: "Port tools",
    devices: [
      {
        id: "sw",
        name: "Core",
        type: "Switch",
        serialNumber: "SN-1",
        macAddress: "AA:BB:CC:00:00:01",
        manufacturer: "Cisco",
        ports: [
          port("p1", 1, "active", {
            connectionType: "AP",
            connectedTo: "Edge · LAN 1",
            vlan: "10",
            notes: "Lobby",
          }),
          port("p2", 2, "available", { vlan: "99" }),
          port("p3", 3, "no-link"),
        ],
      },
      {
        id: "edge",
        name: "Edge",
        type: "Router",
        ports: [port("e1", 1, "active", { connectedTo: "Core · LAN 1" })],
      },
    ],
    connections: [
      {
        id: "c1",
        firstDeviceId: "sw",
        firstPortId: "p1",
        secondDeviceId: "edge",
        secondPortId: "e1",
      },
    ],
  };
}

function openApp(t, source = fixture()) {
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
  window.matchMedia = () => ({ matches: false });
  window.scrolls = [];
  window.HTMLElement.prototype.scrollIntoView = function (options) {
    window.scrolls.push({ element: this, options });
  };
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.localStorage.setItem("vnetcore.project.v9", JSON.stringify(source));
  ["core.js", "app.js"].forEach((file) =>
    window.eval(fs.readFileSync(path.join(root, file), "utf8")),
  );
  const document = window.document;
  const portButton = (label) =>
    Array.from(document.querySelectorAll("#portGrid .port")).find(
      (button) => button.querySelector(".port-number").textContent === label,
    );
  const stored = () =>
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9"));
  return { window, document, portButton, stored };
}

test("moving port data swaps onto an Available port and re-points the link", () => {
  const moved = Core.movePortData(fixture(), "sw", "p1", "p2");
  const [p1, p2] = moved.devices[0].ports;
  assert.equal(p2.status, "active");
  assert.equal(p2.notes, "Lobby");
  assert.equal(p1.status, "available");
  assert.equal(p1.vlan, "99", "the target's previous data is kept, not lost");
  assert.equal(moved.connections[0].firstPortId, "p2");
  assert.equal(moved.devices[1].ports[0].connectedTo, "Core · LAN 2");
});

test("moving port data refuses ports that are not Available or are linked", () => {
  assert.throws(
    () => Core.movePortData(fixture(), "sw", "p1", "p3"),
    /LAN 3 is not available/,
  );
  assert.throws(
    () => Core.movePortData(fixture(), "sw", "p2", "p1"),
    /LAN 1 is not available/,
  );
  assert.throws(
    () => Core.movePortData(fixture(), "sw", "p1", "p1"),
    /different port/,
  );
});

test("the Move control lists only valid targets, saves, and can be undone", (t) => {
  const { document, portButton, stored } = openApp(t);
  portButton("LAN 1").click();
  const select = document.querySelector("#movePortSelect");
  assert.deepEqual(
    Array.from(select.options).map((option) => option.textContent),
    ["Choose an Available port", "LAN 2"],
  );
  assert.equal(document.querySelector("#movePortBtn").disabled, true);
  select.value = "p2";
  select.dispatchEvent(new document.defaultView.Event("change"));
  document.querySelector("#movePortBtn").click();
  const saved = stored();
  assert.equal(saved.devices[0].ports[1].notes, "Lobby");
  assert.equal(saved.connections[0].firstPortId, "p2");
  assert.equal(
    document.querySelector("#portForm").elements.number.value,
    "LAN 2",
  );
  document.querySelector("#undoBtn").click();
  assert.equal(stored().devices[0].ports[0].notes, "Lobby");
});

test("moving is blocked while either port has an unsaved draft", (t) => {
  const { window, document, portButton, stored } = openApp(t);
  portButton("LAN 1").click();
  const notes = document.querySelector("#portForm").elements.notes;
  notes.value = "Draft";
  notes.dispatchEvent(new window.Event("input", { bubbles: true }));
  const select = document.querySelector("#movePortSelect");
  select.value = "p2";
  select.dispatchEvent(new window.Event("change"));
  document.querySelector("#movePortBtn").click();
  assert.equal(stored().devices[0].ports[0].notes, "Lobby");
});

test("dragging a port onto an Available port moves its data", (t) => {
  const { window, portButton, stored } = openApp(t);
  const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  const fire = (element, type) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    event.dataTransfer = dataTransfer;
    element.dispatchEvent(event);
    return event;
  };
  assert.equal(portButton("LAN 1").draggable, true);
  assert.equal(portButton("LAN 2").dataset.canReceive, "true");
  assert.equal(portButton("LAN 3").dataset.canReceive, "false");
  fire(portButton("LAN 1"), "dragstart");
  assert.equal(
    fire(portButton("LAN 3"), "dragover").defaultPrevented,
    false,
    "a non-Available port is not a drop target",
  );
  assert.equal(fire(portButton("LAN 2"), "dragover").defaultPrevented, true);
  fire(portButton("LAN 2"), "drop");
  assert.equal(stored().devices[0].ports[1].connectionType, "AP");
  assert.equal(window.document.activeElement, portButton("LAN 2"));
});

test("Clear port empties the port, removes its link and can be undone", (t) => {
  const { document, portButton, stored } = openApp(t);
  portButton("LAN 1").click();
  document.querySelector("#clearPortBtn").click();
  const saved = stored();
  const cleared = saved.devices[0].ports[0];
  assert.equal(cleared.status, "available");
  assert.deepEqual(
    [cleared.connectionType, cleared.connectedTo, cleared.vlan, cleared.notes],
    ["", "", "", ""],
  );
  assert.deepEqual(saved.connections, []);
  assert.equal(saved.devices[1].ports[0].connectedTo, "");
  document.querySelector("#undoBtn").click();
  assert.equal(stored().connections.length, 1);
});

test("selecting a port scrolls the editor into view without stealing focus", (t) => {
  const { window, document, portButton } = openApp(t);
  const details = document.querySelector(".card.details");
  details.getBoundingClientRect = () => ({ top: 1400, bottom: 2000 });
  const button = portButton("LAN 2");
  button.focus();
  button.click();
  const last = window.scrolls.at(-1);
  assert.equal(last.element, details);
  assert.equal(last.options.block, "start");
  assert.equal(document.activeElement.dataset.portId, "p2");
  document.querySelector("#backToPortsBtn").click();
  assert.equal(
    window.scrolls.at(-1).element,
    document.querySelector(".ports-card"),
  );
  assert.equal(document.activeElement.dataset.portId, "p2");
});

test("device inventory details are saved, shown, searchable and not copied on duplicate", (t) => {
  const { window, document, stored } = openApp(t);
  const list = document.querySelector("#deviceDetailsList");
  assert.equal(list.hidden, false);
  assert.match(list.textContent, /Serial number\s*SN-1/);
  document.querySelector("#editDeviceBtn").click();
  const form = document.querySelector("#deviceForm");
  assert.equal(document.querySelector(".device-details-fields").open, true);
  assert.equal(form.elements.serialNumber.value, "SN-1");
  form.elements.firmware.value = "IOS-XE 17.9";
  form.elements.deviceNotes.value = "Rack 2";
  form.requestSubmit();
  const device = stored().devices[0];
  assert.equal(device.firmware, "IOS-XE 17.9");
  assert.equal(device.notes, "Rack 2");
  const search = document.querySelector("#deviceSearchInput");
  search.value = "aa:bb:cc";
  search.dispatchEvent(new window.Event("input"));
  assert.equal(document.querySelectorAll("#deviceList .device-item").length, 1);
  search.value = "";
  search.dispatchEvent(new window.Event("input"));
  document.querySelector("#duplicateDeviceBtn").click();
  const copy = stored().devices[1];
  assert.equal(copy.serialNumber, "");
  assert.equal(copy.macAddress, "");
  assert.equal(copy.manufacturer, "Cisco");
});

test("renaming a device updates the link labels the app wrote on its peers", (t) => {
  const source = fixture();
  source.devices[0].ports[1].connectedTo = "Hand-written";
  const { document, stored } = openApp(t, source);
  document.querySelector("#editDeviceBtn").click();
  const form = document.querySelector("#deviceForm");
  form.elements.model.value = "Core MDF";
  form.requestSubmit();
  assert.equal(stored().devices[1].ports[0].connectedTo, "Core MDF · LAN 1");
});

test("device details round-trip through CSV and JSON exports", () => {
  const project = Core.normalizeProject(fixture());
  const fromCsv = Core.csvToProject(Core.projectToCsv(project));
  assert.equal(fromCsv.devices[0].serialNumber, "SN-1");
  assert.equal(fromCsv.devices[0].manufacturer, "Cisco");
  const fromJson = Core.normalizeProject(JSON.parse(JSON.stringify(project)), {
    strict: true,
  });
  assert.equal(fromJson.devices[0].macAddress, "AA:BB:CC:00:00:01");
});

test("CSV values keep their text after the formula guard round trip", () => {
  const source = fixture();
  source.devices[0].ports[0].notes = "- check cable";
  source.devices[0].ports[1].vlan = "=10";
  const back = Core.csvToProject(Core.projectToCsv(source));
  assert.equal(back.devices[0].ports[0].notes, "- check cable");
  assert.equal(back.devices[0].ports[1].vlan, "=10");
});

test("the format guide opens from the Import menu and its templates import cleanly", (t) => {
  const { window, document } = openApp(t);
  const downloads = [];
  window.Blob = class {
    constructor(parts) {
      this.content = parts.join("");
    }
  };
  window.URL.createObjectURL = (blob) => {
    downloads.push(blob.content);
    return "blob:test";
  };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  document.querySelector("#importGuideBtn").click();
  assert.equal(document.querySelector("#importGuideDialog").open, true);
  document.querySelector("#downloadJsonTemplateBtn").click();
  document.querySelector("#downloadCsvTemplateBtn").click();
  assert.equal(downloads.length, 2);
  const [json, csv] = downloads;
  {
    const fromJson = Core.normalizeProject(JSON.parse(json), { strict: true });
    const fromCsv = Core.csvToProject(csv);
    for (const project of [fromJson, fromCsv]) {
      assert.equal(project.devices.length, 2);
      assert.equal(project.connections.length, 1);
      assert.equal(project.devices[0].serialNumber, "FGT60F0000000001");
    }
  }
});

test("the CSV example printed in the guide is a valid import", (t) => {
  const { document } = openApp(t);
  const example = Array.from(
    document.querySelectorAll("#importGuideDialog .guide-code"),
  ).find((block) => block.getAttribute("aria-label") === "CSV example");
  const project = Core.csvToProject(example.textContent);
  assert.equal(project.projectName, "Main office");
  assert.equal(project.devices.length, 2);
  assert.equal(project.connections.length, 1);
  const jsonExample = Array.from(
    document.querySelectorAll("#importGuideDialog .guide-code"),
  ).find((block) => block.getAttribute("aria-label") === "JSON example");
  const fromJson = Core.normalizeProject(JSON.parse(jsonExample.textContent), {
    strict: true,
  });
  assert.equal(fromJson.connections.length, 1);
});

test("boot.js applies the saved theme and pre-collapses panels before first paint", () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      url: "https://vnetcore.test/",
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  window.matchMedia = () => ({ matches: true });
  window.localStorage.setItem("vnetcore.theme.v1", "light");
  window.localStorage.setItem(
    "vnetcore.workspace.v1",
    JSON.stringify({ projects: [{ project: fixture() }] }),
  );
  window.eval(fs.readFileSync(path.join(root, "boot.js"), "utf8"));
  const html = window.document.documentElement;
  assert.equal(html.dataset.theme, "light");
  assert.equal(html.classList.contains("collapse-panels"), true);
  dom.window.close();
});

test("confirmations ask a question and state exactly what will be removed", (t) => {
  const { document } = openApp(t);
  document.querySelector('[aria-label="Delete Core"]').click();
  const dialog = document.querySelector("#confirmDialog");
  assert.equal(dialog.dataset.intent, "danger");
  assert.equal(
    document.querySelector("#confirmDialogTitle").textContent,
    "Delete this device?",
  );
  assert.equal(
    document.querySelector("#confirmDialogMessage").textContent,
    '"Core" will be removed along with its 3 ports and 1 documented link. You can undo this right after.',
  );
  dialog.open = false;
  dialog.dispatchEvent(new document.defaultView.Event("close"));
  document.querySelector("#clearAllBtn").click();
  assert.match(
    document.querySelector("#confirmDialogMessage").textContent,
    /All 2 devices in "Port tools" will be removed along with their 4 ports and 1 documented link\./,
  );
  assert.equal(
    document.querySelector("#confirmDialogAction").textContent,
    "Delete 2 devices",
  );
});

test("network alerts show a severity badge instead of a text prefix", (t) => {
  const source = fixture();
  source.connections.push({
    id: "broken",
    firstDeviceId: "sw",
    firstPortId: "p3",
    secondDeviceId: "gone",
    secondPortId: "x",
  });
  const { document } = openApp(t, source);
  const error = document.querySelector(".network-issue.error h3");
  assert.equal(error.querySelector(".issue-badge").textContent, "Error");
  assert.doesNotMatch(error.textContent, /·/);
});
