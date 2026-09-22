/* Pure model and interchange helpers shared by the browser app and tests. */
(function exposeCore(global) {
  "use strict";

  const SCHEMA_VERSION = 9;
  const LIMITS = {
    fileBytes: 5 * 1024 * 1024,
    devices: 500,
    portsPerDevice: 512,
    projectName: 120,
    owner: 120,
    deviceName: 120,
    deviceType: 80,
    location: 160,
    shortField: 160,
    notes: 2000,
  };
  const STATUS_LABELS = {
    active: "Active",
    "no-link": "No link",
    available: "Available",
    "unknown-device": "Unknown Device",
  };
  const STATUS_MIGRATION = {
    connected: "active",
    uplink: "active",
    empty: "available",
    issue: "unknown-device",
    Active: "active",
    "No link": "no-link",
    Available: "available",
    "Unknown Device": "unknown-device",
  };
  const CSV_HEADERS = [
    "recordType",
    "schemaVersion",
    "projectName",
    "projectOwner",
    "reviewDate",
    "deviceId",
    "deviceName",
    "deviceType",
    "deviceLocation",
    "portLayout",
    "portId",
    "portKind",
    "portNumber",
    "status",
    "connectionType",
    "connectedTo",
    "vlan",
    "address",
    "notes",
  ];

  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function text(value, maxLength) {
    return String(value ?? "")
      .trim()
      .slice(0, maxLength);
  }

  function normalizeStatus(status) {
    const value = text(status, 40);
    return STATUS_LABELS[value]
      ? value
      : STATUS_MIGRATION[value] || "available";
  }

  function normalizeProject(source, options = {}) {
    const strict = Boolean(options.strict);
    const parsed = Array.isArray(source) ? { devices: source } : source;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The project must be a JSON object.");
    }
    if (strict && Number(parsed.schemaVersion || 0) > SCHEMA_VERSION) {
      throw new Error(
        `This project uses a newer schema version (${parsed.schemaVersion}).`,
      );
    }
    if (strict && !Array.isArray(parsed.devices)) {
      throw new Error("The project must contain a devices array.");
    }
    const sourceDevices = Array.isArray(parsed.devices) ? parsed.devices : [];
    if (sourceDevices.length > LIMITS.devices) {
      throw new Error(
        `A project can contain at most ${LIMITS.devices} devices.`,
      );
    }

    const usedDeviceIds = new Set();
    const devices = sourceDevices.map((device, deviceIndex) => {
      if (!device || typeof device !== "object" || Array.isArray(device)) {
        throw new Error(`Device ${deviceIndex + 1} is invalid.`);
      }
      const sourcePorts = Array.isArray(device.ports) ? device.ports : [];
      if (sourcePorts.length > LIMITS.portsPerDevice) {
        throw new Error(
          `Device ${deviceIndex + 1} exceeds ${LIMITS.portsPerDevice} ports.`,
        );
      }
      let id = text(device.id, 120) || createId();
      if (usedDeviceIds.has(id)) {
        if (strict) throw new Error(`Duplicate device ID: ${id}.`);
        id = createId();
      }
      usedDeviceIds.add(id);

      const usedPortIds = new Set();
      const usedPortKeys = new Set();
      const ports = sourcePorts.map((port, portIndex) => {
        if (!port || typeof port !== "object" || Array.isArray(port)) {
          throw new Error(
            `Port ${portIndex + 1} in device ${deviceIndex + 1} is invalid.`,
          );
        }
        const numberValue = Number(port.number ?? portIndex + 1);
        if (
          !Number.isInteger(numberValue) ||
          numberValue < 1 ||
          numberValue > LIMITS.portsPerDevice
        ) {
          throw new Error(
            `Port number in device ${deviceIndex + 1} must be a positive integer.`,
          );
        }
        const wanHint = [port.portKind, port.connectionType, port.vlan].some(
          (value) => text(value, 40).toUpperCase() === "WAN",
        );
        const portKind =
          text(port.portKind, 10).toUpperCase() || (wanHint ? "WAN" : "LAN");
        if (!["LAN", "WAN"].includes(portKind)) {
          throw new Error(
            `Port type must be LAN or WAN in device ${deviceIndex + 1}.`,
          );
        }
        const key = `${portKind}:${numberValue}`;
        if (usedPortKeys.has(key)) {
          throw new Error(
            `Duplicate ${portKind} port ${numberValue} in device ${deviceIndex + 1}.`,
          );
        }
        usedPortKeys.add(key);
        let portId = text(port.id, 120) || createId();
        if (usedPortIds.has(portId)) {
          if (strict) throw new Error(`Duplicate port ID: ${portId}.`);
          portId = createId();
        }
        usedPortIds.add(portId);
        const rawStatus = text(port.status, 40);
        if (
          strict &&
          rawStatus &&
          !STATUS_LABELS[rawStatus] &&
          !STATUS_MIGRATION[rawStatus]
        ) {
          throw new Error(
            `Unknown port status "${rawStatus}" in device ${deviceIndex + 1}.`,
          );
        }
        return {
          id: portId,
          number: numberValue,
          status: normalizeStatus(port.status),
          connectionType: text(port.connectionType, LIMITS.shortField),
          connectedTo: text(port.connectedTo, LIMITS.shortField),
          vlan: text(port.vlan, 80),
          address: text(port.address, LIMITS.shortField),
          notes: text(port.notes, LIMITS.notes),
          portKind,
        };
      });
      return {
        id,
        name:
          text(device.name || device.model, LIMITS.deviceName) ||
          "Unnamed device",
        type: text(device.type, LIMITS.deviceType) || "Other",
        location: text(device.location, LIMITS.location),
        portLayout: device.portLayout === "split" ? "split" : "alternating",
        ports,
      };
    });

    if (
      strict &&
      parsed.reviewDate &&
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.reviewDate)
    ) {
      throw new Error("Review date must use YYYY-MM-DD format.");
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      projectName:
        text(parsed.projectName, LIMITS.projectName) || "Unnamed project",
      owner: text(parsed.owner, LIMITS.owner),
      reviewDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.reviewDate || "")
        ? parsed.reviewDate
        : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      devices,
    };
  }

  function cloneProject(project) {
    return JSON.parse(JSON.stringify(project));
  }

  function csvEscape(value) {
    let output = String(value ?? "");
    if (/^\s*[=+\-@]/.test(output)) output = `'${output}`;
    if (/[",\n\r]/.test(output)) output = `"${output.replace(/"/g, '""')}"`;
    return output;
  }

  function projectToCsv(projectInput) {
    const project = normalizeProject(projectInput);
    const rows = [CSV_HEADERS];
    rows.push([
      "PROJECT",
      SCHEMA_VERSION,
      project.projectName,
      project.owner,
      project.reviewDate,
    ]);
    project.devices.forEach((device) => {
      rows.push([
        "DEVICE",
        SCHEMA_VERSION,
        project.projectName,
        project.owner,
        project.reviewDate,
        device.id,
        device.name,
        device.type,
        device.location,
        device.portLayout,
      ]);
      device.ports.forEach((port) => {
        rows.push([
          "PORT",
          SCHEMA_VERSION,
          project.projectName,
          project.owner,
          project.reviewDate,
          device.id,
          device.name,
          device.type,
          device.location,
          device.portLayout,
          port.id,
          port.portKind,
          port.number,
          port.status,
          port.connectionType,
          port.connectedTo,
          port.vlan,
          port.address,
          port.notes,
        ]);
      });
    });
    return `\ufeff${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`;
  }

  function parseCsv(input) {
    const textValue = String(input || "").replace(/^\ufeff/, "");
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;
    let afterQuote = false;
    for (let i = 0; i < textValue.length; i++) {
      const char = textValue[i];
      if (quoted) {
        if (char === '"' && textValue[i + 1] === '"') {
          value += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
          afterQuote = true;
        } else {
          value += char;
        }
      } else if (char === '"') {
        if (value !== "" || afterQuote)
          throw new Error("Malformed CSV quotation.");
        quoted = true;
      } else if (char === ",") {
        row.push(value);
        value = "";
        afterQuote = false;
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && textValue[i + 1] === "\n") i++;
        row.push(value);
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        value = "";
        afterQuote = false;
      } else {
        if (afterQuote && !/\s/.test(char))
          throw new Error("Unexpected text after a quoted CSV value.");
        value += char;
      }
    }
    if (quoted) throw new Error("CSV contains an unclosed quotation mark.");
    row.push(value);
    if (row.some((cell) => cell !== "")) rows.push(row);
    return rows;
  }

  function csvToProject(csvText) {
    const rows = parseCsv(csvText);
    if (rows.length < 2)
      throw new Error("The CSV does not contain project data.");
    const headers = rows[0].map((header) => header.trim());
    const required = ["recordType", "projectName", "deviceId"];
    if (required.some((header) => !headers.includes(header))) {
      const legacyHeaders = [
        "projectName",
        "deviceName",
        "deviceType",
        "deviceLocation",
        "portKind",
        "portNumber",
      ];
      if (legacyHeaders.every((header) => headers.includes(header))) {
        return legacyCsvToProject(headers, rows.slice(1));
      }
      throw new Error(
        "Unsupported CSV format. Export a new CSV from VNetCore first.",
      );
    }
    const records = rows.slice(1).map((row, rowIndex) => {
      if (row.length > headers.length)
        throw new Error(`CSV row ${rowIndex + 2} has too many columns.`);
      return Object.fromEntries(
        headers.map((header, index) => [header, row[index] ?? ""]),
      );
    });
    const projectRecord =
      records.find((record) => record.recordType === "PROJECT") || records[0];
    const devicesById = new Map();
    records
      .filter((record) => record.recordType === "DEVICE")
      .forEach((record) => {
        if (!record.deviceId)
          throw new Error("A device record is missing its ID.");
        devicesById.set(record.deviceId, {
          id: record.deviceId,
          name: record.deviceName,
          type: record.deviceType,
          location: record.deviceLocation,
          portLayout: record.portLayout,
          ports: [],
        });
      });
    records
      .filter((record) => record.recordType === "PORT")
      .forEach((record) => {
        if (!devicesById.has(record.deviceId)) {
          devicesById.set(record.deviceId, {
            id: record.deviceId,
            name: record.deviceName,
            type: record.deviceType,
            location: record.deviceLocation,
            portLayout: record.portLayout,
            ports: [],
          });
        }
        devicesById.get(record.deviceId).ports.push({
          id: record.portId,
          portKind: record.portKind,
          number: record.portNumber,
          status: record.status,
          connectionType: record.connectionType,
          connectedTo: record.connectedTo,
          vlan: record.vlan,
          address: record.address,
          notes: record.notes,
        });
      });
    return normalizeProject(
      {
        projectName: projectRecord.projectName,
        owner: projectRecord.projectOwner,
        reviewDate: projectRecord.reviewDate,
        devices: Array.from(devicesById.values()),
      },
      { strict: true },
    );
  }

  function legacyCsvToProject(headers, rows) {
    if (!rows.length)
      throw new Error("The legacy CSV does not contain device data.");
    const records = rows.map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [header, row[index] ?? ""]),
      ),
    );
    const devicesByDescription = new Map();
    records.forEach((record) => {
      const key = `${record.deviceName}\u0000${record.deviceType}\u0000${record.deviceLocation}`;
      if (!devicesByDescription.has(key)) {
        devicesByDescription.set(key, {
          id: createId(),
          name: record.deviceName,
          type: record.deviceType,
          location: record.deviceLocation,
          ports: [],
        });
      }
      devicesByDescription.get(key).ports.push({
        id: createId(),
        portKind: record.portKind,
        number: record.portNumber,
        status: record.status,
        connectionType: record.connectionType,
        connectedTo: record.connectedTo,
        vlan: record.vlan,
        address: record.address,
        notes: record.notes,
      });
    });
    return normalizeProject(
      {
        projectName: records[0].projectName || "Imported project",
        devices: Array.from(devicesByDescription.values()),
      },
      { strict: true },
    );
  }

  const api = {
    SCHEMA_VERSION,
    LIMITS,
    STATUS_LABELS,
    CSV_HEADERS,
    createId,
    normalizeStatus,
    normalizeProject,
    cloneProject,
    projectToCsv,
    parseCsv,
    csvToProject,
  };
  global.VNetCoreCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
