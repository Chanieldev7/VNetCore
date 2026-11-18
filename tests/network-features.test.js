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
    projectName: "Network tools",
    devices: [
      {
        id: "a",
        name: "Core switch",
        type: "Switch",
        ports: [
          port("a1", 1, "active", {
            vlan: "10 / Admin",
            address: "192.168.1.10",
          }),
          port("a2", 2, "active", {
            vlan: "10 / Admin",
            connectedTo: "AP Lobby",
          }),
          port("a3", 3, "available", {
            vlan: "100",
            address: "AA:BB:CC:DD:EE:FF",
          }),
          port("a4", 4, "no-link", { vlan: "20" }),
        ],
      },
      {
        id: "b",
        name: "Access switch",
        type: "Switch",
        ports: [
          port("b1", 1, "active", { vlan: "10", address: "192.168.1.10/24" }),
          port("b2", 2, "unknown-device", { vlan: "20" }),
          port("b3", 3, "active", { address: "2001:db8::1" }),
        ],
      },
      {
        id: "c",
        name: "Unlinked router",
        type: "Router",
        ports: [port("c1", 1)],
      },
    ],
    connections: [
      {
        id: "ab",
        firstDeviceId: "a",
        firstPortId: "a1",
        secondDeviceId: "b",
        secondPortId: "b1",
      },
    ],
  };
}

function openApp(t, source = fixture(), workspace) {
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
  });
  window.HTMLElement.prototype.scrollIntoView = function (options) {
    window.lastScroll = options;
  };
  window.localStorage.setItem("vnetcore.project.v9", JSON.stringify(source));
  if (workspace)
    window.localStorage.setItem(
      "vnetcore.workspace.v1",
      JSON.stringify(workspace),
    );
  ["core.js", "app.js"].forEach((file) =>
    window.eval(fs.readFileSync(path.join(root, file), "utf8")),
  );
  const change = (selector, value, event = "change") => {
    const element = window.document.querySelector(selector);
    element.value = value;
    element.dispatchEvent(new window.Event(event, { bubbles: true }));
  };
  return { window, document: window.document, change };
}

test("port filters combine status with exact numeric VLANs or case-insensitive names", () => {
  const candidate = port("1", 1, "active", { vlan: "10 / ADMIN" });
  assert.equal(
    Core.portMatchesFilters(candidate, { status: "active", vlan: "10" }),
    true,
  );
  assert.equal(
    Core.portMatchesFilters(candidate, { status: "available", vlan: "10" }),
    false,
  );
  assert.equal(Core.portMatchesFilters(candidate, { vlan: "admin" }), true);
  assert.equal(Core.portMatchesFilters(candidate, { vlan: "  " }), true);
  assert.equal(
    Core.portMatchesFilters({ ...candidate, vlan: "100" }, { vlan: "10" }),
    false,
  );
  assert.equal(
    Core.portMatchesFilters({ ...candidate, vlan: "10, 20" }, { vlan: "20" }),
    true,
  );
  assert.equal(
    Core.portMatchesFilters({ ...candidate, vlan: "" }, { vlan: "10" }),
    false,
  );
});

test("duplicate IP detection canonicalizes IPv4/IPv6 but ignores MACs and placeholders", () => {
  assert.deepEqual(Core.canonicalAddresses("192.168.001.010/24 192.168.1.10"), [
    "192.168.1.10",
  ]);
  assert.deepEqual(Core.canonicalAddresses("2001:0db8:0:0:0:0:0:1/64"), [
    "2001:db8::1",
  ]);
  assert.deepEqual(
    Core.canonicalAddresses("AA:BB:CC:DD:EE:FF, 0.0.0.0; :: 999.1.2.3"),
    [],
  );
  const source = fixture();
  source.devices[0].ports[1].address = "2001:0db8:0:0:0:0:0:1";
  const issues = Core.analyzeNetwork(source).filter(
    (issue) => issue.code === "duplicate-ip",
  );
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.endpoints.length === 2));
  assert.ok(issues.some((issue) => issue.message.includes("2001:db8::1")));
});

test("network checks distinguish a linked active port from an undocumented active port", () => {
  const issues = Core.analyzeNetwork(fixture());
  assert.equal(
    issues.filter((issue) => issue.code === "duplicate-ip").length,
    1,
  );
  const missing = issues.filter(
    (issue) => issue.code === "missing-destination",
  );
  assert.deepEqual(
    missing.map((issue) => issue.endpoints[0]),
    [{ deviceId: "b", portId: "b3" }],
  );
  assert.equal(
    issues.some((issue) => issue.code === "link-status"),
    false,
  );
});

test("network checks report missing endpoints, status inconsistencies and overbooked ports", () => {
  const source = fixture();
  source.devices[1].ports[0].status = "available";
  source.connections.push(
    {
      id: "missing",
      firstDeviceId: "a",
      firstPortId: "a2",
      secondDeviceId: "gone",
      secondPortId: "x",
    },
    {
      id: "overbooked",
      firstDeviceId: "a",
      firstPortId: "a1",
      secondDeviceId: "c",
      secondPortId: "c1",
    },
  );
  const issues = Core.analyzeNetwork(source);
  assert.equal(
    issues.filter((issue) => issue.code === "incomplete-link").length,
    1,
  );
  assert.equal(
    issues.filter((issue) => issue.code === "multiple-links").length,
    1,
  );
  assert.ok(issues.some((issue) => issue.code === "link-status"));
  const incomplete = issues.find((issue) => issue.code === "incomplete-link");
  assert.deepEqual(incomplete.endpoints, [{ deviceId: "a", portId: "a2" }]);
});

test("local recovery retains broken links for review without relaxing strict imports", () => {
  const source = fixture();
  source.connections.push({
    id: "broken",
    firstDeviceId: "a",
    firstPortId: "a2",
    secondDeviceId: "deleted",
    secondPortId: "missing",
  });
  assert.equal(Core.normalizeProject(source).connections.length, 1);
  const recovered = Core.normalizeProject(source, {
    preserveBrokenConnections: true,
  });
  assert.equal(recovered.connections.length, 2);
  assert.ok(
    Core.analyzeNetwork(recovered).some(
      (issue) => issue.connectionId === "broken",
    ),
  );
  assert.throws(
    () =>
      Core.normalizeProject(source, {
        strict: true,
        preserveBrokenConnections: true,
      }),
    /unknown port/,
  );
});

test("model endpoint keys cannot collide when imported IDs contain separators", () => {
  const source = {
    devices: [
      { id: "a:b", ports: [port("c", 1)] },
      { id: "a", ports: [port("b:c", 1)] },
    ],
    connections: [
      {
        id: "link",
        firstDeviceId: "a:b",
        firstPortId: "c",
        secondDeviceId: "a",
        secondPortId: "b:c",
      },
    ],
  };
  const model = Core.buildNetworkModel(source);
  assert.equal(model.endpoints.size, 2);
  assert.equal(model.links[0].first.device.id, "a:b");
  assert.equal(model.links[0].second.device.id, "a");
});

test("status and VLAN filters update counts without writing or removing saved ports", (t) => {
  const { window, document, change } = openApp(t);
  const saved = window.localStorage.getItem("vnetcore.project.v9");
  document.querySelector('[data-port-status="active"]').click();
  assert.equal(document.querySelectorAll("#portGrid .port").length, 2);
  change("#portVlanFilter", "100", "input");
  assert.equal(document.querySelectorAll("#portGrid .port").length, 0);
  assert.match(
    document.querySelector("#portGrid").textContent,
    /No ports match/,
  );
  document.querySelector('[data-port-status="all"]').click();
  assert.equal(document.querySelectorAll("#portGrid .port").length, 1);
  assert.match(document.querySelector("#portGrid .port").textContent, /LAN 3/);
  change("#portVlanFilter", "10", "input");
  assert.equal(document.querySelectorAll("#portGrid .port").length, 2);
  assert.match(
    document.querySelector("#portFilterSummary").textContent,
    /Showing 2 of 4/,
  );
  document.querySelector("#resetPortFiltersBtn").click();
  assert.equal(document.querySelectorAll("#portGrid .port").length, 4);
  assert.equal(document.activeElement.dataset.portStatus, "all");
  assert.equal(window.localStorage.getItem("vnetcore.project.v9"), saved);
});

test("filtering a selected port preserves its unsaved draft and makes the hidden selection explicit", (t) => {
  const { document, change } = openApp(t);
  document.querySelector("#portGrid .port").click();
  change('#portForm [name="notes"]', "Keep this draft", "input");
  document.querySelector('[data-port-status="available"]').click();
  assert.match(
    document.querySelector("#portFilterSummary").textContent,
    /selected port is hidden/,
  );
  assert.equal(
    document.querySelector('#portForm [name="notes"]').value,
    "Keep this draft",
  );
  document.querySelector("#resetPortFiltersBtn").click();
  assert.equal(document.querySelectorAll("#portGrid .is-selected").length, 1);
  assert.equal(
    document.querySelectorAll("#portGrid .port-draft-label").length,
    1,
  );
});

test("alerts can be filtered and navigate to the affected port while clearing view filters", (t) => {
  const { document, change } = openApp(t);
  assert.equal(document.querySelectorAll(".network-issue").length, 2);
  change("#networkAlertFilter", "missing-destination");
  assert.equal(document.querySelectorAll(".network-issue").length, 1);
  document.querySelector('[data-port-status="available"]').click();
  change("#portVlanFilter", "100", "input");
  document.querySelector("#networkAlerts").open = true;
  document.querySelector(".network-issue-action").click();
  assert.equal(
    document.querySelector("#deviceName").textContent,
    "Access switch",
  );
  assert.equal(
    document.querySelector('#portForm [name="number"]').value,
    "LAN 3",
  );
  assert.equal(document.querySelector("#portVlanFilter").value, "");
  assert.equal(
    document
      .querySelector('[data-port-status="all"]')
      .getAttribute("aria-pressed"),
    "true",
  );
});

test("saving port information refreshes alerts, while drafts alone do not", (t) => {
  const { window, document, change } = openApp(t);
  change("#networkAlertFilter", "missing-destination");
  document.querySelector(".network-issue-action").click();
  change('#portForm [name="connectedTo"]', "Workstation", "input");
  assert.equal(document.querySelectorAll(".network-issue").length, 1);
  document
    .querySelector("#portForm")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  assert.equal(document.querySelectorAll(".network-issue").length, 0);
  assert.match(
    document.querySelector("#networkAlertsCount").textContent,
    /1 to review/,
  );
});

test("broken local links remain visible until confirmed removal, and removal can be undone", async (t) => {
  const source = fixture();
  source.connections.push({
    id: "broken",
    firstDeviceId: "a",
    firstPortId: "a2",
    secondDeviceId: "deleted",
    secondPortId: "missing",
  });
  const { window, document, change } = openApp(t, source);
  const saved = window.localStorage.getItem("vnetcore.project.v9");
  change("#networkAlertFilter", "incomplete-link");
  assert.equal(document.querySelectorAll(".network-issue").length, 1);
  assert.equal(window.localStorage.getItem("vnetcore.project.v9"), saved);
  const dialog = document.querySelector("#confirmDialog");
  dialog.showModal = function () {
    this.open = true;
  };
  document.querySelector(".remove-broken-link").click();
  assert.equal(window.localStorage.getItem("vnetcore.project.v9"), saved);
  dialog.returnValue = "default";
  dialog.dispatchEvent(new window.Event("close"));
  await Promise.resolve();
  assert.equal(document.querySelectorAll(".network-issue").length, 0);
  assert.equal(
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9")).connections
      .length,
    1,
  );
  assert.equal(
    document.activeElement,
    document.querySelector(".network-alerts-toggle"),
  );
  document.querySelector("#undoBtn").click();
  assert.equal(document.querySelectorAll(".network-issue").length, 1);
  assert.equal(
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9")).connections
      .length,
    2,
  );
});

test("selecting a connection highlights both endpoints and offers navigation to either port", (t) => {
  const { document } = openApp(t);
  assert.equal(document.querySelectorAll(".topology-node").length, 3);
  assert.equal(document.querySelectorAll(".topology-wire-group").length, 1);
  const link = document.querySelector(".topology-link");
  link.focus();
  link.click();
  assert.equal(
    document.querySelectorAll(".topology-node.is-link-endpoint").length,
    2,
  );
  assert.equal(
    document.querySelectorAll(".topology-wire-group.is-selected").length,
    1,
  );
  assert.equal(document.activeElement.dataset.connectionId, "ab");
  assert.equal(document.querySelector("#topologySelectedLink").hidden, false);
  document.querySelectorAll("#topologySelectedLink button")[1].click();
  assert.equal(
    document.querySelector("#deviceName").textContent,
    "Access switch",
  );
  assert.equal(
    document.querySelector('#portForm [name="number"]').value,
    "LAN 1",
  );
  assert.equal(
    document.querySelectorAll(".topology-node.is-link-endpoint").length,
    2,
  );
});

test("topology nodes select devices, retain keyboard focus and support neighborhood scope", (t) => {
  const { document, change } = openApp(t);
  const node = document.querySelector('.topology-node[data-device-id="b"]');
  node.focus();
  node.click();
  assert.equal(
    document.querySelector("#deviceName").textContent,
    "Access switch",
  );
  assert.equal(document.activeElement.dataset.deviceId, "b");
  change("#topologyScope", "neighbors");
  assert.equal(document.querySelectorAll(".topology-node").length, 2);
  assert.equal(
    document.querySelector('.topology-node[data-device-id="c"]'),
    null,
  );
});

test("new connections saved from the form appear immediately in the map", (t) => {
  const { window, document, change } = openApp(t);
  document.querySelectorAll("#portGrid .port")[1].click();
  // Alternating layout still keeps DOM ports sorted by their physical number.
  change('#portForm [name="connectedPort"]', JSON.stringify(["c", "c1"]));
  document
    .querySelector("#portForm")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  assert.equal(document.querySelectorAll(".topology-link").length, 2);
  assert.equal(
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9")).connections
      .length,
    2,
  );
});

test("alert pagination stays bounded and advances focus to the newly revealed items", (t) => {
  const source = {
    projectName: "Many warnings",
    devices: [
      {
        id: "a",
        name: "Switch",
        type: "Switch",
        ports: Array.from({ length: 45 }, (_, index) =>
          port(`p${index}`, index + 1, "active"),
        ),
      },
    ],
  };
  const { document } = openApp(t, source);
  document.querySelector("#networkAlerts").open = true;
  assert.equal(document.querySelectorAll(".network-issue").length, 20);
  document.querySelector("#showMoreAlertsBtn").click();
  assert.equal(document.querySelectorAll(".network-issue").length, 40);
  assert.equal(
    document.activeElement,
    document.querySelectorAll(".network-issue")[20],
  );
  document.querySelector("#showMoreAlertsBtn").click();
  assert.equal(document.querySelectorAll(".network-issue").length, 45);
  assert.equal(document.querySelector("#showMoreAlertsBtn").hidden, true);
});

test("parallel links are bundled visually but remain individually selectable", (t) => {
  const source = {
    projectName: "Parallel links",
    devices: ["a", "b"].map((id) => ({
      id,
      name: id,
      type: "Switch",
      ports: Array.from({ length: 25 }, (_, index) =>
        port(`p${index}`, index + 1, "active"),
      ),
    })),
    connections: Array.from({ length: 25 }, (_, index) => ({
      id: `link${index}`,
      firstDeviceId: "a",
      firstPortId: `p${index}`,
      secondDeviceId: "b",
      secondPortId: `p${index}`,
    })),
  };
  const { document } = openApp(t, source);
  assert.equal(document.querySelectorAll(".topology-wire-group").length, 1);
  assert.equal(document.querySelectorAll(".topology-link").length, 20);
  document.querySelector("#showMoreConnectionsBtn").click();
  assert.equal(document.querySelectorAll(".topology-link").length, 25);
  assert.equal(document.activeElement.dataset.connectionId, "link20");
  assert.equal(document.querySelector("#showMoreConnectionsBtn").hidden, true);
});

test("switching projects resets filters and map selection without leaking other projects' links", (t) => {
  const first = fixture();
  const second = {
    projectName: "Other",
    devices: [
      { id: "x", name: "Other router", type: "Router", ports: [port("x1", 1)] },
    ],
  };
  const { document, change } = openApp(t, first, {
    activeProjectId: "first",
    projects: [
      { id: "first", project: first },
      { id: "second", project: second },
    ],
  });
  document.querySelector(".topology-link").click();
  document.querySelector('[data-port-status="active"]').click();
  change("#projectSelect", "second");
  assert.equal(document.querySelectorAll(".topology-node").length, 1);
  assert.equal(document.querySelectorAll(".topology-link").length, 0);
  assert.equal(document.querySelector("#topologySelectedLink").hidden, true);
  assert.equal(
    document
      .querySelector('[data-port-status="all"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(document.querySelectorAll(".network-issue").length, 0);
});

test("empty projects have honest empty states and disabled filters", (t) => {
  const { document } = openApp(t, { devices: [] });
  assert.equal(document.querySelectorAll(".topology-node").length, 0);
  assert.match(
    document.querySelector("#topologyCanvas").textContent,
    /Add devices/,
  );
  assert.equal(document.querySelector("#portVlanFilter").disabled, true);
  assert.equal(document.querySelector("#topologyScope").disabled, true);
  assert.match(
    document.querySelector("#networkAlertsSummary").textContent,
    /Add devices/,
  );
});

test("device names and addresses are rendered as text, never HTML", (t) => {
  const source = fixture();
  source.devices[0].name = '<img src=x onerror="alert(1)">';
  source.devices[0].ports[0].address = "<script>alert(1)</script>";
  const { document } = openApp(t, source);
  assert.equal(
    document.querySelectorAll("#topologyCanvas img, #networkAlertsList script")
      .length,
    0,
  );
  assert.match(
    document.querySelector(".topology-node").textContent,
    /<img src=x/,
  );
});
