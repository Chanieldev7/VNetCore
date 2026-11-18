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
    serialNumber: 80,
    macAddress: 40,
    managementIp: 80,
    manufacturer: 80,
    firmware: 80,
  };
  // Optional inventory details for a device: JSON key -> CSV column.
  const DEVICE_DETAIL_FIELDS = {
    manufacturer: "deviceManufacturer",
    serialNumber: "deviceSerialNumber",
    macAddress: "deviceMacAddress",
    managementIp: "deviceManagementIp",
    firmware: "deviceFirmware",
    rack: "deviceRack",
    notes: "deviceNotes",
  };
  // Rack placement: the lowest rack unit a device occupies and its height in U.
  const RACK_LIMITS = { units: 60, height: 20 };
  // Rack sizes offered per project: steps of 5U, plus the standard 42U.
  const RACK_SIZES = [10, 15, 20, 25, 30, 35, 40, 42, 45, 50];
  const DEFAULT_RACK_UNITS = 42;
  const DEVICE_RACK_FIELDS = {
    rackUnit: "deviceRackUnit",
    rackHeight: "deviceRackHeight",
  };
  const DEVICE_DETAIL_LIMITS = {
    manufacturer: 80,
    serialNumber: 80,
    macAddress: 40,
    managementIp: 80,
    firmware: 80,
    rack: 80,
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
    "linkedDeviceId",
    "linkedPortId",
    "projectRackUnits",
    ...Object.values(DEVICE_DETAIL_FIELDS),
    ...Object.values(DEVICE_RACK_FIELDS),
  ];
  const PORT_DATA_FIELDS = [
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

  function wholeNumber(value, min, max) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max
      ? number
      : null;
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
        rackUnit: wholeNumber(device.rackUnit, 1, RACK_LIMITS.units),
        rackHeight: wholeNumber(device.rackHeight, 1, RACK_LIMITS.height) || 1,
        ...Object.fromEntries(
          Object.entries(DEVICE_DETAIL_LIMITS).map(([field, limit]) => [
            field,
            text(device[field], limit),
          ]),
        ),
        ports,
      };
    });

    const deviceById = new Map(devices.map((device) => [device.id, device]));
    const portById = new Map();
    devices.forEach((device) =>
      device.ports.forEach((port) =>
        portById.set(`${device.id}:${port.id}`, port),
      ),
    );
    const usedConnectionIds = new Set();
    const usedConnectionKeys = new Set();
    const connections = (
      Array.isArray(parsed.connections) ? parsed.connections : []
    )
      .map((connection, index) => {
        if (!connection || typeof connection !== "object") {
          if (strict) throw new Error(`Connection ${index + 1} is invalid.`);
          return null;
        }
        const firstDeviceId = text(connection.firstDeviceId, 120);
        const firstPortId = text(connection.firstPortId, 120);
        const secondDeviceId = text(connection.secondDeviceId, 120);
        const secondPortId = text(connection.secondPortId, 120);
        const firstKey = `${firstDeviceId}:${firstPortId}`;
        const secondKey = `${secondDeviceId}:${secondPortId}`;
        const valid =
          firstDeviceId &&
          firstPortId &&
          secondDeviceId &&
          secondPortId &&
          firstKey !== secondKey &&
          deviceById.has(firstDeviceId) &&
          deviceById.has(secondDeviceId) &&
          portById.has(firstKey) &&
          portById.has(secondKey);
        if (!valid) {
          if (strict)
            throw new Error(
              `Connection ${index + 1} references an unknown port.`,
            );
          // Local recovery can retain stale IDs so the UI can report and review them.
          // Imports and interchange keep their existing validated behavior.
          if (
            !options.preserveBrokenConnections ||
            !firstDeviceId ||
            !firstPortId ||
            !secondDeviceId ||
            !secondPortId
          )
            return null;
        }
        const endpointKey = [firstKey, secondKey].sort().join("|");
        if (usedConnectionKeys.has(endpointKey)) return null;
        usedConnectionKeys.add(endpointKey);
        let id = text(connection.id, 120) || createId();
        if (usedConnectionIds.has(id)) {
          if (strict) throw new Error(`Duplicate connection ID: ${id}.`);
          id = createId();
        }
        usedConnectionIds.add(id);
        return { id, firstDeviceId, firstPortId, secondDeviceId, secondPortId };
      })
      .filter(Boolean);

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
      rackUnits: RACK_SIZES.includes(Number(parsed.rackUnits))
        ? Number(parsed.rackUnits)
        : DEFAULT_RACK_UNITS,
      devices,
      connections,
    };
  }

  function cloneProject(project) {
    return JSON.parse(JSON.stringify(project));
  }

  // Reverses the formula guard added by csvEscape, so values survive a round trip.
  function csvUnescape(value) {
    const output = String(value ?? "");
    return /^'(?:[\t\r]|\s*[=+\-@])/.test(output) ? output.slice(1) : output;
  }

  function csvEscape(value) {
    let output = String(value ?? "");
    // OWASP CSV injection: neutralize formula triggers, including tab and CR prefixes.
    if (/^[\t\r]|^\s*[=+\-@]/.test(output)) output = `'${output}`;
    if (/[",\n\r]/.test(output)) output = `"${output.replace(/"/g, '""')}"`;
    return output;
  }

  function projectToCsv(projectInput) {
    const project = normalizeProject(projectInput);
    const toRow = (values) => CSV_HEADERS.map((header) => values[header] ?? "");
    const projectFields = {
      schemaVersion: SCHEMA_VERSION,
      projectName: project.projectName,
      projectOwner: project.owner,
      reviewDate: project.reviewDate,
      projectRackUnits: project.rackUnits,
    };
    const peers = new Map();
    project.connections.forEach((connection) => {
      const first = [connection.firstDeviceId, connection.firstPortId];
      const second = [connection.secondDeviceId, connection.secondPortId];
      const firstKey = JSON.stringify(first);
      const secondKey = JSON.stringify(second);
      if (!peers.has(firstKey)) peers.set(firstKey, second);
      if (!peers.has(secondKey)) peers.set(secondKey, first);
    });
    const rows = [
      CSV_HEADERS,
      toRow({ recordType: "PROJECT", ...projectFields }),
    ];
    project.devices.forEach((device) => {
      const deviceFields = {
        ...projectFields,
        deviceId: device.id,
        deviceName: device.name,
        deviceType: device.type,
        deviceLocation: device.location,
        portLayout: device.portLayout,
      };
      const details = Object.fromEntries(
        Object.entries(DEVICE_DETAIL_FIELDS).map(([field, column]) => [
          column,
          device[field],
        ]),
      );
      const rack = Object.fromEntries(
        Object.entries(DEVICE_RACK_FIELDS).map(([field, column]) => [
          column,
          device[field] ?? "",
        ]),
      );
      rows.push(
        toRow({ recordType: "DEVICE", ...deviceFields, ...details, ...rack }),
      );
      device.ports.forEach((port) => {
        const [linkedDeviceId = "", linkedPortId = ""] =
          peers.get(JSON.stringify([device.id, port.id])) || [];
        rows.push(
          toRow({
            recordType: "PORT",
            ...deviceFields,
            portId: port.id,
            portKind: port.portKind,
            portNumber: port.number,
            status: port.status,
            connectionType: port.connectionType,
            connectedTo: port.connectedTo,
            vlan: port.vlan,
            address: port.address,
            notes: port.notes,
            linkedDeviceId,
            linkedPortId,
          }),
        );
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
        headers.map((header, index) => [header, csvUnescape(row[index])]),
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
          ...Object.fromEntries(
            [
              ...Object.entries(DEVICE_DETAIL_FIELDS),
              ...Object.entries(DEVICE_RACK_FIELDS),
            ].map(([field, column]) => [field, record[column]]),
          ),
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
          linkedDeviceId: record.linkedDeviceId,
          linkedPortId: record.linkedPortId,
        });
      });
    const connections = [];
    const seenConnectionKeys = new Set();
    records
      .filter(
        (record) =>
          record.recordType === "PORT" &&
          record.linkedDeviceId &&
          record.linkedPortId,
      )
      .forEach((record) => {
        const first = `${record.deviceId}:${record.portId}`;
        const second = `${record.linkedDeviceId}:${record.linkedPortId}`;
        const key = [first, second].sort().join("|");
        if (seenConnectionKeys.has(key)) return;
        seenConnectionKeys.add(key);
        connections.push({
          id: createId(),
          firstDeviceId: record.deviceId,
          firstPortId: record.portId,
          secondDeviceId: record.linkedDeviceId,
          secondPortId: record.linkedPortId,
        });
      });
    return normalizeProject(
      {
        projectName: projectRecord.projectName,
        owner: projectRecord.projectOwner,
        reviewDate: projectRecord.reviewDate,
        rackUnits: projectRecord.projectRackUnits,
        devices: Array.from(devicesById.values()),
        connections,
      },
      { strict: true },
    );
  }

  function legacyCsvToProject(headers, rows) {
    if (!rows.length)
      throw new Error("The legacy CSV does not contain device data.");
    const records = rows.map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [header, csvUnescape(row[index])]),
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

  function portMatchesFilters(port, filters = {}) {
    if (
      filters.status &&
      filters.status !== "all" &&
      normalizeStatus(port.status) !== filters.status
    )
      return false;
    const query = String(filters.vlan || "")
      .trim()
      .toLowerCase();
    if (!query) return true;
    const vlan = String(port.vlan || "")
      .trim()
      .toLowerCase();
    if (/^\d+$/.test(query)) {
      return (vlan.match(/\b\d+\b/g) || []).some(
        (number) => Number(number) === Number(query),
      );
    }
    return vlan.includes(query);
  }

  function portLabel(device, port) {
    return `${device.name} · ${port.portKind} ${port.number}`;
  }

  // Moves a port's documentation (and its link) onto an Available, unlinked port
  // of the same device. The two ports swap their data, so nothing is lost: the
  // source port receives whatever the target held and becomes Available.
  function movePortData(projectInput, deviceId, fromPortId, toPortId) {
    const project = cloneProject(projectInput);
    project.connections ||= [];
    const device = project.devices.find((item) => item.id === deviceId);
    const from = device?.ports.find((port) => port.id === fromPortId);
    const to = device?.ports.find((port) => port.id === toPortId);
    if (!from || !to) throw new Error("Both ports must belong to the device.");
    if (from === to) throw new Error("Choose a different port.");
    const linkOf = (port) =>
      project.connections.find(
        (connection) =>
          (connection.firstDeviceId === deviceId &&
            connection.firstPortId === port.id) ||
          (connection.secondDeviceId === deviceId &&
            connection.secondPortId === port.id),
      );
    if (normalizeStatus(to.status) !== "available" || linkOf(to)) {
      throw new Error(
        `${to.portKind} ${to.number} is not available. Only Available ports without a link can receive data.`,
      );
    }
    const oldLabel = portLabel(device, from);
    PORT_DATA_FIELDS.forEach((field) => {
      [from[field], to[field]] = [to[field], from[field]];
    });
    from.status = "available";
    const link = linkOf(from);
    if (link) {
      const isFirst =
        link.firstDeviceId === deviceId && link.firstPortId === from.id;
      if (isFirst) link.firstPortId = to.id;
      else link.secondPortId = to.id;
      const peerDevice = project.devices.find(
        (item) =>
          item.id === (isFirst ? link.secondDeviceId : link.firstDeviceId),
      );
      const peer = peerDevice?.ports.find(
        (port) => port.id === (isFirst ? link.secondPortId : link.firstPortId),
      );
      if (peer && peer.connectedTo === oldLabel) {
        peer.connectedTo = portLabel(device, to);
      }
    }
    return project;
  }

  function buildNetworkModel(source) {
    const devices = source.devices || [];
    const devicesById = new Map(devices.map((device) => [device.id, device]));
    const endpoints = new Map();
    devices.forEach((device) =>
      device.ports.forEach((port) => {
        endpoints.set(JSON.stringify([device.id, port.id]), { device, port });
      }),
    );
    const links = (source.connections || []).map((connection) => ({
      connection,
      first:
        endpoints.get(
          JSON.stringify([connection.firstDeviceId, connection.firstPortId]),
        ) || null,
      second:
        endpoints.get(
          JSON.stringify([connection.secondDeviceId, connection.secondPortId]),
        ) || null,
    }));
    return { devicesById, endpoints, links };
  }

  function canonicalAddresses(value) {
    const addresses = new Set();
    String(value || "")
      .split(/[\s,;|]+/)
      .forEach((token) => {
        const candidate = token.split("/")[0].replace(/^\[|\]$/g, "");
        if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)) {
          const octets = candidate.split(".").map(Number);
          if (octets.every((octet) => octet <= 255)) {
            const address = octets.join(".");
            if (!["0.0.0.0", "255.255.255.255"].includes(address))
              addresses.add(address);
          }
        } else if (candidate.includes(":")) {
          try {
            const hostname = new global.URL(`http://[${candidate}]/`).hostname;
            const address = hostname.replace(/^\[|\]$/g, "");
            if (address !== "::") addresses.add(address);
          } catch {
            // MAC addresses, free-form notes and invalid IPs are not duplicate IPs.
          }
        }
      });
    return [...addresses];
  }

  function canonicalMac(value) {
    const hex = String(value || "")
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "");
    return hex.length === 12 ? hex.match(/../g).join(":") : "";
  }

  // Device-level checks: identifiers that must be unique to one physical
  // unit, and devices that overlap in the same rack.
  function analyzeInventory(devices, rackUnits = DEFAULT_RACK_UNITS) {
    const issues = [];
    const groups = [
      {
        title: "Duplicate serial number",
        label: "Serial number",
        keys: (device) => {
          const serial = String(device.serialNumber || "")
            .trim()
            .toUpperCase();
          return serial ? [serial] : [];
        },
      },
      {
        title: "Duplicate MAC address",
        label: "MAC address",
        keys: (device) => {
          const mac = canonicalMac(device.macAddress);
          return mac ? [mac.toUpperCase()] : [];
        },
      },
      {
        title: "Duplicate management IP",
        label: "Management IP",
        keys: (device) => canonicalAddresses(device.managementIp),
      },
    ];
    groups.forEach(({ title, label, keys }) => {
      const owners = new Map();
      devices.forEach((device) =>
        keys(device).forEach((key) => {
          if (!owners.has(key)) owners.set(key, []);
          owners.get(key).push(device);
        }),
      );
      owners.forEach((matches, key) => {
        if (matches.length < 2) return;
        issues.push({
          code: "duplicate-inventory",
          severity: "warning",
          title,
          message: `${label} ${key} is set on ${matches.length} devices: ${matches.map((device) => device.name).join(", ")}. Each physical unit should have its own value.`,
          endpoints: [],
          devices: matches.map((device) => device.id),
        });
      });
    });

    const racks = new Map();
    devices.forEach((device) => {
      const rack = String(device.rack || "").trim();
      if (!rack || !device.rackUnit) return;
      const key = rack.toLowerCase();
      if (!racks.has(key)) racks.set(key, { name: rack, devices: [] });
      racks.get(key).devices.push(device);
    });
    racks.forEach(({ name, devices: placed }) => {
      const sorted = [...placed].sort((a, b) => a.rackUnit - b.rackUnit);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const lower = sorted[i];
          const upper = sorted[j];
          if (upper.rackUnit > lower.rackUnit + (lower.rackHeight || 1) - 1)
            break;
          issues.push({
            code: "rack-overlap",
            severity: "error",
            title: "Devices overlap in a rack",
            message: `${lower.name} and ${upper.name} both use rack units in ${name} (U${upper.rackUnit}). Adjust their position or height.`,
            endpoints: [],
            devices: [lower.id, upper.id],
          });
        }
      }
      placed.forEach((device) => {
        const top = device.rackUnit + (device.rackHeight || 1) - 1;
        if (top <= rackUnits) return;
        issues.push({
          code: "rack-overflow",
          severity: "warning",
          title: "Device is above the rack size",
          message: `${device.name} uses U${top} in ${name}, but racks are set to ${rackUnits}U in Project information. Move it lower or choose a larger rack size.`,
          endpoints: [],
          devices: [device.id],
        });
      });
    });
    return issues;
  }

  function analyzeNetwork(source, model = buildNetworkModel(source)) {
    const issues = [];
    const references = new Map();
    const linkedEndpoints = new Set();
    const addresses = new Map();
    const endpointRef = (endpoint) => ({
      deviceId: endpoint.device.id,
      portId: endpoint.port.id,
    });
    const addIssue = (code, severity, title, message, endpoints) => {
      const issue = {
        code,
        severity,
        title,
        message,
        endpoints: endpoints.map(endpointRef),
      };
      issues.push(issue);
      return issue;
    };
    model.links.forEach(({ connection, first, second }) => {
      for (const endpoint of [first, second].filter(Boolean)) {
        const key = JSON.stringify([endpoint.device.id, endpoint.port.id]);
        if (!references.has(key))
          references.set(key, { endpoint, ids: new Set() });
        references.get(key).ids.add(connection.id);
      }
      if (
        !first ||
        !second ||
        (first.device.id === second.device.id &&
          first.port.id === second.port.id)
      ) {
        const issue = addIssue(
          "incomplete-link",
          "error",
          "Incomplete link",
          "A documented link references a missing port or has the same port at both ends. Review the saved link.",
          [...new Set([first, second].filter(Boolean))],
        );
        issue.connectionId = connection.id;
        return;
      }
      [first, second].forEach((endpoint) =>
        linkedEndpoints.add(
          JSON.stringify([endpoint.device.id, endpoint.port.id]),
        ),
      );
      const firstStatus = normalizeStatus(first.port.status);
      const secondStatus = normalizeStatus(second.port.status);
      if (
        firstStatus === "available" ||
        secondStatus === "available" ||
        (firstStatus === "active") !== (secondStatus === "active")
      ) {
        addIssue(
          "link-status",
          "warning",
          "Linked port status inconsistency",
          "A linked port is marked Available, or only one end is marked Active. This is a documentation check, not a live connectivity test.",
          [first, second],
        );
      }
    });
    references.forEach(({ endpoint, ids }) => {
      if (ids.size > 1)
        addIssue(
          "multiple-links",
          "error",
          "Port has multiple links",
          `${endpoint.port.portKind} ${endpoint.port.number} is used by ${ids.size} documented links. Confirm the intended peer.`,
          [endpoint],
        );
    });
    model.endpoints.forEach((endpoint, key) => {
      const { port } = endpoint;
      if (
        normalizeStatus(port.status) === "active" &&
        !String(port.connectedTo || "").trim() &&
        !linkedEndpoints.has(key)
      ) {
        addIssue(
          "missing-destination",
          "warning",
          "Active port without a destination",
          "Add the connected device name or link this active port to another documented port.",
          [endpoint],
        );
      }
      canonicalAddresses(port.address).forEach((address) => {
        if (!addresses.has(address)) addresses.set(address, []);
        addresses.get(address).push(endpoint);
      });
    });
    addresses.forEach((endpoints, address) => {
      if (endpoints.length < 2) return;
      addIssue(
        "duplicate-ip",
        "warning",
        "Possible duplicate IP",
        `${address} appears on ${endpoints.length} ports. Confirm whether this is the same endpoint or intentional address reuse across separate networks.`,
        endpoints,
      );
    });
    return issues.concat(
      analyzeInventory(
        source.devices || [],
        RACK_SIZES.includes(Number(source.rackUnits))
          ? Number(source.rackUnits)
          : DEFAULT_RACK_UNITS,
      ),
    );
  }

  const api = {
    SCHEMA_VERSION,
    LIMITS,
    STATUS_LABELS,
    CSV_HEADERS,
    DEVICE_DETAIL_FIELDS,
    DEVICE_DETAIL_LIMITS,
    DEVICE_RACK_FIELDS,
    RACK_LIMITS,
    RACK_SIZES,
    DEFAULT_RACK_UNITS,
    PORT_DATA_FIELDS,
    canonicalMac,
    createId,
    portLabel,
    movePortData,
    normalizeStatus,
    normalizeProject,
    cloneProject,
    projectToCsv,
    parseCsv,
    csvToProject,
    portMatchesFilters,
    buildNetworkModel,
    canonicalAddresses,
    analyzeNetwork,
  };
  global.VNetCoreCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
