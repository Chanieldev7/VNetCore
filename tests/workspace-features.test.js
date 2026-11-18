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

function fixture(extra = {}) {
  return {
    projectName: "Features",
    devices: [
      {
        id: "sw1",
        name: "Core",
        type: "Switch",
        serialNumber: "SN-1",
        macAddress: "aa:bb:cc:00:00:01",
        rack: "Rack A",
        rackUnit: 40,
        rackHeight: 2,
        ports: [
          port("a1", 1, "active", { connectedTo: "AP" }),
          port("a2", 2),
          port("a3", 3),
          port("a4", 4),
        ],
      },
      {
        id: "sw2",
        name: "Access",
        type: "Switch",
        serialNumber: "sn-1 ",
        macAddress: "AABB.CC00.0001",
        rack: "rack a",
        rackUnit: 41,
        ports: [port("b1", 1)],
      },
      { id: "fw", name: "Firewall", type: "Firewall", ports: [port("c1", 1)] },
    ],
    ...extra,
  };
}

function openApp(t, source = fixture()) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "index.html"), "utf8"),
    {
      url: "https://vnetcore.test/app/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.scrolls = [];
  window.HTMLElement.prototype.scrollIntoView = function () {
    window.scrolls.push(this);
  };
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.printed = 0;
  window.print = () => {
    window.printed += 1;
  };
  window.localStorage.setItem("vnetcore.project.v9", JSON.stringify(source));
  const files = ["core.js", "app.js"];
  files.forEach((file) =>
    window.eval(fs.readFileSync(path.join(root, file), "utf8")),
  );
  const document = window.document;
  const stored = () =>
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9"));
  const portButton = (label) =>
    Array.from(document.querySelectorAll("#portGrid .port")).find(
      (button) => button.querySelector(".port-number").textContent === label,
    );
  const click = (element, init = {}) =>
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, ...init }),
    );
  return { window, document, stored, portButton, click };
}

function isoDaysFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("the review date is a record shown on the card, never an alert", (t) => {
  for (const offset of [-400, -3, 0, 60]) {
    const { document } = openApp(
      t,
      fixture({ reviewDate: isoDaysFromToday(offset) }),
    );
    const status = document.querySelector("#projectReviewStatus");
    assert.equal(status.hidden, false);
    assert.match(
      status.textContent,
      /^Reviewed on [A-Z][a-z]{2} \d{1,2}, \d{4}$/,
    );
    assert.doesNotMatch(status.textContent, /due|overdue|next/i);
    assert.equal(
      Array.from(document.querySelectorAll(".network-issue h3")).some((h) =>
        /review/i.test(h.textContent.replace(/^Review/, "")),
      ),
      false,
    );
    assert.equal(
      document.querySelector('#networkAlertFilter option[value="review-date"]'),
      null,
    );
  }
});

test("without a review date the card shows nothing", (t) => {
  const { document } = openApp(t, fixture());
  assert.equal(document.querySelector("#projectReviewStatus").hidden, true);
});

test("duplicate serials, MACs and rack overlaps are reported per device", () => {
  const issues = Core.analyzeNetwork(Core.normalizeProject(fixture()));
  const titles = issues.map((issue) => issue.title);
  assert.ok(titles.includes("Duplicate serial number"));
  assert.ok(titles.includes("Duplicate MAC address"));
  const overlap = issues.find((issue) => issue.code === "rack-overlap");
  assert.deepEqual(overlap.devices, ["sw1", "sw2"]);
  assert.equal(Core.canonicalMac("AABB.CC00.0001"), "aa:bb:cc:00:00:01");
  assert.equal(Core.canonicalMac("not a mac"), "");
});

test("device alerts open the affected device", (t) => {
  const { document } = openApp(t);
  const filter = document.querySelector("#networkAlertFilter");
  filter.value = "duplicate-inventory";
  filter.dispatchEvent(new document.defaultView.Event("change"));
  const open = Array.from(
    document.querySelectorAll(".network-issue-action"),
  ).find((button) => button.textContent === "Open Access");
  open.click();
  assert.equal(document.querySelector("#deviceName").textContent, "Access");
});

test("bulk edit selects a range and updates only the chosen fields", (t) => {
  const { document, stored, portButton, click } = openApp(t);
  document.querySelector("#bulkModeBtn").click();
  assert.equal(document.querySelector("#bulkTools").hidden, false);
  click(portButton("LAN 2"));
  click(portButton("LAN 4"), { shiftKey: true });
  assert.match(
    document.querySelector("#bulkCount").textContent,
    /3 ports selected/,
  );
  assert.equal(portButton("LAN 3").getAttribute("aria-pressed"), "true");
  assert.equal(portButton("LAN 1").getAttribute("aria-pressed"), "false");
  assert.ok(portButton("LAN 3").querySelector(".port-bulk-check"));
  document.querySelector("#bulkVlan").value = "30 / Cameras";
  document.querySelector("#bulkApplyBtn").click();
  const ports = stored().devices[0].ports;
  assert.deepEqual(
    ports.map((item) => item.vlan),
    ["", "30 / Cameras", "30 / Cameras", "30 / Cameras"],
  );
  assert.equal(ports[1].status, "available", "status was left unchanged");
  document.querySelector("#undoBtn").click();
  assert.equal(stored().devices[0].ports[1].vlan, "");
});

test("bulk edit asks for a change and clears when another device opens", (t) => {
  const { document, stored, portButton, click } = openApp(t);
  document.querySelector("#bulkModeBtn").click();
  click(portButton("LAN 2"));
  const before = JSON.stringify(stored());
  document.querySelector("#bulkApplyBtn").click();
  assert.equal(JSON.stringify(stored()), before);
  document.querySelectorAll("#deviceList .device-item")[1].click();
  assert.match(
    document.querySelector("#bulkCount").textContent,
    /0 ports selected/,
  );
});

test("rack fields are validated, saved, and drawn in the rack view", (t) => {
  const { document, stored } = openApp(t);
  const racks = document.querySelectorAll("#rackView .rack");
  assert.equal(racks.length, 1, "Rack A and rack a are the same rack");
  const blocks = racks[0].querySelectorAll(".rack-device");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].style.gridRow, "2 / span 1");
  assert.ok(blocks[0].classList.contains("is-conflict"));
  assert.match(document.querySelector("#rackUnplaced").textContent, /Firewall/);

  document.querySelectorAll("#deviceList .device-item")[2].click();
  document.querySelector("#editDeviceBtn").click();
  const form = document.querySelector("#deviceForm");
  form.elements.rackUnit.value = "10";
  form.requestSubmit();
  assert.equal(
    stored().devices[2].rackUnit ?? null,
    null,
    "a rack name is required",
  );
  form.elements.rack.value = "Rack B";
  form.elements.rackHeight.value = "2";
  form.requestSubmit();
  const firewall = stored().devices[2];
  assert.deepEqual(
    [firewall.rack, firewall.rackUnit, firewall.rackHeight],
    ["Rack B", 10, 2],
  );
  assert.equal(document.querySelectorAll("#rackView .rack").length, 2);
  assert.match(
    document.querySelector("#deviceDetailsList").textContent,
    /Rack B · U10–U11/,
  );
});

test("rack placement survives CSV and JSON round trips", () => {
  const project = Core.normalizeProject(fixture());
  const fromCsv = Core.csvToProject(Core.projectToCsv(project));
  assert.deepEqual(
    fromCsv.devices.map((device) => [
      device.rack,
      device.rackUnit,
      device.rackHeight,
    ]),
    [
      ["Rack A", 40, 2],
      ["rack a", 41, 1],
      ["", null, 1],
    ],
  );
  const invalid = Core.normalizeProject({
    devices: [{ name: "X", rackUnit: 99, rackHeight: 0, ports: [] }],
  });
  assert.equal(invalid.devices[0].rackUnit, null);
  assert.equal(invalid.devices[0].rackHeight, 1);
});

test("dist build precaches the app shell and leaves source artwork out", () => {
  const worker = fs.readFileSync(path.join(root, "dist", "sw.js"), "utf8");
  const precache = JSON.parse(
    worker.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1],
  );
  for (const file of ["./", "index.html", "app.js", "core.js", "styles.css"]) {
    assert.ok(precache.includes(file), `${file} is precached`);
  }
  assert.ok(
    !precache.some((file) => /VnetCore logo\.png|cjota_logo\.png/.test(file)),
  );
  assert.match(worker, /const VERSION = "[0-9a-f]{12}";/);
});

function rackFixture() {
  const device = (id, name, rackUnit, rackHeight = 1) => ({
    id,
    name,
    type: "Switch",
    rack: "MDF",
    rackUnit,
    rackHeight,
    ports: [port(`${id}-1`, 1, "active", { connectedTo: "x" })],
  });
  return {
    projectName: "Racks",
    devices: [
      device("top", "Top", 42),
      device("mid", "Middle", 40, 2),
      device("low", "Low", 10),
      { id: "loose", name: "Loose", type: "Other", ports: [port("l1", 1)] },
    ],
  };
}

test("rack devices draw as hardware with status-coloured jacks", (t) => {
  const { document } = openApp(t, rackFixture());
  const top = document.querySelector('.rack-device[data-device-id="top"]');
  assert.equal(top.dataset.kind, "switch");
  assert.equal(top.querySelectorAll(".rack-ear").length, 2);
  assert.ok(top.querySelector(".rack-jack.active"));
  assert.equal(
    top.querySelector(".rack-face").getAttribute("aria-hidden"),
    "true",
  );
  assert.match(top.textContent, /Top/);
});

test("arrow keys move a rack device to the next free position", (t) => {
  const { window, document, stored } = openApp(t, rackFixture());
  const key = (id, value) =>
    document
      .querySelector(`.rack-device[data-device-id="${id}"]`)
      .dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
  key("low", "ArrowUp");
  assert.equal(stored().devices[2].rackUnit, 11);
  // Middle (U40–41) moving down skips nothing: U39 is free.
  key("mid", "ArrowDown");
  assert.equal(stored().devices[1].rackUnit, 39);
  // Top is at the top of the rack: nothing above, so it stays.
  key("top", "ArrowUp");
  assert.equal(stored().devices[0].rackUnit, 42);
});

test("dropping on a free unit moves the device; occupied units refuse it", (t) => {
  const { window, document, stored } = openApp(t, rackFixture());
  const slots = document.querySelector(".rack-slots");
  // 42 units of 10px each, starting at y = 0.
  slots.getBoundingClientRect = () => ({ top: 0, height: 420, left: 0 });
  const yFor = (unit) => (42 - unit) * 10 + 5;
  const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  const fire = (element, type, unit) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    event.dataTransfer = dataTransfer;
    event.clientY = unit ? yFor(unit) : 0;
    element.dispatchEvent(event);
    return event;
  };
  const low = document.querySelector('.rack-device[data-device-id="low"]');
  fire(low, "dragstart");
  assert.equal(
    fire(slots, "dragover", 41).defaultPrevented,
    false,
    "U41 is taken",
  );
  assert.equal(fire(slots, "dragover", 20).defaultPrevented, true);
  fire(slots, "drop", 20);
  assert.equal(stored().devices[2].rackUnit, 20);

  const loose = Array.from(
    document.querySelectorAll(".rack-unplaced-list button"),
  ).find((button) => button.textContent === "Loose");
  fire(loose, "dragstart");
  const freshSlots = document.querySelector(".rack-slots");
  freshSlots.getBoundingClientRect = slots.getBoundingClientRect;
  fire(freshSlots, "dragover", 5);
  fire(freshSlots, "drop", 5);
  const placed = stored().devices[3];
  assert.deepEqual([placed.rack, placed.rackUnit], ["MDF", 5]);
});

test("the project rack size sets the rack height and limits positions", (t) => {
  const source = rackFixture();
  source.rackUnits = 20;
  source.devices[0].rackUnit = 18;
  source.devices[1].rackUnit = 15;
  const { window, document, stored } = openApp(t, source);
  const select = document.querySelector("#projectRackUnitsSelect");
  assert.equal(select.value, "20");
  assert.match(
    document.querySelector(".rack-header small").textContent,
    /of 20U used/,
  );
  assert.equal(document.querySelectorAll(".rack-scale span").length, 20);
  assert.equal(
    document.querySelector("#deviceForm").elements.rackUnit.max,
    "20",
  );

  // A device that would end above U20 is refused by the form.
  document.querySelector("#editDeviceBtn").click();
  const form = document.querySelector("#deviceForm");
  form.elements.rackUnit.value = "20";
  form.elements.rackHeight.value = "2";
  form.requestSubmit();
  assert.equal(stored().devices[0].rackUnit ?? 18, 18);

  // Shrinking below a placed device keeps it visible and raises an alert.
  select.value = "15";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(stored().rackUnits, 15);
  assert.ok(document.querySelector(".rack-overflow-zone"));
  assert.match(
    document.querySelector(".rack-overflow-zone").textContent,
    /Above 15U/,
  );
  assert.ok(
    Array.from(document.querySelectorAll(".network-issue h3")).some((heading) =>
      /above the rack size/.test(heading.textContent),
    ),
  );
  document.querySelector("#undoBtn").click();
  assert.equal(stored().rackUnits, 20);
});

test("rack size defaults to 42U and survives CSV and JSON", () => {
  assert.equal(Core.normalizeProject({ devices: [] }).rackUnits, 42);
  assert.equal(
    Core.normalizeProject({ rackUnits: 33, devices: [] }).rackUnits,
    42,
  );
  const project = Core.normalizeProject({ rackUnits: 25, devices: [] });
  assert.equal(Core.csvToProject(Core.projectToCsv(project)).rackUnits, 25);
  assert.equal(
    Core.normalizeProject(JSON.parse(JSON.stringify(project)), { strict: true })
      .rackUnits,
    25,
  );
});

test("devices without network ports, like a UPS, can be added and placed", (t) => {
  const { document, stored } = openApp(t, rackFixture());
  const form = document.querySelector("#deviceForm");
  form.elements.model.value = "UPS 1500VA";
  form.elements.type.value = "Other";
  form.elements.type.dispatchEvent(new document.defaultView.Event("change"));
  form.elements.customType.value = "UPS";
  form.elements.wanPorts.value = "0";
  form.elements.lanPorts.value = "0";
  form.elements.rack.value = "MDF";
  form.elements.rackUnit.value = "1";
  form.elements.rackHeight.value = "2";
  form.requestSubmit();
  const ups = stored().devices.find((device) => device.name === "UPS 1500VA");
  assert.ok(ups, "the device was saved");
  assert.deepEqual(ups.ports, []);
  assert.equal(ups.type, "UPS");
  assert.match(
    document.querySelector("#portGrid").textContent,
    /no network ports/,
  );
  assert.equal(document.querySelector("#bulkModeBtn").disabled, true);
  const block = document.querySelector(
    `.rack-device[data-device-id="${ups.id}"]`,
  );
  assert.equal(block.dataset.kind, "generic");
  assert.equal(block.querySelectorAll(".rack-jack").length, 0);
  assert.match(
    Array.from(document.querySelectorAll(".summary-device")).find((row) =>
      row.textContent.includes("UPS 1500VA"),
    ).textContent,
    /0 ports.*No ports|No ports.*0 ports/,
  );
});

test("port labels and their QR library are gone", (t) => {
  const { document } = openApp(t, rackFixture());
  for (const selector of [
    "#printDeviceLabelsBtn",
    "#bulkLabelsBtn",
    "#printLabels",
    'script[src*="qrcode"]',
  ]) {
    assert.equal(document.querySelector(selector), null, `${selector} removed`);
  }
  assert.equal(fs.existsSync(path.join(root, "assets", "vendor")), false);
});
