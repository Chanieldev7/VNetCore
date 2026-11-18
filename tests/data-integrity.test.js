const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../core.js");

const root = path.resolve(__dirname, "..");
const port = (id, number, extra = {}) => ({
  id,
  number,
  portKind: "LAN",
  status: "active",
  ...extra,
});

function fixture() {
  return {
    projectName: "Integrity",
    devices: [
      {
        id: "a",
        name: "Core",
        type: "Switch",
        ports: [
          port("a1", 1, { connectedTo: "Edge · LAN 2" }),
          port("a2", 2, { connectedTo: "Edge · LAN 1" }),
        ],
      },
      {
        id: "b",
        name: "Edge",
        type: "Switch",
        ports: [
          port("b1", 1, { connectedTo: "Core · LAN 2" }),
          port("b2", 2, { connectedTo: "Core · LAN 1" }),
        ],
      },
    ],
    connections: [
      {
        id: "l1",
        firstDeviceId: "a",
        firstPortId: "a1",
        secondDeviceId: "b",
        secondPortId: "b2",
      },
      {
        id: "l2",
        firstDeviceId: "a",
        firstPortId: "a2",
        secondDeviceId: "b",
        secondPortId: "b1",
      },
    ],
  };
}

function openApp(t, { project = fixture(), workspaceRaw } = {}) {
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
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  if (project)
    window.localStorage.setItem("vnetcore.project.v9", JSON.stringify(project));
  if (workspaceRaw !== undefined)
    window.localStorage.setItem("vnetcore.workspace.v1", workspaceRaw);
  ["core.js", "app.js"].forEach((file) =>
    window.eval(fs.readFileSync(path.join(root, file), "utf8")),
  );
  const confirm = async () => {
    const dialog = window.document.querySelector("#confirmDialog");
    dialog.returnValue = "default";
    dialog.dispatchEvent(new window.Event("close"));
    await Promise.resolve();
  };
  const stored = () =>
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9"));
  return { window, document: window.document, confirm, stored };
}

test("deleting a device removes its links and clears only the labels the app generated", async (t) => {
  const source = fixture();
  source.devices[1].ports[0].connectedTo = "Hand-written note";
  const { document, confirm, stored } = openApp(t, { project: source });
  document.querySelector('[aria-label="Delete Core"]').click();
  await confirm();
  const saved = stored();
  assert.deepEqual(saved.connections, []);
  assert.equal(
    saved.devices[0].ports.find((p) => p.id === "b2").connectedTo,
    "",
  );
  assert.equal(
    saved.devices[0].ports.find((p) => p.id === "b1").connectedTo,
    "Hand-written note",
  );
  assert.equal(document.querySelectorAll(".network-issue.error").length, 0);
});

test("reducing a device's ports drops links to the removed ports only", (t) => {
  const { document, stored } = openApp(t);
  document.querySelector("#editDeviceBtn").click();
  const form = document.querySelector("#deviceForm");
  form.elements.lanPorts.value = "1";
  form.requestSubmit();
  const saved = stored();
  assert.deepEqual(
    saved.connections.map((c) => c.id),
    ["l1"],
  );
  assert.equal(
    saved.devices[1].ports.find((p) => p.id === "b1").connectedTo,
    "",
  );
});

test("clearing all devices leaves no orphan links", async (t) => {
  const { document, confirm, stored } = openApp(t);
  document.querySelector("#clearAllBtn").click();
  await confirm();
  assert.deepEqual(stored().connections, []);
});

test("an unreadable workspace is quarantined before any save can replace it", (t) => {
  const corrupted = '{"projects": [ broken';
  const { window, document } = openApp(t, { workspaceRaw: corrupted });
  const quarantine = JSON.parse(
    window.localStorage.getItem("vnetcore.recovery.v1"),
  );
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].raw, corrupted);
  assert.equal(quarantine[0].key, "vnetcore.workspace.v1");
  // Editing afterwards must keep the preserved copy intact.
  const name = document.querySelector("#projectNameInput");
  name.value = "Edited";
  name.dispatchEvent(new window.Event("blur"));
  assert.equal(
    JSON.parse(window.localStorage.getItem("vnetcore.recovery.v1"))[0].raw,
    corrupted,
  );
});

test("an unreadable project is never rotated into the backup slot", (t) => {
  const { window, document } = openApp(t, { project: null });
  window.localStorage.setItem(
    "vnetcore.project.v9.backup",
    JSON.stringify(fixture()),
  );
  window.localStorage.setItem("vnetcore.project.v9", "{not json");
  const name = document.querySelector("#projectNameInput");
  name.value = "Edited";
  name.dispatchEvent(new window.Event("blur"));
  const backup = JSON.parse(
    window.localStorage.getItem("vnetcore.project.v9.backup"),
  );
  assert.equal(backup.projectName, "Integrity");
});

test("deleting a project can be undone", async (t) => {
  const { document, confirm, window } = openApp(t);
  document.querySelector("#duplicateProjectBtn").click();
  assert.equal(document.querySelector("#projectSelect").options.length, 2);
  document.querySelector("#deleteProjectBtn").click();
  await confirm();
  assert.equal(document.querySelector("#projectSelect").options.length, 1);
  document.querySelector("#undoBtn").click();
  assert.equal(document.querySelector("#projectSelect").options.length, 2);
  const workspace = JSON.parse(
    window.localStorage.getItem("vnetcore.workspace.v1"),
  );
  assert.equal(workspace.projects.length, 2);
});

test("port and map buttons take their accessible name from visible text", (t) => {
  const { document } = openApp(t);
  const port = document.querySelector("#portGrid .port");
  assert.equal(port.hasAttribute("aria-label"), false);
  assert.match(port.textContent, /LAN 1.*Active.*Edge · LAN 2/);
  document.querySelector(".topology-link").click();
  const node = document.querySelector(".topology-node.is-link-endpoint");
  assert.equal(node.hasAttribute("aria-label"), false);
  assert.match(node.textContent, /Endpoint of selected connection/);
});

test("CSV export never emits a cell that starts with a formula trigger", () => {
  const source = fixture();
  source.devices[0].ports[0].notes = '\t=HYPERLINK("http://x")';
  source.devices[0].ports[1].notes = "\r+cmd";
  source.devices[1].ports[0].vlan = "@SUM(1)";
  const cells = Core.parseCsv(Core.projectToCsv(source)).flat();
  assert.ok(cells.includes('\'=HYPERLINK("http://x")'));
  assert.ok(cells.includes("'+cmd"));
  assert.ok(cells.includes("'@SUM(1)"));
  assert.ok(cells.every((cell) => !/^[\t\r]|^\s*[=+@]/.test(cell)));
});
