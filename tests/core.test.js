const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

function sampleProject() {
  return {
    projectName: "Main network",
    owner: "Operations",
    reviewDate: "2026-07-18",
    devices: [
      {
        id: "empty-device",
        name: "Unpatched panel",
        type: "Patch Panel",
        location: "MDF",
        ports: [],
      },
      {
        id: "switch-a",
        name: "Core, Switch",
        type: "Switch",
        location: "MDF",
        portLayout: "split",
        ports: [
          {
            id: "port-a",
            number: 1,
            portKind: "LAN",
            status: "active",
            connectionType: "Server",
            connectedTo: 'Host "A"',
            vlan: "10",
            address: "10.0.0.1",
            notes: "Line one\nLine two",
          },
        ],
      },
      {
        id: "switch-b",
        name: "Core, Switch",
        type: "Switch",
        location: "MDF",
        ports: [],
      },
    ],
  };
}

test("normalizes legacy statuses and adds schema metadata", () => {
  const project = core.normalizeProject({
    projectName: " Legacy ",
    devices: [
      {
        name: "Router",
        ports: [{ number: 1, portKind: "wan", status: "connected" }],
      },
    ],
  });
  assert.equal(project.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(project.projectName, "Legacy");
  assert.equal(project.devices[0].ports[0].portKind, "WAN");
  assert.equal(project.devices[0].ports[0].status, "active");
});

test("rejects duplicate IDs and invalid port data during strict import", () => {
  assert.throws(
    () =>
      core.normalizeProject(
        {
          devices: [
            { id: "duplicate", ports: [] },
            { id: "duplicate", ports: [] },
          ],
        },
        { strict: true },
      ),
    /Duplicate device ID/,
  );
  assert.throws(
    () =>
      core.normalizeProject(
        {
          devices: [{ ports: [{ number: -1, portKind: "LAN" }] }],
        },
        { strict: true },
      ),
    /positive integer/,
  );
  assert.throws(
    () =>
      core.normalizeProject(
        {
          devices: [
            { ports: [{ number: 1, portKind: "LAN", status: "broken" }] },
          ],
        },
        { strict: true },
      ),
    /Unknown port status/,
  );
});

test("CSV round trip preserves empty and identically described devices", () => {
  const original = core.normalizeProject(sampleProject());
  const csv = core.projectToCsv(original);
  const imported = core.csvToProject(csv);
  assert.equal(imported.devices.length, 3);
  assert.deepEqual(
    imported.devices.map((device) => device.id),
    ["empty-device", "switch-a", "switch-b"],
  );
  assert.equal(imported.devices[1].ports[0].notes, "Line one\nLine two");
  assert.equal(imported.devices[1].portLayout, "split");
  assert.equal(imported.owner, "Operations");
});

test("CSV output neutralizes spreadsheet formulas", () => {
  const csv = core.projectToCsv({
    projectName: '=HYPERLINK("https://example.test")',
    devices: [],
  });
  assert.match(csv, /'=HYPERLINK/);

  const whitespaceFormula = core.projectToCsv({
    projectName: "  @SUM(1,2)",
    devices: [],
  });
  assert.match(whitespaceFormula, /'@SUM/);
});

test("CSV parser rejects malformed quotation", () => {
  assert.throws(() => core.parseCsv('a,b\r\n"open,b'), /unclosed quotation/);
});

test("imports the previous flat CSV format", () => {
  const csv = [
    "projectName,deviceName,deviceType,deviceLocation,portKind,portNumber,status,connectionType,connectedTo,vlan,address,notes",
    "Legacy,Router,Router,MDF,WAN,1,Active,WAN,ISP,WAN,,Old export",
  ].join("\n");
  const project = core.csvToProject(csv);
  assert.equal(project.projectName, "Legacy");
  assert.equal(project.devices[0].ports[0].status, "active");
});
