const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function bootApp(url, seed) {
  const dom = new JSDOM(read("index.html"), {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  if (seed) seed(window.localStorage);
  window.eval(read("core.js"));
  window.eval(read("demo-project.js"));
  window.eval(read("app.js"));
  return window;
}

function storedWorkspace(window) {
  return JSON.parse(window.localStorage.getItem("vnetcore.workspace.v1"));
}

test("demo project passes strict import validation", () => {
  const window = {};
  new Function("window", read("demo-project.js"))(window);
  const Core = require("../core.js");
  const project = Core.normalizeProject(window.VNetCoreDemoProject, {
    strict: true,
  });
  assert.ok(project.devices.length > 3);
  assert.ok(project.connections.length > 0);
});

test("?demo=1 in a fresh browser opens the demo and cleans the URL", () => {
  const window = bootApp("https://vnetcore.test/?demo=1");
  const workspace = storedWorkspace(window);
  assert.equal(workspace.projects.length, 1);
  assert.equal(workspace.activeProjectId, "vnetcore-demo");
  assert.equal(window.location.search, "");
  assert.match(
    window.document.querySelector("#projectSelect").textContent,
    /Riverside clinic \(demo\)/,
  );
  window.close();
});

test("?demo=1 never replaces an existing project and is not duplicated", () => {
  const existing = {
    activeProjectId: "mine",
    projects: [
      {
        id: "mine",
        project: {
          projectName: "My office",
          devices: [{ id: "d1", name: "Router", ports: [] }],
        },
      },
    ],
  };
  const seed = (storage) =>
    storage.setItem("vnetcore.workspace.v1", JSON.stringify(existing));
  let window = bootApp("https://vnetcore.test/?demo=1", seed);
  let workspace = storedWorkspace(window);
  assert.deepEqual(
    workspace.projects.map((record) => record.id),
    ["mine", "vnetcore-demo"],
  );
  assert.equal(workspace.projects[0].project.projectName, "My office");
  assert.equal(workspace.projects[0].project.devices.length, 1);
  window.close();

  const saved = JSON.stringify(workspace);
  window = bootApp("https://vnetcore.test/?demo=1", (storage) =>
    storage.setItem("vnetcore.workspace.v1", saved),
  );
  workspace = storedWorkspace(window);
  assert.equal(workspace.projects.length, 2);
  assert.equal(workspace.activeProjectId, "vnetcore-demo");
  window.close();
});
