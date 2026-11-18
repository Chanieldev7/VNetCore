"use strict";

const {
  SCHEMA_VERSION,
  LIMITS,
  STATUS_LABELS,
  createId,
  normalizeStatus,
  normalizeProject,
  cloneProject,
  projectToCsv,
  csvToProject,
  portMatchesFilters,
  buildNetworkModel,
  analyzeNetwork,
  DEVICE_DETAIL_LIMITS,
  portLabel,
  movePortData,
  RACK_LIMITS,
  DEFAULT_RACK_UNITS,
} = window.VNetCoreCore;

const DEVICE_DETAIL_LABELS = {
  manufacturer: "Manufacturer",
  serialNumber: "Serial number",
  macAddress: "MAC address",
  managementIp: "Management IP",
  firmware: "Firmware / OS",
  rack: "Rack",
  notes: "Notes",
};
// Identifiers that belong to one physical unit and must not be copied.
// A copy also loses its rack position, so it never overlaps the original.
const UNIQUE_DEVICE_DETAILS = ["serialNumber", "macAddress", "managementIp"];
// Device form field name -> device property (the form's notes field is renamed
// so it cannot be confused with the port form).
const DEVICE_FORM_DETAILS = {
  manufacturer: "manufacturer",
  serialNumber: "serialNumber",
  macAddress: "macAddress",
  managementIp: "managementIp",
  firmware: "firmware",
  rack: "rack",
  deviceNotes: "notes",
};

const STORAGE_KEY = `vnetcore.project.v${SCHEMA_VERSION}`;
const LEGACY_STORAGE_KEYS = ["vnetcore.project.v8", "vnetcore.project.v7"];
const BACKUP_KEY = `${STORAGE_KEY}.backup`;
const BACKUP_NOTICE_KEY = "vnetcore.backup-reminder.v1";
const THEME_STORAGE_KEY = "vnetcore.theme.v1";
const WORKSPACE_STORAGE_KEY = "vnetcore.workspace.v1";
const QUARANTINE_KEY = "vnetcore.recovery.v1";
const QUARANTINE_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_PROJECT = normalizeProject({
  projectName: "Unnamed project",
  devices: [],
});
const undoStack = [];
const portDrafts = new Map();
const PORT_EDIT_FIELDS = [
  "status",
  "connectionType",
  "connectedTo",
  "connectedPort",
  "vlan",
  "address",
  "notes",
];

let loadFailure = null;
let pendingImport = null;
let importMode = null;
let editingDeviceId = null;
let selectedDeviceId = null;
let selectedPortId = null;
let saveTimer = null;
let notificationTimer = null;
let hasUnsavedChanges = false;
let portFilterStatus = "all";
let portFilterVlan = "";
let viewProjectId = null;
let networkModel = null;
let networkIssues = [];
let selectedConnectionId = null;
let alertLimit = 20;
let connectionLimit = 20;
let draggedPortId = null;
let rackDrag = null;
let bulkMode = false;
let bulkAnchorId = null;
let bulkDeviceId = null;
const bulkSelection = new Set();
let backupNoticeState = loadBackupNoticeState();
let showBackupIntroduction = !backupNoticeState.infoShown;

function loadThemePreference() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  window.VNetCoreNotifications?.setTheme(isLight ? "light" : "dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", isLight ? "#ffffff" : "#080a0d");
  const toggle = document.querySelector("#themeToggleBtn");
  if (!toggle) return;
  toggle.setAttribute("aria-pressed", String(isLight));
  toggle.setAttribute(
    "aria-label",
    isLight ? "Switch to dark mode" : "Switch to light mode",
  );
  toggle.title = isLight ? "Switch to dark mode" : "Switch to light mode";
  toggle.querySelector(".theme-toggle-label").textContent = isLight
    ? "Dark mode"
    : "Light mode";
}

applyTheme(loadThemePreference());

const loaded = loadWorkspace();
let projectRecords = loaded.records;
let activeProjectId = loaded.activeId || projectRecords[0].id;
let project = projectRecords.find(
  (record) => record.id === activeProjectId,
).project;
let devices = project.devices;
selectedDeviceId = devices[0]?.id || null;

function loadProject() {
  const keys = [STORAGE_KEY, ...LEGACY_STORAGE_KEYS];
  for (const key of keys) {
    let saved;
    try {
      saved = localStorage.getItem(key);
    } catch (error) {
      loadFailure = { error, raw: "", key };
      return { project: cloneProject(EMPTY_PROJECT), migrated: false };
    }
    if (!saved) continue;
    try {
      return {
        project: normalizeProject(JSON.parse(saved), {
          preserveBrokenConnections: true,
        }),
        migrated: key !== STORAGE_KEY,
      };
    } catch (error) {
      loadFailure = { error, raw: saved, key };
      return { project: cloneProject(EMPTY_PROJECT), migrated: false };
    }
  }
  return { project: cloneProject(EMPTY_PROJECT), migrated: false };
}

function loadWorkspace() {
  let saved = "";
  try {
    saved = localStorage.getItem(WORKSPACE_STORAGE_KEY) || "";
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed.projects) && parsed.projects.length) {
        const records = parsed.projects.map((record) => ({
          id: String(record.id || createId()),
          project: normalizeProject(record.project || record, {
            preserveBrokenConnections: true,
          }),
        }));
        const activeId = records.some(
          (record) => record.id === parsed.activeProjectId,
        )
          ? parsed.activeProjectId
          : records[0].id;
        return { records, activeId, migrated: false };
      }
    }
  } catch (error) {
    loadFailure ||= { error, raw: saved, key: WORKSPACE_STORAGE_KEY };
  }
  const legacy = loadProject();
  return {
    records: [{ id: createId(), project: legacy.project }],
    activeId: null,
    migrated: legacy.migrated,
  };
}

// Unreadable stored data is copied aside before the next save can replace it,
// so every other project in a damaged workspace stays recoverable.
function quarantineUnreadableData(failure) {
  if (!failure?.raw) return false;
  try {
    let entries = [];
    try {
      const stored = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
      if (Array.isArray(stored)) entries = stored;
    } catch {
      // A damaged quarantine list is replaced by a fresh one.
    }
    if (!entries.some((entry) => entry?.raw === failure.raw)) {
      entries.push({
        key: failure.key,
        savedAt: new Date().toISOString(),
        raw: failure.raw,
      });
      localStorage.setItem(
        QUARANTINE_KEY,
        JSON.stringify(entries.slice(-QUARANTINE_LIMIT)),
      );
    }
    return true;
  } catch {
    return false;
  }
}

function isReadableJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function setSaveStatus(message, state = "") {
  const status = document.querySelector("#saveStatus");
  status.textContent = message;
  status.className = `save-status ${state}`.trim();
}

function saveProject(options = {}) {
  const { keepBackup = true } = options;
  project.devices = devices;
  project.updatedAt = new Date().toISOString();
  const activeRecord = projectRecords.find(
    (record) => record.id === activeProjectId,
  );
  if (activeRecord) activeRecord.project = project;
  const serialized = JSON.stringify(project);
  try {
    const previous = localStorage.getItem(STORAGE_KEY);
    // Never rotate unreadable data into the backup slot: it may hold the only good copy.
    if (
      keepBackup &&
      previous &&
      previous !== serialized &&
      isReadableJson(previous)
    ) {
      localStorage.setItem(BACKUP_KEY, previous);
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ activeProjectId, projects: projectRecords }),
    );
    hasUnsavedChanges = false;
    if (!loadFailure) window.VNetCoreNotifications?.dismiss("recovery");
    setSaveStatus(
      `Saved locally at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      "saved",
    );
    return true;
  } catch (error) {
    hasUnsavedChanges = true;
    setSaveStatus("Not saved. Export a recovery copy.", "error");
    showNotification(`Local save failed: ${error.message}`, {
      type: "error",
      title: "Changes could not be saved",
      recovery: true,
      persistent: true,
    });
    return false;
  }
}

function scheduleSave() {
  hasUnsavedChanges = true;
  setSaveStatus("Saving...", "saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveProject(), 350);
}

function snapshot() {
  return {
    project: cloneProject({ ...project, devices }),
    projectRecords: projectRecords.map((record) => ({
      id: record.id,
      project: cloneProject(record.project),
    })),
    activeProjectId,
    selectedDeviceId,
    selectedPortId,
  };
}

function rememberForUndo(previous, message) {
  undoStack.push({ ...previous, message });
  if (undoStack.length > 10) undoStack.shift();
}

function commitChange(previous, message) {
  rememberForUndo(previous, message);
  const saved = saveProject();
  render();
  if (saved) showNotification(message, { undo: true });
}

function undoLastChange() {
  const previous = undoStack.pop();
  if (!previous) return;
  if (previous.projectRecords) {
    projectRecords = previous.projectRecords.map((record) => ({
      id: record.id,
      project: normalizeProject(record.project, {
        preserveBrokenConnections: true,
      }),
    }));
    activeProjectId = previous.activeProjectId;
  }
  project = normalizeProject(previous.project, {
    preserveBrokenConnections: true,
  });
  const activeRecord = projectRecords.find(
    (record) => record.id === activeProjectId,
  );
  if (activeRecord) {
    activeRecord.project = project;
  }
  devices = project.devices;
  selectedDeviceId = devices.some(
    (device) => device.id === previous.selectedDeviceId,
  )
    ? previous.selectedDeviceId
    : devices[0]?.id || null;
  selectedPortId = previous.selectedPortId;
  const saved = saveProject();
  render();
  if (saved)
    showNotification(`Undone: ${previous.message}`, { title: "Change undone" });
}

function showNotification(message, options = {}) {
  const box = document.querySelector("#notification");
  const text = document.querySelector("#notificationText");
  const undo = document.querySelector("#undoBtn");
  const recovery = document.querySelector("#downloadRecoveryBtn");
  const restoreBackup = document.querySelector("#restoreBackupBtn");
  clearTimeout(notificationTimer);
  text.textContent = message;
  undo.hidden = !options.undo;
  recovery.hidden = !options.recovery;
  restoreBackup.hidden = !options.backup;
  if (window.VNetCoreNotifications) {
    box.hidden = true;
    const actions = [];
    if (options.undo)
      actions.push({
        label: "Undo",
        onClick: () => {
          undo.click();
          const target = currentPort()
            ? document.querySelector("#portForm").elements.status
            : document.querySelector("#deviceList .is-selected") ||
              document.querySelector("#newBlankProjectBtn");
          target?.focus({ preventScroll: true });
        },
      });
    if (options.recovery)
      actions.push({
        label: "Download recovery",
        onClick: () => recovery.click(),
      });
    if (options.backup)
      actions.push({
        label: "Restore backup",
        onClick: () => restoreBackup.click(),
      });
    return window.VNetCoreNotifications.show(message, {
      type:
        options.type ||
        (options.recovery || options.backup ? "error" : "success"),
      title: options.title,
      slot: options.recovery || options.backup ? "recovery" : "operation",
      persistent: Boolean(options.persistent),
      duration: options.undo ? 10000 : 6500,
      actions,
    });
  }
  box.hidden = false;
  if (!options.persistent) {
    notificationTimer = setTimeout(() => {
      box.hidden = true;
    }, 6500);
  }
}

function loadBackupNoticeState() {
  const now = Date.now();
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(BACKUP_NOTICE_KEY));
  } catch {
    // The reminder must not prevent access when browser storage is unavailable.
  }
  const validTime = (value) =>
    Number.isFinite(value) && value > 0 && value <= now;
  return {
    firstSeenAt: validTime(stored?.firstSeenAt) ? stored.firstSeenAt : now,
    lastExportAt: validTime(stored?.lastExportAt) ? stored.lastExportAt : null,
    infoShown: stored?.infoShown === true,
    dismissedLevel: ["reminder", "overdue"].includes(stored?.dismissedLevel)
      ? stored.dismissedLevel
      : null,
    dismissedAt: validTime(stored?.dismissedAt) ? stored.dismissedAt : null,
  };
}

function saveBackupNoticeState() {
  try {
    localStorage.setItem(BACKUP_NOTICE_KEY, JSON.stringify(backupNoticeState));
  } catch {
    // Keep the reminder functional for this session even without persistence.
  }
}

function renderBackupNotice() {
  const notice = document.querySelector("#backupNotice");
  const elapsed =
    Date.now() -
    (backupNoticeState.lastExportAt || backupNoticeState.firstSeenAt);
  const days = Math.floor(elapsed / DAY_MS);
  const level =
    days >= 30
      ? "overdue"
      : days >= 7
        ? "reminder"
        : showBackupIntroduction
          ? "info"
          : null;
  const snoozed =
    level === backupNoticeState.dismissedLevel &&
    backupNoticeState.dismissedAt !== null &&
    Date.now() - backupNoticeState.dismissedAt < DAY_MS;
  if (!level || snoozed) {
    hideBackupNotice();
    return;
  }
  const titles = {
    info: "Your data is stored in this browser",
    reminder: "Time for a backup",
    overdue: "Backup overdue — export your data",
  };
  const sinceExport = backupNoticeState.lastExportAt
    ? `It has been ${days} days since your last export.`
    : `You have not exported a backup in ${days} days since your first visit.`;
  const messages = {
    info: "Data stays in this browser. Export backups regularly to keep a copy outside this browser.",
    reminder: `${sinceExport} Export a backup when you have a moment.`,
    overdue: `${sinceExport} Your data is only stored in this browser and may be lost if browser data is cleared. Export a backup now.`,
  };
  notice.dataset.level = level;
  const title = document.querySelector("#backupNoticeTitle");
  const text = document.querySelector("#backupNoticeText");
  if (title.textContent !== titles[level]) title.textContent = titles[level];
  if (text.textContent !== messages[level]) text.textContent = messages[level];
  notice.hidden = false;
}

function hideBackupNotice() {
  const notice = document.querySelector("#backupNotice");
  if (notice.contains(document.activeElement)) {
    document.querySelector("#exportMenuBtn").focus({ preventScroll: true });
  }
  notice.hidden = true;
}

function recordBackupExport() {
  backupNoticeState.lastExportAt = Date.now();
  backupNoticeState.dismissedLevel = null;
  backupNoticeState.dismissedAt = null;
  showBackupIntroduction = false;
  saveBackupNoticeState();
  renderBackupNotice();
}

function readBackupProject() {
  try {
    const backup = localStorage.getItem(BACKUP_KEY);
    return backup ? normalizeProject(JSON.parse(backup)) : null;
  } catch {
    return null;
  }
}

function requestConfirmation(
  title,
  message,
  actionLabel,
  { destructive = false } = {},
) {
  const dialog = document.querySelector("#confirmDialog");
  if (dialog.open) return false;
  const trigger = document.activeElement;
  dialog.returnValue = "cancel";
  dialog.dataset.intent = destructive ? "danger" : "neutral";
  document.querySelector("#confirmDialogTitle").textContent = title;
  document.querySelector("#confirmDialogMessage").textContent = message;
  document.querySelector("#confirmDialogAction").textContent = actionLabel;
  dialog.showModal();
  document.querySelector("#confirmDialogCancel").focus({ preventScroll: true });
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        resolve(dialog.returnValue === "default");
      },
      { once: true },
    );
  });
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function countLinks(deviceIds, connections = project.connections || []) {
  const ids = new Set(deviceIds);
  return connections.filter(
    (connection) =>
      ids.has(connection.firstDeviceId) || ids.has(connection.secondDeviceId),
  ).length;
}

function makePorts(kind, count, existing = []) {
  const retained = existing
    .filter((port) => port.portKind === kind)
    .slice(0, count);
  for (let index = retained.length; index < count; index++) {
    retained.push({
      id: createId(),
      number: index + 1,
      status: kind === "WAN" ? "no-link" : "available",
      connectedTo: kind === "WAN" ? "Internet Provider" : "",
      connectionType: kind === "WAN" ? "WAN" : "",
      vlan: kind === "WAN" ? "WAN" : "",
      address: "",
      notes: kind === "WAN" ? "Default WAN port." : "",
      portKind: kind,
    });
  }
  return retained.map((port, index) => ({ ...port, number: index + 1 }));
}

function currentDevice() {
  return (
    devices.find((device) => device.id === selectedDeviceId) ||
    devices[0] ||
    null
  );
}

function currentPort() {
  return (
    currentDevice()?.ports.find((port) => port.id === selectedPortId) || null
  );
}

function findPort(deviceId, portId) {
  return devices
    .find((device) => device.id === deviceId)
    ?.ports.find((port) => port.id === portId);
}

function getConnectionForPort(port) {
  if (!port) return null;
  return (project.connections || []).find(
    (connection) =>
      (connection.firstDeviceId === currentDevice()?.id &&
        connection.firstPortId === port.id) ||
      (connection.secondDeviceId === currentDevice()?.id &&
        connection.secondPortId === port.id),
  );
}

function getPeerForPort(port) {
  const connection = getConnectionForPort(port);
  if (!connection) return null;
  const isFirst =
    connection.firstDeviceId === currentDevice()?.id &&
    connection.firstPortId === port.id;
  const deviceId = isFirst
    ? connection.secondDeviceId
    : connection.firstDeviceId;
  const portId = isFirst ? connection.secondPortId : connection.firstPortId;
  const device = devices.find((item) => item.id === deviceId);
  const peer = findPort(deviceId, portId);
  return device && peer ? { device, port: peer } : null;
}

function getConnectionValue(port) {
  const peer = getPeerForPort(port);
  return peer ? JSON.stringify([peer.device.id, peer.port.id]) : "";
}

function setPortConnection(port, value) {
  project.connections ||= [];
  const previousPeer = getPeerForPort(port);
  if (previousPeer && (!value || getConnectionValue(port) !== value)) {
    previousPeer.port.connectedTo = "";
  }
  const deviceId = currentDevice()?.id;
  project.connections = project.connections.filter((connection) => {
    const matchesCurrent =
      (connection.firstDeviceId === deviceId &&
        connection.firstPortId === port.id) ||
      (connection.secondDeviceId === deviceId &&
        connection.secondPortId === port.id);
    const matchesTarget = value
      ? (() => {
          const [targetDeviceId, targetPortId] = JSON.parse(value);
          return (
            (connection.firstDeviceId === targetDeviceId &&
              connection.firstPortId === targetPortId) ||
            (connection.secondDeviceId === targetDeviceId &&
              connection.secondPortId === targetPortId)
          );
        })()
      : false;
    return !matchesCurrent && !matchesTarget;
  });
  if (!value) return;
  const [targetDeviceId, targetPortId] = JSON.parse(value);
  const targetDevice = devices.find((device) => device.id === targetDeviceId);
  const targetPort = findPort(targetDeviceId, targetPortId);
  if (!targetDevice || !targetPort) return;
  project.connections.push({
    id: createId(),
    firstDeviceId: deviceId,
    firstPortId: port.id,
    secondDeviceId: targetDeviceId,
    secondPortId: targetPortId,
  });
  port.connectedTo = `${targetDevice.name} · ${targetPort.portKind} ${targetPort.number}`;
  targetPort.connectedTo = `${currentDevice().name} · ${port.portKind} ${port.number}`;
}

function portDraftKey(deviceId, portId) {
  return JSON.stringify([deviceId, portId]);
}

// Removes links whose ports were deleted by this change. Links that were already
// stale before the change are kept so Network alerts can still report them.
function dropLinksToRemovedPorts(previousDevices) {
  const remaining = new Set(
    devices.flatMap((device) =>
      device.ports.map((port) => portDraftKey(device.id, port.id)),
    ),
  );
  const removedLabels = new Map();
  previousDevices.forEach((device) =>
    device.ports.forEach((port) => {
      const key = portDraftKey(device.id, port.id);
      if (!remaining.has(key)) {
        removedLabels.set(
          key,
          `${device.name} · ${port.portKind} ${port.number}`,
        );
      }
    }),
  );
  if (!removedLabels.size) return;
  project.connections = (project.connections || []).filter((connection) => {
    const first = portDraftKey(
      connection.firstDeviceId,
      connection.firstPortId,
    );
    const second = portDraftKey(
      connection.secondDeviceId,
      connection.secondPortId,
    );
    if (!removedLabels.has(first) && !removedLabels.has(second)) return true;
    const [removedKey, survivor] = removedLabels.has(first)
      ? [first, [connection.secondDeviceId, connection.secondPortId]]
      : [second, [connection.firstDeviceId, connection.firstPortId]];
    const peer = findPort(...survivor);
    // Only clear the label the app generated for this link; keep user-written text.
    if (peer && peer.connectedTo === removedLabels.get(removedKey))
      peer.connectedTo = "";
    return false;
  });
}

function updatePortEditStatus() {
  const port = currentPort();
  const dirty =
    port && portDrafts.has(portDraftKey(currentDevice().id, port.id));
  const status = document.querySelector("#portEditStatus");
  const message = dirty
    ? "Unsaved changes. Your draft is kept while switching ports. Use Save port before leaving this page."
    : "No pending changes for this port.";
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle("is-dirty", Boolean(dirty));
  document.querySelector("#discardPortDraftBtn").hidden = !dirty;
  const summary = document.querySelector("#portDraftSummary");
  summary.hidden = portDrafts.size === 0;
  const count = portDrafts.size;
  const summaryText = `${count} port ${count === 1 ? "has" : "have"} unsaved changes. Select each port to save its draft before leaving or exporting.`;
  if (summary.textContent !== summaryText) summary.textContent = summaryText;
}

function rememberPortDraft() {
  const port = currentPort();
  if (!port) return;
  const form = document.querySelector("#portForm");
  const draft = Object.fromEntries(
    PORT_EDIT_FIELDS.map((field) => [field, form.elements[field].value]),
  );
  const key = portDraftKey(currentDevice().id, port.id);
  if (
    PORT_EDIT_FIELDS.some((field) => {
      const currentValue =
        field === "connectedPort" ? getConnectionValue(port) : port[field];
      return draft[field] !== String(currentValue ?? "");
    })
  ) {
    portDrafts.set(key, draft);
  } else {
    portDrafts.delete(key);
  }
  updatePortEditStatus();
}

function captureListFocus(container) {
  return container.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey
    : null;
}

function restoreListFocus(container, key) {
  if (!key) return;
  const replacement = Array.from(
    container.querySelectorAll("[data-focus-key]"),
  ).find((element) => element.dataset.focusKey === key);
  const fallback = container.querySelector(".is-selected, button");
  (replacement || fallback)?.focus({ preventScroll: true });
}

function setSidebarExpanded(expanded) {
  document
    .querySelector("#sidebar")
    .classList.toggle("is-collapsed", !expanded);
  document
    .querySelector(".layout")
    .classList.toggle("sidebar-collapsed", !expanded);
  const button = document.querySelector("#toggleSidebarBtn");
  button.setAttribute("aria-expanded", String(expanded));
  button.querySelector("span").textContent = expanded
    ? "Hide project panel"
    : "Show project panel";
}

function beginDeviceCreate() {
  setSidebarExpanded(true);
  document.querySelector(".add-device-card").open = true;
  cancelDeviceEdit();
  document.querySelector("#deviceForm").elements.model.focus();
}

function updatePortScrollHint() {
  const grid = document.querySelector("#portGrid");
  document.querySelector("#portScrollHint").hidden =
    grid.scrollWidth <= grid.clientWidth + 1;
}

function getKindCount(device, kind) {
  return device
    ? device.ports.filter((port) => port.portKind === kind).length
    : 0;
}

function getDeviceCounts(device) {
  const counts = { active: 0, "no-link": 0, available: 0, "unknown-device": 0 };
  device?.ports.forEach((port) => {
    counts[normalizeStatus(port.status)]++;
  });
  return counts;
}

function deviceMatchesSearch(device, search) {
  if (!search) return true;
  const fields = [
    device.name,
    device.type,
    device.location,
    ...Object.keys(DEVICE_DETAIL_LABELS).map((field) => device[field]),
  ];
  device.ports.forEach((port) =>
    fields.push(
      port.portKind,
      port.number,
      port.status,
      port.connectionType,
      port.connectedTo,
      port.vlan,
      port.address,
      port.notes,
    ),
  );
  return fields.some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(search),
  );
}

function createTrashIcon() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("aria-hidden", "true");
  const paths = [
    "M3 6h18",
    "M8 6V4h8v2",
    "M19 6l-1 14H6L5 6",
    "M10 11v6",
    "M14 11v6",
  ];
  paths.forEach((data) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    icon.appendChild(path);
  });
  return icon;
}

function renderProjectMeta() {
  const nameInput = document.querySelector("#projectNameInput");
  const ownerInput = document.querySelector("#projectOwnerInput");
  const reviewInput = document.querySelector("#projectReviewDateInput");
  if (document.activeElement !== nameInput)
    nameInput.value = project.projectName;
  if (document.activeElement !== ownerInput)
    ownerInput.value = project.owner || "";
  if (document.activeElement !== reviewInput)
    reviewInput.value = project.reviewDate || "";
  document.querySelector("#projectDisplayName").textContent =
    project.projectName || "Unnamed project";
  renderReviewStatus();
  const rackSize = project.rackUnits || DEFAULT_RACK_UNITS;
  document.querySelector("#projectRackUnitsSelect").value = String(rackSize);
  document.querySelector("#deviceForm").elements.rackUnit.max =
    String(rackSize);
  renderProjectSelector();
}

function renderProjectSelector() {
  const select = document.querySelector("#projectSelect");
  if (!select) return;
  select.replaceChildren();
  projectRecords.forEach((record) => {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = record.project.projectName || "Unnamed project";
    option.selected = record.id === activeProjectId;
    select.appendChild(option);
  });
  document.querySelector("#deleteProjectBtn").disabled =
    projectRecords.length === 1;
}

function activateProject(projectId) {
  const record = projectRecords.find((item) => item.id === projectId);
  if (!record || record.id === activeProjectId) return;
  saveProject();
  activeProjectId = record.id;
  project = record.project;
  devices = project.devices;
  selectedDeviceId = devices[0]?.id || null;
  selectedPortId = null;
  portDrafts.clear();
  cancelDeviceEdit();
  const saved = saveProject({ keepBackup: false });
  render();
  if (saved)
    showNotification(`Opened ${project.projectName}`, { type: "info" });
}

async function createNewProject() {
  const confirmed = await requestConfirmation(
    "Create a new project?",
    "A blank project opens. Your other projects stay saved in this browser.",
    "Create project",
  );
  if (!confirmed) return;
  const previous = snapshot();
  saveProject();
  const record = {
    id: createId(),
    project: normalizeProject({ projectName: "Unnamed project", devices: [] }),
  };
  projectRecords.push(record);
  activeProjectId = record.id;
  project = record.project;
  devices = project.devices;
  selectedDeviceId = null;
  selectedPortId = null;
  portDrafts.clear();
  cancelDeviceEdit();
  const saved = saveProject({ keepBackup: false });
  rememberForUndo(previous, "Created a new project");
  render();
  document.querySelector("#projectNameInput").focus();
  if (saved) showNotification("Created a new project.", { undo: true });
}

async function duplicateCurrentProject() {
  saveProject();
  const record = {
    id: createId(),
    project: cloneProject(project),
  };
  record.project.projectName = `${project.projectName} copy`.slice(
    0,
    LIMITS.projectName,
  );
  projectRecords.push(record);
  activeProjectId = record.id;
  project = record.project;
  devices = project.devices;
  selectedDeviceId = devices[0]?.id || null;
  selectedPortId = null;
  portDrafts.clear();
  render();
  if (saveProject({ keepBackup: false }))
    showNotification(`Duplicated ${record.project.projectName}`);
}

async function deleteCurrentProject() {
  if (projectRecords.length === 1) return;
  const portTotal = devices.reduce(
    (total, item) => total + item.ports.length,
    0,
  );
  const confirmed = await requestConfirmation(
    `Delete "${project.projectName}"?`,
    `Its ${plural(devices.length, "device")} and ${plural(portTotal, "port")} will be removed. Other projects are not affected. You can undo this right after.`,
    "Delete project",
    { destructive: true },
  );
  if (!confirmed) return;
  const previous = snapshot();
  const deletedName = project.projectName;
  projectRecords = projectRecords.filter(
    (record) => record.id !== activeProjectId,
  );
  const next = projectRecords[0];
  activeProjectId = next.id;
  project = next.project;
  devices = project.devices;
  selectedDeviceId = devices[0]?.id || null;
  selectedPortId = null;
  portDrafts.clear();
  cancelDeviceEdit();
  const saved = saveProject({ keepBackup: false });
  rememberForUndo(previous, `Deleted ${deletedName}`);
  render();
  if (saved) showNotification(`Deleted ${deletedName}`, { undo: true });
}

function renderDevices() {
  const list = document.querySelector("#deviceList");
  const focusKey = captureListFocus(list);
  const search = document
    .querySelector("#deviceSearchInput")
    .value.trim()
    .toLowerCase();
  const filtered = devices.filter((device) =>
    deviceMatchesSearch(device, search),
  );
  list.replaceChildren();
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = devices.length
      ? "No devices match the search."
      : "No devices have been added.";
    list.appendChild(empty);
    return;
  }
  filtered.forEach((device) => {
    const container = document.createElement("div");
    container.className = "device-item-container";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.focusKey = JSON.stringify(["device", device.id]);
    button.className = `device-item ${device.id === selectedDeviceId ? "is-selected" : ""}`;
    button.setAttribute("aria-pressed", String(device.id === selectedDeviceId));
    const name = document.createElement("strong");
    name.textContent = device.name;
    const meta = document.createElement("small");
    meta.textContent = `${device.type} | ${device.location || "No location"} | LAN: ${getKindCount(device, "LAN")} | WAN: ${getKindCount(device, "WAN")}`;
    button.append(name, meta);
    button.addEventListener("click", () => {
      selectedDeviceId = device.id;
      selectedPortId = null;
      render();
    });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.dataset.focusKey = JSON.stringify(["delete", device.id]);
    deleteButton.className = "delete-btn";
    deleteButton.setAttribute("aria-label", `Delete ${device.name}`);
    deleteButton.appendChild(createTrashIcon());
    deleteButton.addEventListener("click", () => deleteDevice(device));
    container.append(button, deleteButton);
    list.appendChild(container);
  });
  restoreListFocus(list, focusKey);
}

async function deleteDevice(device) {
  const links = countLinks([device.id]);
  const confirmed = await requestConfirmation(
    "Delete this device?",
    `"${device.name}" will be removed along with its ${plural(device.ports.length, "port")}${links ? ` and ${plural(links, "documented link")}` : ""}. You can undo this right after.`,
    "Delete device",
    { destructive: true },
  );
  if (!confirmed) return;
  const previous = snapshot();
  devices = devices.filter((item) => item.id !== device.id);
  dropLinksToRemovedPorts(previous.project.devices);
  if (selectedDeviceId === device.id) selectedDeviceId = devices[0]?.id || null;
  selectedPortId = null;
  commitChange(previous, `Deleted ${device.name}`);
}

async function clearAllDevices() {
  if (!devices.length) {
    showNotification("There are no devices to delete.", { type: "info" });
    return;
  }
  const portTotal = devices.reduce(
    (total, item) => total + item.ports.length,
    0,
  );
  const links = countLinks(devices.map((item) => item.id));
  const confirmed = await requestConfirmation(
    "Delete all devices?",
    `All ${plural(devices.length, "device")} in "${project.projectName}" will be removed along with their ${plural(portTotal, "port")}${links ? ` and ${plural(links, "documented link")}` : ""}. You can undo this right after.`,
    devices.length === 1
      ? "Delete 1 device"
      : `Delete ${devices.length} devices`,
    { destructive: true },
  );
  if (!confirmed) return;
  const previous = snapshot();
  devices = [];
  dropLinksToRemovedPorts(previous.project.devices);
  selectedDeviceId = null;
  selectedPortId = null;
  commitChange(previous, "Deleted all devices");
}

async function startBlankProject() {
  return createNewProject();
}

function renderHeader() {
  const device = currentDevice();
  const header = document.querySelector(".device-header");
  header.hidden = !device;
  if (!device) return updateLegendCounts(null);
  document.querySelector("#deviceType").textContent = device.type;
  document.querySelector("#deviceName").textContent = device.name;
  document.querySelector("#deviceMeta").textContent =
    `${device.location || "No location"} | LAN: ${getKindCount(device, "LAN")} | WAN: ${getKindCount(device, "WAN")}`;
  renderDeviceDetails(device);
  const index = devices.findIndex((item) => item.id === device.id);
  document.querySelector("#moveDeviceUpBtn").disabled = index <= 0;
  document.querySelector("#moveDeviceDownBtn").disabled =
    index < 0 || index === devices.length - 1;
  updateLegendCounts(device);
}

function renderDeviceDetails(device) {
  const list = document.querySelector("#deviceDetailsList");
  list.replaceChildren();
  Object.entries(DEVICE_DETAIL_LABELS).forEach(([field, label]) => {
    if (!device?.[field]) return;
    const item = document.createElement("div");
    item.className = field === "notes" ? "is-wide" : "";
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    value.textContent =
      field === "rack" ? rackPlacementText(device) : device[field];
    item.append(term, value);
    list.appendChild(item);
  });
  list.hidden = list.children.length === 0;
}

function deviceDetailsText(device) {
  return Object.entries(DEVICE_DETAIL_LABELS)
    .filter(([field]) => field !== "notes" && device[field])
    .map(
      ([field, label]) =>
        `${label}: ${field === "rack" ? rackPlacementText(device) : device[field]}`,
    )
    .join(" | ");
}

function scrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "instant"
    : "smooth";
}

// Brings the port editor into view after a port is chosen, unless it is
// already fully visible. Focus stays on the port so keyboard users keep their place.
function scrollToPortDetails() {
  const details = document.querySelector(".card.details");
  if (details.hidden) return;
  const rect = details.getBoundingClientRect();
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  if (rect.top >= 0 && rect.bottom <= viewportHeight) return;
  details.scrollIntoView({ block: "start", behavior: scrollBehavior() });
}

function canReceivePortData(port) {
  return (
    normalizeStatus(port.status) === "available" && !getConnectionForPort(port)
  );
}

function moveCurrentPortData(fromPortId, toPortId) {
  const device = currentDevice();
  if (!device) return false;
  if (
    portDrafts.has(portDraftKey(device.id, fromPortId)) ||
    portDrafts.has(portDraftKey(device.id, toPortId))
  ) {
    showNotification(
      "Save or discard the unsaved changes on these ports before moving data.",
      { type: "warning", title: "Port data not moved" },
    );
    return false;
  }
  let moved;
  try {
    moved = movePortData(
      { ...project, devices },
      device.id,
      fromPortId,
      toPortId,
    );
  } catch (error) {
    showNotification(error.message, {
      type: "warning",
      title: "Port data not moved",
    });
    return false;
  }
  const from = device.ports.find((port) => port.id === fromPortId);
  const to = device.ports.find((port) => port.id === toPortId);
  const message = `Moved ${from.portKind} ${from.number} to ${to.portKind} ${to.number}`;
  const previous = snapshot();
  project = moved;
  devices = project.devices;
  selectedPortId = toPortId;
  selectedConnectionId = getConnectionForPort(currentPort())?.id || null;
  commitChange(previous, message);
  return true;
}

function clearCurrentPort() {
  const port = currentPort();
  if (!port) return;
  const isEmpty =
    normalizeStatus(port.status) === "available" &&
    !getConnectionForPort(port) &&
    ["connectionType", "connectedTo", "vlan", "address", "notes"].every(
      (field) => !port[field],
    );
  const key = portDraftKey(currentDevice().id, port.id);
  if (isEmpty && !portDrafts.has(key)) {
    showNotification(`${port.portKind} ${port.number} is already empty.`, {
      type: "info",
    });
    return;
  }
  const previous = snapshot();
  setPortConnection(port, "");
  Object.assign(port, {
    status: "available",
    connectionType: "",
    connectedTo: "",
    vlan: "",
    address: "",
    notes: "",
  });
  portDrafts.delete(key);
  commitChange(previous, `Cleared ${port.portKind} port ${port.number}`);
}

// Keeps the "Device · LAN n" labels this app wrote on linked peers in step
// with a renamed device. Text the user typed is left untouched.
function refreshPeerLabels(device, previousName) {
  (project.connections || []).forEach((connection) => {
    [
      [
        connection.firstDeviceId,
        connection.firstPortId,
        connection.secondDeviceId,
        connection.secondPortId,
      ],
      [
        connection.secondDeviceId,
        connection.secondPortId,
        connection.firstDeviceId,
        connection.firstPortId,
      ],
    ].forEach(([deviceId, portId, peerDeviceId, peerPortId]) => {
      if (deviceId !== device.id) return;
      const own = device.ports.find((port) => port.id === portId);
      const peer = findPort(peerDeviceId, peerPortId);
      if (
        own &&
        peer &&
        peer.connectedTo === portLabel({ name: previousName }, own)
      ) {
        peer.connectedTo = portLabel(device, own);
      }
    });
  });
}

function updateLegendCounts(device) {
  const counts = getDeviceCounts(device);
  document.querySelector("#countActive").textContent = counts.active;
  document.querySelector("#countNoLink").textContent = counts["no-link"];
  document.querySelector("#countAvailable").textContent = counts.available;
  document.querySelector("#countUnknownDevice").textContent =
    counts["unknown-device"];
}

function createPortButton(port) {
  port.status = normalizeStatus(port.status);
  const button = document.createElement("button");
  button.type = "button";
  const linked = Boolean(getConnectionForPort(port));
  button.className = `port ${port.status} ${linked ? "is-linked" : ""} ${!bulkMode && port.id === selectedPortId ? "is-selected" : ""}`;
  button.dataset.focusKey = portDraftKey(currentDevice().id, port.id);
  button.dataset.portId = port.id;
  button.dataset.canReceive = String(canReceivePortData(port));
  button.draggable = !bulkMode;
  const pressed = bulkMode
    ? bulkSelection.has(port.id)
    : port.id === selectedPortId;
  button.classList.toggle("is-bulk-selected", bulkMode && pressed);
  button.setAttribute("aria-pressed", String(pressed));
  const number = document.createElement("span");
  number.className = "port-number";
  number.textContent = `${port.portKind} ${port.number}`;
  const status = document.createElement("span");
  status.className = "port-status";
  status.textContent = STATUS_LABELS[port.status];
  const label = document.createElement("span");
  label.className = "port-label";
  label.textContent = port.connectionType || "No type";
  label.title = label.textContent;
  const sublabel = document.createElement("span");
  sublabel.className = "port-sublabel";
  const peer = getPeerForPort(port);
  sublabel.textContent = peer
    ? `${peer.device.name} · ${peer.port.portKind} ${peer.port.number}`
    : port.connectedTo || port.vlan || "-";
  sublabel.title = sublabel.textContent;
  button.append(number, status, label, sublabel);
  if (bulkMode && pressed) {
    // Decorative: aria-pressed already announces the selection.
    const check = document.createElement("span");
    check.className = "port-bulk-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    button.appendChild(check);
  }
  const draft = portDrafts.has(portDraftKey(currentDevice().id, port.id));
  if (draft) {
    const draftLabel = document.createElement("span");
    draftLabel.className = "port-draft-label";
    draftLabel.textContent = "Unsaved";
    button.appendChild(draftLabel);
  }
  // No aria-label: the visible text is the accessible name, so speech-input users
  // can say exactly what they see (WCAG 2.5.3 Label in Name).
  return button;
}

function renderPorts() {
  const grid = document.querySelector("#portGrid");
  const device = currentDevice();
  const focusKey = captureListFocus(grid);
  const scrollLeft = grid.scrollLeft;
  const visiblePorts =
    device?.ports.filter((port) =>
      portMatchesFilters(port, {
        status: portFilterStatus,
        vlan: portFilterVlan,
      }),
    ) || [];
  renderPortFilters(device, visiblePorts.length);
  grid.replaceChildren();
  grid.classList.toggle("is-empty", visiblePorts.length === 0);
  if (!device) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "Add or select a device to view its interfaces.";
    grid.appendChild(message);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Add your first device";
    button.addEventListener("click", beginDeviceCreate);
    grid.appendChild(button);
    updatePortScrollHint();
    return;
  }
  if (!device.ports.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent =
      "This device has no network ports, like a UPS, PDU or shelf. Edit the device to add ports if it needs them.";
    grid.appendChild(message);
    updatePortScrollHint();
    return;
  }
  if (!visiblePorts.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent =
      "No ports match these filters. Reset the filters to see all interfaces.";
    grid.appendChild(message);
    updatePortScrollHint();
    return;
  }
  const layout =
    editingDeviceId === device.id
      ? document.querySelector("#devicePortLayoutSelect").value
      : device.portLayout;
  const splitLayout = layout === "split";
  const orderedPorts = [...visiblePorts].sort((first, second) => {
    if (first.portKind !== second.portKind)
      return first.portKind === "WAN" ? -1 : 1;
    return first.number - second.number;
  });
  grid.dataset.layout = splitLayout ? "split" : "alternating";
  grid.style.setProperty(
    "--port-columns",
    String(Math.max(1, Math.ceil(orderedPorts.length / 2))),
  );
  orderedPorts.forEach((port) => {
    const button = createPortButton(port);
    button.addEventListener("click", (event) => {
      if (bulkMode) {
        toggleBulkPort(port.id, event.shiftKey);
        return;
      }
      selectedPortId = port.id;
      selectedConnectionId = getConnectionForPort(port)?.id || null;
      renderPorts();
      renderPortForm();
      renderConnectionMap();
      scrollToPortDetails();
    });
    attachPortDragAndDrop(button, port, grid);
    grid.appendChild(button);
  });
  grid.scrollLeft = scrollLeft;
  restoreListFocus(grid, focusKey);
  updatePortScrollHint();
}

// Pointer shortcut for "Move this port's data to". The select in Port details
// offers the same action for keyboard, touch and assistive technology users.
function attachPortDragAndDrop(button, port, grid) {
  button.addEventListener("dragstart", (event) => {
    draggedPortId = port.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${port.portKind} ${port.number}`);
    button.classList.add("is-dragging");
    grid.classList.add("is-drag-active");
  });
  button.addEventListener("dragend", () => {
    draggedPortId = null;
    button.classList.remove("is-dragging");
    grid.classList.remove("is-drag-active");
    grid
      .querySelectorAll(".is-drop-target")
      .forEach((element) => element.classList.remove("is-drop-target"));
  });
  const accepts = () =>
    draggedPortId !== null &&
    draggedPortId !== port.id &&
    button.dataset.canReceive === "true";
  button.addEventListener("dragover", (event) => {
    if (!accepts()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    button.classList.add("is-drop-target");
  });
  button.addEventListener("dragleave", () =>
    button.classList.remove("is-drop-target"),
  );
  button.addEventListener("drop", (event) => {
    if (!accepts()) return;
    event.preventDefault();
    const fromPortId = draggedPortId;
    draggedPortId = null;
    grid.classList.remove("is-drag-active");
    if (moveCurrentPortData(fromPortId, port.id)) {
      Array.from(grid.querySelectorAll(".port"))
        .find((element) => element.dataset.portId === port.id)
        ?.focus({ preventScroll: true });
    }
  });
}

function clearPortFilters() {
  portFilterStatus = "all";
  portFilterVlan = "";
  document.querySelector("#portVlanFilter").value = "";
}

function renderPortFilters(device, visibleCount) {
  const counts = getDeviceCounts(device);
  document.querySelectorAll("[data-port-status]").forEach((button) => {
    const status = button.dataset.portStatus;
    const label = status === "all" ? "All" : STATUS_LABELS[status];
    const count = status === "all" ? device?.ports.length || 0 : counts[status];
    button.textContent = `${label} (${count})`;
    button.setAttribute("aria-pressed", String(status === portFilterStatus));
    button.disabled = !device?.ports.length;
  });
  document.querySelector("#portVlanFilter").disabled = !device?.ports.length;
  document.querySelector("#resetPortFiltersBtn").disabled =
    portFilterStatus === "all" && !portFilterVlan;
  const selectedIsHidden =
    currentPort() &&
    !portMatchesFilters(currentPort(), {
      status: portFilterStatus,
      vlan: portFilterVlan,
    });
  document.querySelector("#portFilterSummary").textContent = device
    ? `Showing ${visibleCount} of ${device.ports.length} ports.${selectedIsHidden ? " The selected port is hidden by these filters. Its details remain open." : ""}`
    : "Select a device to filter its ports.";
}

function renderConnectionOptions(port) {
  const select = document.querySelector("#connectedPortSelect");
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No linked port";
  select.appendChild(none);
  devices.forEach((device) => {
    const group = document.createElement("optgroup");
    group.label = `${device.name} · ${device.type}`;
    device.ports.forEach((candidate) => {
      if (device.id === currentDevice()?.id && candidate.id === port.id) return;
      const option = document.createElement("option");
      option.value = JSON.stringify([device.id, candidate.id]);
      option.textContent = `${candidate.portKind} ${candidate.number}${candidate.connectedTo ? ` · ${candidate.connectedTo}` : ""}`;
      option.selected = option.value === getConnectionValue(port);
      group.appendChild(option);
    });
    if (group.children.length) select.appendChild(group);
  });
}

function renderPortForm() {
  const port = currentPort();
  const card = document.querySelector(".card.details");
  card.hidden = !port;
  updatePortEditStatus();
  if (!port) return;
  const form = document.querySelector("#portForm");
  const draft = portDrafts.get(portDraftKey(currentDevice().id, port.id));
  renderConnectionOptions(port);
  Object.entries({ ...port, ...draft }).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value ?? "";
  });
  form.elements.number.value = `${port.portKind} ${port.number}`;
  form.elements.connectedPort.value =
    draft?.connectedPort ?? getConnectionValue(port);
  document.querySelector("#openLinkedPortBtn").hidden = !getPeerForPort(port);
  renderMoveOptions(port);
}

function renderMoveOptions(port) {
  const select = document.querySelector("#movePortSelect");
  const button = document.querySelector("#movePortBtn");
  const previousValue = select.value;
  const candidates = currentDevice().ports.filter(
    (candidate) => candidate.id !== port.id && canReceivePortData(candidate),
  );
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = candidates.length
    ? "Choose an Available port"
    : "No Available ports on this device";
  select.appendChild(placeholder);
  candidates.forEach((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = `${candidate.portKind} ${candidate.number}`;
    select.appendChild(option);
  });
  if (candidates.some((candidate) => candidate.id === previousValue)) {
    select.value = previousValue;
  }
  select.disabled = candidates.length === 0;
  button.disabled = !select.value;
}

function openLinkedPort() {
  const peer = getPeerForPort(currentPort());
  if (!peer) return;
  selectedDeviceId = peer.device.id;
  selectedPortId = peer.port.id;
  clearPortFilters();
  render();
  document
    .querySelector(".details")
    .scrollIntoView({ block: "start", behavior: "smooth" });
}

function renderProjectDevicesSummary() {
  const container = document.querySelector("#projectDevicesSummary");
  const focusKey = captureListFocus(container);
  const search = document
    .querySelector("#deviceSearchInput")
    .value.trim()
    .toLowerCase();
  const filtered = devices.filter((device) =>
    deviceMatchesSearch(device, search),
  );
  container.replaceChildren();
  container.classList.toggle("is-empty", !filtered.length);
  if (!filtered.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = devices.length
      ? "No matching devices."
      : "No devices have been added to this project.";
    container.appendChild(message);
    return;
  }
  // Column labels for sighted users; each row's text is self-describing, so
  // the header is hidden from assistive technology.
  const header = document.createElement("div");
  header.className = "summary-header";
  header.setAttribute("aria-hidden", "true");
  ["Device", "Port status", "Ports"].forEach((label) => {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.appendChild(cell);
  });
  container.appendChild(header);
  filtered.forEach((device) => {
    const counts = getDeviceCounts(device);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `summary-device ${device.id === selectedDeviceId ? "is-selected" : ""}`;
    button.dataset.focusKey = JSON.stringify(["summary", device.id]);
    button.setAttribute("aria-pressed", String(device.id === selectedDeviceId));

    const identity = document.createElement("span");
    identity.className = "summary-device-identity";
    const name = document.createElement("strong");
    name.textContent = device.name;
    const meta = document.createElement("small");
    meta.textContent = [device.type, device.location || "No location"].join(
      " · ",
    );
    identity.append(name, meta);

    const usage = document.createElement("span");
    usage.className = "summary-device-usage";
    const bar = document.createElement("span");
    bar.className = "port-usage-bar";
    bar.setAttribute("aria-hidden", "true");
    Object.keys(STATUS_LABELS).forEach((status) => {
      if (!counts[status]) return;
      const segment = document.createElement("i");
      segment.className = status;
      segment.style.flexGrow = String(counts[status]);
      bar.appendChild(segment);
    });
    const statuses = document.createElement("small");
    statuses.className = "summary-device-counts";
    // Zero counts are omitted: the bar already shows which states are absent.
    statuses.textContent =
      [
        [counts.active, "active"],
        [counts["no-link"], "no link"],
        [counts.available, "available"],
        [counts["unknown-device"], "unknown"],
      ]
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label}`)
        .join(" · ") || "No ports";
    usage.append(bar, statuses);

    const ports = document.createElement("span");
    ports.className = "summary-device-ports";
    const total = document.createElement("strong");
    total.textContent = `${device.ports.length} ${device.ports.length === 1 ? "port" : "ports"}`;
    const kinds = document.createElement("small");
    kinds.textContent = `LAN ${getKindCount(device, "LAN")} · WAN ${getKindCount(device, "WAN")}`;
    ports.append(total, kinds);

    button.append(identity, usage, ports);
    button.addEventListener("click", () => {
      selectedDeviceId = device.id;
      selectedPortId = null;
      render();
      document.querySelector(".device-header").scrollIntoView({
        block: "start",
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches
          ? "instant"
          : "smooth",
      });
    });
    container.appendChild(button);
  });
  restoreListFocus(container, focusKey);
}

function endpointLabel(endpoint) {
  return `${endpoint.device.name} · ${endpoint.port.portKind} ${endpoint.port.number}`;
}

function openNetworkEndpoint(reference) {
  if (!findPort(reference.deviceId, reference.portId)) return;
  selectedDeviceId = reference.deviceId;
  selectedPortId = reference.portId;
  const selectedLink = networkModel?.links.find(
    (link) => link.connection.id === selectedConnectionId,
  );
  if (
    ![selectedLink?.first, selectedLink?.second].some(
      (endpoint) =>
        endpoint?.device.id === reference.deviceId &&
        endpoint?.port.id === reference.portId,
    )
  )
    selectedConnectionId = getConnectionForPort(currentPort())?.id || null;
  clearPortFilters();
  render();
  document
    .querySelector("#portForm")
    .elements.status.focus({ preventScroll: true });
  document.querySelector(".details").scrollIntoView({
    block: "start",
    behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
}

function createEndpointAction(endpoint, key) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-btn network-issue-action";
  button.textContent = `Open ${endpointLabel(endpoint)}`;
  button.dataset.focusKey = key;
  button.addEventListener("click", () =>
    openNetworkEndpoint({
      deviceId: endpoint.device.id,
      portId: endpoint.port.id,
    }),
  );
  return button;
}

async function removeBrokenConnection(id) {
  const confirmed = await requestConfirmation(
    "Remove this broken link?",
    "It points to a port that no longer exists. No devices or ports are deleted, and you can undo this right after.",
    "Remove link",
    { destructive: true },
  );
  if (
    !confirmed ||
    !networkIssues.some(
      (issue) => issue.code === "incomplete-link" && issue.connectionId === id,
    )
  )
    return;
  const previous = snapshot();
  project.connections = project.connections.filter(
    (connection) => connection.id !== id,
  );
  commitChange(previous, "Removed broken link");
  document
    .querySelector(".network-alerts-toggle")
    .focus({ preventScroll: true });
}

function renderNetworkAlerts() {
  const list = document.querySelector("#networkAlertsList");
  const focusKey = captureListFocus(list);
  const filter = document.querySelector("#networkAlertFilter").value;
  const filtered = networkIssues.filter(
    (issue) => filter === "all" || issue.code === filter,
  );
  const count = networkIssues.length;
  const countElement = document.querySelector("#networkAlertsCount");
  const countText = count ? `${count} to review` : "No issues found";
  if (countElement.textContent !== countText)
    countElement.textContent = countText;
  document
    .querySelector("#networkAlerts")
    .classList.toggle("has-issues", count > 0);
  const visible = filtered.slice(0, alertLimit);
  const summary = document.querySelector("#networkAlertsSummary");
  const summaryText = !count
    ? devices.length
      ? "No inconsistencies found in the saved documentation."
      : "Add devices and document their ports to run these checks."
    : !filtered.length
      ? "No alerts in this category."
      : `Showing ${visible.length} of ${filtered.length} alerts. Unsaved port drafts are not checked.`;
  if (summary.textContent !== summaryText) summary.textContent = summaryText;
  list.replaceChildren();
  visible.forEach((issue, index) => {
    const item = document.createElement("li");
    item.className = `network-issue ${issue.severity}`;
    const heading = document.createElement("h3");
    const badge = document.createElement("span");
    badge.className = "issue-badge";
    badge.textContent = issue.severity === "error" ? "Error" : "Review";
    heading.append(badge, document.createTextNode(issue.title));
    const description = document.createElement("p");
    description.textContent = issue.message;
    const actions = document.createElement("div");
    actions.className = "network-issue-actions";
    const endpoints = issue.endpoints
      .map((reference) =>
        networkModel.endpoints.get(
          JSON.stringify([reference.deviceId, reference.portId]),
        ),
      )
      .filter(Boolean);
    let shown = 0;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "secondary-btn";
    const appendEndpoints = () => {
      const end = Math.min(shown + 6, endpoints.length);
      let firstAdded = null;
      for (; shown < end; shown++) {
        const button = createEndpointAction(
          endpoints[shown],
          JSON.stringify(["alert", issue.code, index, shown]),
        );
        actions.insertBefore(button, more);
        firstAdded ||= button;
      }
      more.hidden = shown >= endpoints.length;
      more.textContent = `Show ${Math.min(6, endpoints.length - shown)} more ports`;
      return firstAdded;
    };
    actions.appendChild(more);
    appendEndpoints();
    more.addEventListener("click", () => appendEndpoints()?.focus());
    (issue.devices || []).forEach((deviceId, deviceIndex) => {
      const device = devices.find((item) => item.id === deviceId);
      if (!device) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-btn network-issue-action";
      button.textContent = `Open ${device.name}`;
      button.dataset.focusKey = JSON.stringify([
        "alert-device",
        issue.code,
        index,
        deviceIndex,
      ]);
      button.addEventListener("click", () => openDevice(device.id));
      actions.insertBefore(button, more);
    });
    if (issue.code === "incomplete-link" && issue.connectionId) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-small-btn remove-broken-link";
      remove.textContent = "Remove broken link";
      remove.dataset.focusKey = JSON.stringify([
        "remove-broken-link",
        issue.connectionId,
      ]);
      remove.addEventListener("click", () =>
        removeBrokenConnection(issue.connectionId),
      );
      actions.appendChild(remove);
    }
    item.append(heading, description, actions);
    list.appendChild(item);
  });
  const moreButton = document.querySelector("#showMoreAlertsBtn");
  moreButton.hidden = filtered.length <= alertLimit;
  moreButton.textContent = `Show ${Math.min(20, Math.max(0, filtered.length - alertLimit))} more alerts`;
  restoreListFocus(list, focusKey);
}

function linkState(link) {
  const states = [link.first.port.status, link.second.port.status].map(
    normalizeStatus,
  );
  if (states.every((status) => status === "active")) return "active";
  if (states.includes("unknown-device")) return "unknown-device";
  if (states.every((status) => status === "available")) return "available";
  return "no-link";
}

function selectNetworkConnection(id) {
  selectedConnectionId = id;
  renderConnectionMap();
}

function renderConnectionMap() {
  if (!networkModel) return;
  const card = document.querySelector(".topology-card");
  const focusKey = captureListFocus(card);
  const canvas = document.querySelector("#topologyCanvas");
  const list = document.querySelector("#topologyConnectionList");
  const detail = document.querySelector("#topologySelectedLink");
  const scope = document.querySelector("#topologyScope");
  scope.disabled = !devices.length;
  const validLinks = networkModel.links.filter(
    (link) =>
      link.first &&
      link.second &&
      !(
        link.first.device.id === link.second.device.id &&
        link.first.port.id === link.second.port.id
      ),
  );
  const visibleIds = new Set(
    scope.value === "neighbors"
      ? [selectedDeviceId]
      : devices.map((device) => device.id),
  );
  if (scope.value === "neighbors") {
    validLinks.forEach((link) => {
      if (link.first.device.id === selectedDeviceId)
        visibleIds.add(link.second.device.id);
      if (link.second.device.id === selectedDeviceId)
        visibleIds.add(link.first.device.id);
    });
  }
  const visibleDevices = devices.filter((device) => visibleIds.has(device.id));
  const visibleLinks = validLinks.filter(
    (link) =>
      visibleIds.has(link.first.device.id) &&
      visibleIds.has(link.second.device.id),
  );
  const selected = visibleLinks.find(
    (link) => link.connection.id === selectedConnectionId,
  );
  const selectedDevices = new Set(
    selected ? [selected.first.device.id, selected.second.device.id] : [],
  );
  const groups = new Map();
  const degrees = new Map();
  visibleLinks.forEach((link) => {
    const ids = [link.first.device.id, link.second.device.id].sort();
    const key = JSON.stringify(ids);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
    new Set(ids).forEach((id) => degrees.set(id, (degrees.get(id) || 0) + 1));
  });
  const summary = document.querySelector("#topologySummary");
  const summaryText = `${visibleDevices.length} devices · ${visibleLinks.length} documented links`;
  if (summary.textContent !== summaryText) summary.textContent = summaryText;
  canvas.replaceChildren();
  list.replaceChildren();
  detail.replaceChildren();
  detail.hidden = !selected;
  const hint = document.querySelector("#topologyHint");
  hint.textContent =
    groups.size > 300
      ? `Dense map: showing 300 of ${groups.size} bundled device-to-device links. Use the connection list to inspect every documented link.`
      : "Select a device to review it, or select a link to highlight both ends. The connection list is also keyboard accessible.";
  if (!visibleDevices.length) {
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent =
      "Add devices and link their ports to build the connection map.";
    canvas.appendChild(empty);
  } else {
    const columns = Math.min(4, Math.ceil(Math.sqrt(visibleDevices.length)));
    const width = Math.max(720, columns * 220 + 40);
    const height = Math.max(
      200,
      Math.ceil(visibleDevices.length / columns) * 124 + 42,
    );
    const offset = (width - (columns * 180 + (columns - 1) * 40)) / 2;
    const positions = new Map(
      visibleDevices.map((device, index) => [
        device.id,
        {
          x: offset + (index % columns) * 220,
          y: 42 + Math.floor(index / columns) * 124,
        },
      ]),
    );
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("topology-wires");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const bundles = [...groups.values()];
    const shownBundles = bundles.slice(0, 300);
    const selectedBundle = bundles.find((bundle) => bundle.includes(selected));
    if (selectedBundle && !shownBundles.includes(selectedBundle))
      shownBundles.push(selectedBundle);
    shownBundles.sort(
      (first, second) =>
        Number(first.includes(selected)) - Number(second.includes(selected)),
    );
    shownBundles.forEach((bundle) => {
      const index = bundles.indexOf(bundle);
      const link =
        bundle.find((candidate) => candidate === selected) || bundle[0];
      const first = positions.get(link.first.device.id);
      const second = positions.get(link.second.device.id);
      let path;
      if (first === second) {
        path = `M ${first.x + 180} ${first.y + 24} C ${first.x + 250} ${first.y - 40}, ${first.x + 250} ${first.y + 120}, ${first.x + 180} ${first.y + 56}`;
      } else if (first.y !== second.y) {
        const start = first.y < second.y ? first : second;
        const end = first.y < second.y ? second : first;
        const corridor = start.x + 190 + (index % 4) * 6;
        const lane = end.y - 12 - (index % 5) * 5;
        path = `M ${start.x + 180} ${start.y + 40} L ${corridor} ${start.y + 40} L ${corridor} ${lane} L ${end.x + 90} ${lane} L ${end.x + 90} ${end.y}`;
      } else {
        const start = first.x < second.x ? first : second;
        const end = first.x < second.x ? second : first;
        if (end.x - start.x <= 220) {
          path = `M ${start.x + 180} ${start.y + 40} L ${end.x} ${end.y + 40}`;
        } else {
          const lane = start.y - 14 - (index % 5) * 5;
          path = `M ${start.x + 90} ${start.y} L ${start.x + 90} ${lane} L ${end.x + 90} ${lane} L ${end.x + 90} ${end.y}`;
        }
      }
      const group = document.createElementNS(svg.namespaceURI, "g");
      group.classList.add("topology-wire-group", linkState(link));
      if (bundle.includes(selected)) group.classList.add("is-selected");
      const title = document.createElementNS(svg.namespaceURI, "title");
      title.textContent = `${link.first.device.name} ↔ ${link.second.device.name} · ${bundle.length} documented ${bundle.length === 1 ? "link" : "links"}`;
      group.appendChild(title);
      ["topology-wire", "topology-wire-hit"].forEach((className) => {
        const element = document.createElementNS(svg.namespaceURI, "path");
        element.classList.add(className);
        element.setAttribute("d", path);
        group.appendChild(element);
      });
      group.addEventListener("click", () =>
        selectNetworkConnection(link.connection.id),
      );
      svg.appendChild(group);
    });
    canvas.appendChild(svg);
    visibleDevices.forEach((device) => {
      const point = positions.get(device.id);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "topology-node";
      button.classList.toggle("is-selected", device.id === selectedDeviceId);
      button.classList.toggle(
        "is-link-endpoint",
        selectedDevices.has(device.id),
      );
      button.dataset.deviceId = device.id;
      button.dataset.focusKey = JSON.stringify(["topology-device", device.id]);
      button.setAttribute(
        "aria-pressed",
        String(device.id === selectedDeviceId),
      );
      button.style.left = `${point.x}px`;
      button.style.top = `${point.y}px`;
      const name = document.createElement("strong");
      name.textContent = device.name;
      name.title = device.name;
      const type = document.createElement("span");
      type.textContent = device.type;
      const count = document.createElement("small");
      count.textContent = `${degrees.get(device.id) || 0} links · ${device.ports.length} ports`;
      button.append(name, type, count);
      if (selectedDevices.has(device.id)) {
        const endpointNote = document.createElement("span");
        endpointNote.className = "sr-only";
        endpointNote.textContent = "Endpoint of selected connection";
        button.appendChild(endpointNote);
      }
      button.addEventListener("click", () => {
        selectedDeviceId = device.id;
        selectedPortId = null;
        render();
      });
      canvas.appendChild(button);
    });
  }
  if (selected) {
    const title = document.createElement("strong");
    title.textContent = "Selected connection";
    const description = document.createElement("p");
    description.textContent = `${endpointLabel(selected.first)} ↔ ${endpointLabel(selected.second)}`;
    const actions = document.createElement("div");
    actions.className = "network-issue-actions";
    actions.append(
      createEndpointAction(
        selected.first,
        JSON.stringify(["link-endpoint", selected.connection.id, "first"]),
      ),
      createEndpointAction(
        selected.second,
        JSON.stringify(["link-endpoint", selected.connection.id, "second"]),
      ),
    );
    detail.append(title, description, actions);
  }
  if (!visibleLinks.length) {
    const empty = document.createElement("li");
    empty.className = "insight-description";
    empty.textContent =
      "No documented connections in this view. Use Linked port in Port details to add a link.";
    list.appendChild(empty);
  }
  visibleLinks.slice(0, connectionLimit).forEach((link) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `topology-link ${linkState(link)}`;
    button.classList.toggle("is-selected", link === selected);
    button.dataset.focusKey = JSON.stringify([
      "topology-link",
      link.connection.id,
    ]);
    button.dataset.connectionId = link.connection.id;
    button.setAttribute("aria-pressed", String(link === selected));
    const label = document.createElement("strong");
    label.textContent = `${endpointLabel(link.first)} ↔ ${endpointLabel(link.second)}`;
    const statuses = document.createElement("span");
    statuses.textContent = `${STATUS_LABELS[normalizeStatus(link.first.port.status)]} / ${STATUS_LABELS[normalizeStatus(link.second.port.status)]}`;
    button.append(label, statuses);
    button.addEventListener("click", () =>
      selectNetworkConnection(link.connection.id),
    );
    item.appendChild(button);
    list.appendChild(item);
  });
  const moreButton = document.querySelector("#showMoreConnectionsBtn");
  moreButton.hidden = visibleLinks.length <= connectionLimit;
  moreButton.textContent = `Show ${Math.min(20, Math.max(0, visibleLinks.length - connectionLimit))} more connections`;
  restoreListFocus(card, focusKey);
}

function renderPrintReport() {
  const report = document.querySelector("#printReport");
  report.replaceChildren();
  const header = document.createElement("header");
  header.className = "print-header";
  const title = document.createElement("h1");
  title.textContent = "VNetCore";
  const meta = document.createElement("p");
  meta.textContent = `Network Infrastructure Documentation | Responsible: ${project.owner || "Not specified"} | Review: ${project.reviewDate || "Not specified"} | Generated: ${new Date().toLocaleString()}`;
  header.append(title, meta);
  report.appendChild(header);

  const projectBanner = document.createElement("section");
  projectBanner.className = "print-project-banner";
  const projectLabel = document.createElement("span");
  projectLabel.textContent = "Active project";
  const projectName = document.createElement("strong");
  projectName.textContent = project.projectName || "Unnamed project";
  projectBanner.append(projectLabel, projectName);
  report.appendChild(projectBanner);

  if (!devices.length) {
    const empty = document.createElement("p");
    empty.textContent = "No devices have been added to this project.";
    report.appendChild(empty);
    return;
  }

  const overview = document.createElement("section");
  overview.className = "print-overview";
  const overviewLabel = document.createElement("span");
  overviewLabel.className = "print-section-label";
  overviewLabel.textContent = "Project overview";
  const overviewTitle = document.createElement("h2");
  overviewTitle.textContent = "All devices";
  const summaryGrid = document.createElement("div");
  summaryGrid.className = "print-summary-grid";
  devices.forEach((device) => {
    const counts = getDeviceCounts(device);
    const summary = document.createElement("article");
    summary.className = "print-summary-device";
    const name = document.createElement("strong");
    name.textContent = device.name;
    const description = document.createElement("small");
    description.textContent = `${device.type} | ${device.location || "No location"} | LAN: ${getKindCount(device, "LAN")} | WAN: ${getKindCount(device, "WAN")}`;
    const statuses = document.createElement("small");
    statuses.textContent = `Active: ${counts.active} | No link: ${counts["no-link"]} | Available: ${counts.available} | Unknown: ${counts["unknown-device"]}`;
    summary.append(name, description, statuses);
    summaryGrid.appendChild(summary);
  });
  overview.append(overviewLabel, overviewTitle, summaryGrid);
  report.appendChild(overview);

  devices.forEach((device) => {
    const section = document.createElement("section");
    section.className = "print-device";
    const deviceHeader = document.createElement("header");
    deviceHeader.className = "print-device-header";
    const deviceIdentity = document.createElement("div");
    const heading = document.createElement("h2");
    heading.textContent = device.name;
    const deviceMeta = document.createElement("p");
    deviceMeta.textContent = `${device.type} | ${device.location || "No location"} | LAN: ${getKindCount(device, "LAN")} | WAN: ${getKindCount(device, "WAN")}`;
    const detailsText = deviceDetailsText(device);
    if (detailsText) deviceMeta.textContent += ` | ${detailsText}`;
    const deviceTag = document.createElement("span");
    deviceTag.className = "print-device-tag";
    deviceTag.textContent = device.type;
    deviceIdentity.append(heading, deviceMeta);
    deviceHeader.append(deviceIdentity, deviceTag);

    const counts = getDeviceCounts(device);
    const countList = document.createElement("div");
    countList.className = "print-device-counts";
    Object.entries(STATUS_LABELS).forEach(([status, label]) => {
      const count = document.createElement("span");
      count.className = `print-count ${status}`;
      count.textContent = `${label} ${counts[status]}`;
      countList.appendChild(count);
    });

    const ports = document.createElement("div");
    ports.className = "print-ports";
    if (!device.ports.length) {
      const none = document.createElement("p");
      none.className = "print-port-details";
      none.textContent = "No network ports.";
      ports.appendChild(none);
    }
    device.ports.forEach((port) => {
      const status = normalizeStatus(port.status);
      const card = document.createElement("article");
      card.className = `print-port ${status}`;
      const number = document.createElement("span");
      number.className = "port-number";
      number.textContent = `${port.portKind} ${port.number}`;
      const statusText = document.createElement("span");
      statusText.className = "port-status";
      statusText.textContent = STATUS_LABELS[status];
      const type = document.createElement("strong");
      type.className = "port-label";
      type.textContent = port.connectionType || "No type";
      const destination = document.createElement("span");
      destination.className = "port-sublabel";
      destination.textContent = port.connectedTo || "No destination";
      const details = document.createElement("p");
      details.className = "print-port-details";
      details.textContent = `VLAN: ${port.vlan || "-"} | IP / MAC: ${port.address || "-"}${port.notes ? ` | Notes: ${port.notes}` : ""}`;
      card.append(number, statusText, type, destination, details);
      ports.appendChild(card);
    });
    section.append(deviceHeader, countList, ports);
    report.appendChild(section);
  });
}

function renderDeviceTypeField() {
  const select = document.querySelector("#deviceTypeSelect");
  const label = document.querySelector("#customDeviceTypeLabel");
  const input = document.querySelector("#customDeviceTypeInput");
  const custom = select.value === "Other";
  label.classList.toggle("visible", custom);
  input.required = custom;
  input.disabled = !custom;
}

function render() {
  if (viewProjectId !== activeProjectId) {
    clearPortFilters();
    selectedConnectionId = null;
    alertLimit = 20;
    connectionLimit = 20;
    document.querySelector("#networkAlertFilter").value = "all";
    document.querySelector("#topologyScope").value = "all";
    viewProjectId = activeProjectId;
  }
  networkModel = buildNetworkModel({ ...project, devices });
  // Errors first, then device warnings (few and important), then
  // per-port warnings, so nothing important is buried. The sort is stable.
  const issueRank = (issue) =>
    issue.severity === "error" ? 0 : issue.endpoints.length ? 2 : 1;
  networkIssues = analyzeNetwork({ ...project, devices }, networkModel).sort(
    (first, second) => issueRank(first) - issueRank(second),
  );
  if (bulkDeviceId !== (currentDevice()?.id || null)) {
    bulkSelection.clear();
    bulkAnchorId = null;
    bulkDeviceId = currentDevice()?.id || null;
  }
  const portIds = new Set(currentDevice()?.ports.map((port) => port.id) || []);
  for (const id of bulkSelection)
    if (!portIds.has(id)) bulkSelection.delete(id);
  if (
    !networkModel.links.some(
      (link) => link.connection.id === selectedConnectionId,
    )
  )
    selectedConnectionId = null;
  const validDraftKeys = new Set(
    devices.flatMap((device) =>
      device.ports.map((port) => portDraftKey(device.id, port.id)),
    ),
  );
  for (const key of portDrafts.keys()) {
    if (!validDraftKeys.has(key)) portDrafts.delete(key);
  }
  renderProjectMeta();
  renderDevices();
  renderHeader();
  renderPorts();
  renderPortForm();
  renderProjectDevicesSummary();
  renderNetworkAlerts();
  renderConnectionMap();
  renderRackView();
  renderBulkTools();
  renderPrintReport();
  document.querySelector("#currentYear").textContent = new Date().getFullYear();
  renderDeviceTypeField();
}

function safeFileName(value) {
  return (
    String(value || "vnetcore-project")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "vnetcore-project"
  );
}

function downloadTextFile(filename, content, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportJson(sourceProject = project, suffix = "") {
  const normalized = normalizeProject({
    ...sourceProject,
    devices: sourceProject.devices || devices,
  });
  const filename = `${safeFileName(normalized.projectName)}${suffix}.json`;
  downloadTextFile(
    filename,
    JSON.stringify(normalized, null, 2),
    "application/json;charset=utf-8",
  );
  recordBackupExport();
  showNotification(`Exported ${filename}`, { title: "Backup exported" });
}

function exportCsv() {
  const filename = `${safeFileName(project.projectName)}.csv`;
  downloadTextFile(
    filename,
    projectToCsv({ ...project, devices }),
    "text/csv;charset=utf-8",
  );
  recordBackupExport();
  showNotification(`Exported ${filename}`, { title: "Backup exported" });
}

// A small, valid project used for the downloadable import templates. It goes
// through strict validation, so the templates always import cleanly.
function templateProject() {
  return normalizeProject(
    {
      projectName: "Example office",
      owner: "Network team",
      reviewDate: "2026-12-31",
      devices: [
        {
          id: "fw1",
          name: "Edge firewall",
          type: "Firewall",
          location: "Main rack",
          manufacturer: "Fortinet",
          serialNumber: "FGT60F0000000001",
          macAddress: "00:09:0F:00:00:01",
          managementIp: "192.168.1.1",
          firmware: "FortiOS 7.4",
          rack: "Rack A",
          rackUnit: 42,
          rackHeight: 1,
          notes: "Support contract until 2027.",
          ports: [
            {
              id: "fw1-wan1",
              portKind: "WAN",
              number: 1,
              status: "active",
              connectionType: "ISP",
              connectedTo: "Internet provider",
              vlan: "WAN",
            },
            {
              id: "fw1-lan1",
              portKind: "LAN",
              number: 1,
              status: "active",
              connectionType: "Uplink",
              connectedTo: "Core switch · LAN 1",
            },
            { id: "fw1-lan2", portKind: "LAN", number: 2, status: "available" },
          ],
        },
        {
          id: "sw1",
          name: "Core switch",
          type: "Switch",
          location: "Main rack",
          rack: "Rack A",
          rackUnit: 40,
          rackHeight: 1,
          ports: [
            {
              id: "sw1-lan1",
              portKind: "LAN",
              number: 1,
              status: "active",
              connectionType: "Uplink",
              connectedTo: "Edge firewall · LAN 1",
              vlan: "1 / Native",
            },
            {
              id: "sw1-lan2",
              portKind: "LAN",
              number: 2,
              status: "active",
              connectionType: "AP",
              connectedTo: "AP Lobby",
              vlan: "10 / Staff",
              address: "192.168.10.20",
            },
            { id: "sw1-lan3", portKind: "LAN", number: 3, status: "available" },
          ],
        },
      ],
      connections: [
        {
          id: "link-1",
          firstDeviceId: "fw1",
          firstPortId: "fw1-lan1",
          secondDeviceId: "sw1",
          secondPortId: "sw1-lan1",
        },
      ],
    },
    { strict: true },
  );
}

function parseImportContent(mode, content) {
  if (mode === "csv") return csvToProject(content);
  const parsed = JSON.parse(content);
  return normalizeProject(parsed, { strict: true });
}

function reviewImport(candidate) {
  pendingImport = candidate;
  const portCount = candidate.devices.reduce(
    (total, device) => total + device.ports.length,
    0,
  );
  document.querySelector("#importSummary").textContent =
    `Project "${candidate.projectName}" contains ${candidate.devices.length} devices and ${portCount} ports.`;
  document.querySelector("#importDialog").showModal();
}

function applyPendingImport() {
  if (!pendingImport) return;
  const previous = snapshot();
  project = pendingImport;
  devices = project.devices;
  selectedDeviceId = devices[0]?.id || null;
  selectedPortId = null;
  pendingImport = null;
  portDrafts.clear();
  cancelDeviceEdit();
  commitChange(previous, "Imported project");
}

function openImportPicker(mode) {
  importMode = mode;
  const input = document.querySelector("#fileImportInput");
  input.value = "";
  input.accept = mode === "json" ? ".json,application/json" : ".csv,text/csv";
  input.click();
}

function closeMenus(options = {}) {
  let focusTarget = options.restoreFocus;
  document.querySelectorAll(".menu.open").forEach((menu) => {
    if (menu.querySelector(".menu-options").contains(document.activeElement)) {
      focusTarget ||= menu.querySelector(".menu-btn");
    }
    menu.classList.remove("open");
    menu.querySelector(".menu-btn").setAttribute("aria-expanded", "false");
    menu.querySelector(".menu-options").hidden = true;
  });
  focusTarget?.focus();
}

function beginDeviceEdit() {
  const device = currentDevice();
  if (!device) return;
  editingDeviceId = device.id;
  setSidebarExpanded(true);
  document.querySelector(".add-device-card").open = true;
  document.querySelector("#deviceFormTitle").textContent = "Edit device";
  const form = document.querySelector("#deviceForm");
  form.elements.model.value = device.name;
  const knownTypes = Array.from(form.elements.type.options).map(
    (option) => option.value,
  );
  const isKnown = knownTypes.includes(device.type) && device.type !== "Other";
  form.elements.type.value = isKnown ? device.type : "Other";
  form.elements.customType.value = isKnown ? "" : device.type;
  form.elements.location.value = device.location;
  form.elements.portLayout.value = device.portLayout;
  form.elements.wanPorts.value = getKindCount(device, "WAN");
  form.elements.lanPorts.value = getKindCount(device, "LAN");
  Object.entries(DEVICE_FORM_DETAILS).forEach(([name, field]) => {
    form.elements[name].value = device[field] || "";
  });
  form.elements.rackUnit.value = device.rackUnit ?? "";
  form.elements.rackHeight.value =
    device.rackHeight > 1 ? String(device.rackHeight) : "";
  document.querySelector(".device-details-fields").open =
    Object.values(DEVICE_FORM_DETAILS).some((field) => device[field]) ||
    Boolean(device.rackUnit);
  document.querySelector("#deviceSubmitBtn").textContent = "Save device";
  document.querySelector("#cancelDeviceEditBtn").classList.add("visible");
  renderDeviceTypeField();
  form.elements.model.focus();
}

function cancelDeviceEdit() {
  editingDeviceId = null;
  document.querySelector("#deviceFormTitle").textContent = "Add device";
  const form = document.querySelector("#deviceForm");
  form.reset();
  document.querySelector(".device-details-fields").open = false;
  document.querySelector("#deviceSubmitBtn").textContent = "Add device";
  document.querySelector("#cancelDeviceEditBtn").classList.remove("visible");
  renderDeviceTypeField();
  renderPorts();
}

function duplicateCurrentDevice() {
  const device = currentDevice();
  if (!device) return;
  const previous = snapshot();
  const copy = cloneProject({ projectName: "copy", devices: [device] })
    .devices[0];
  copy.id = createId();
  copy.name = `${device.name} copy`.slice(0, LIMITS.deviceName);
  UNIQUE_DEVICE_DETAILS.forEach((field) => {
    copy[field] = "";
  });
  copy.rackUnit = null;
  copy.ports.forEach((port) => {
    port.id = createId();
  });
  const index = devices.findIndex((item) => item.id === device.id);
  devices.splice(index + 1, 0, copy);
  selectedDeviceId = copy.id;
  selectedPortId = null;
  commitChange(previous, `Duplicated ${device.name}`);
}

function moveCurrentDevice(offset) {
  const device = currentDevice();
  const index = devices.findIndex((item) => item.id === device?.id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= devices.length) return;
  const previous = snapshot();
  [devices[index], devices[target]] = [devices[target], devices[index]];
  commitChange(previous, `Moved ${device.name}`);
}

document
  .querySelector("#projectNameInput")
  .addEventListener("input", (event) => {
    project.projectName = event.target.value.slice(0, LIMITS.projectName);
    document.querySelector("#projectDisplayName").textContent =
      project.projectName || "Unnamed project";
    renderPrintReport();
    scheduleSave();
  });
document
  .querySelector("#projectNameInput")
  .addEventListener("blur", (event) => {
    if (!event.target.value.trim()) project.projectName = "Unnamed project";
    else project.projectName = event.target.value.trim();
    renderProjectMeta();
    saveProject();
  });
document
  .querySelector("#projectOwnerInput")
  .addEventListener("input", (event) => {
    project.owner = event.target.value.slice(0, LIMITS.owner);
    renderPrintReport();
    scheduleSave();
  });
document
  .querySelector("#projectReviewDateInput")
  .addEventListener("change", (event) => {
    project.reviewDate = event.target.value;
    renderPrintReport();
    saveProject();
  });
document.querySelector("#projectSelect").addEventListener("change", (event) => {
  activateProject(event.target.value);
});
document
  .querySelector("#duplicateProjectBtn")
  .addEventListener("click", duplicateCurrentProject);
document
  .querySelector("#deleteProjectBtn")
  .addEventListener("click", deleteCurrentProject);
document.querySelector("#deviceSearchInput").addEventListener("input", () => {
  renderDevices();
  renderProjectDevicesSummary();
});
document.querySelectorAll("[data-port-status]").forEach((button) => {
  button.addEventListener("click", () => {
    portFilterStatus = button.dataset.portStatus;
    renderPorts();
  });
});
document.querySelector("#portVlanFilter").addEventListener("input", (event) => {
  portFilterVlan = event.target.value.trim();
  renderPorts();
});
document.querySelector("#resetPortFiltersBtn").addEventListener("click", () => {
  clearPortFilters();
  renderPorts();
  document.querySelector('[data-port-status="all"]').focus();
});
document.querySelector("#networkAlertFilter").addEventListener("change", () => {
  alertLimit = 20;
  renderNetworkAlerts();
});
document.querySelector("#showMoreAlertsBtn").addEventListener("click", () => {
  const previousCount =
    document.querySelector("#networkAlertsList").children.length;
  alertLimit += 20;
  renderNetworkAlerts();
  const next =
    document.querySelector("#networkAlertsList").children[previousCount];
  if (next) {
    next.tabIndex = -1;
    next.focus();
  }
});
document.querySelector("#topologyScope").addEventListener("change", () => {
  connectionLimit = 20;
  renderConnectionMap();
});
document
  .querySelector("#showMoreConnectionsBtn")
  .addEventListener("click", () => {
    const previousCount = document.querySelector("#topologyConnectionList")
      .children.length;
    connectionLimit += 20;
    renderConnectionMap();
    document
      .querySelector("#topologyConnectionList")
      .children[previousCount]?.querySelector("button")
      ?.focus();
  });
document
  .querySelector("#deviceTypeSelect")
  .addEventListener("change", renderDeviceTypeField);
document
  .querySelector("#devicePortLayoutSelect")
  .addEventListener("change", () => {
    const device = currentDevice();
    if (device && editingDeviceId === device.id) renderPorts();
  });

document.querySelector("#deviceForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const wanCount = Number(data.wanPorts);
  const lanCount = Number(data.lanPorts);
  if (
    !Number.isInteger(wanCount) ||
    !Number.isInteger(lanCount) ||
    wanCount < 0 ||
    lanCount < 0 ||
    wanCount > 16 ||
    lanCount > 96
  ) {
    showNotification("Use whole port counts within the allowed ranges.", {
      type: "warning",
    });
    return;
  }
  const finalType = data.type === "Other" ? data.customType.trim() : data.type;
  if (!finalType) {
    showNotification("Specify the device type.", { type: "warning" });
    return;
  }
  const details = Object.fromEntries(
    Object.entries(DEVICE_FORM_DETAILS).map(([name, field]) => [
      field,
      String(data[name] || "")
        .trim()
        .slice(0, DEVICE_DETAIL_LIMITS[field]),
    ]),
  );
  const rackUnit = data.rackUnit === "" ? null : Number(data.rackUnit);
  const rackHeight = data.rackHeight === "" ? 1 : Number(data.rackHeight);
  if (
    (rackUnit !== null &&
      (!Number.isInteger(rackUnit) ||
        rackUnit < 1 ||
        rackUnit > RACK_LIMITS.units)) ||
    !Number.isInteger(rackHeight) ||
    rackHeight < 1 ||
    rackHeight > RACK_LIMITS.height
  ) {
    showNotification(
      `Rack position must be 1–${RACK_LIMITS.units} and height 1–${RACK_LIMITS.height}.`,
      { type: "warning", title: "Check the rack position" },
    );
    return;
  }
  const rackSize = project.rackUnits || DEFAULT_RACK_UNITS;
  if (rackUnit !== null && rackUnit + rackHeight - 1 > rackSize) {
    showNotification(
      `A device at U${rackUnit} with a height of ${rackHeight}U does not fit in a ${rackSize}U rack. Choose a lower position or a larger rack size in Project information.`,
      { type: "warning", title: "Check the rack position" },
    );
    return;
  }
  if (rackUnit !== null && !details.rack) {
    showNotification("Add a rack name to place the device at a position.", {
      type: "warning",
      title: "Rack name missing",
    });
    return;
  }
  Object.assign(details, { rackUnit, rackHeight });
  const previous = snapshot();
  if (editingDeviceId) {
    const device = devices.find((item) => item.id === editingDeviceId);
    if (!device) return cancelDeviceEdit();
    const previousName = device.name;
    Object.assign(device, details);
    device.name = data.model.trim().slice(0, LIMITS.deviceName);
    device.type = finalType.slice(0, LIMITS.deviceType);
    device.location = data.location.trim().slice(0, LIMITS.location);
    device.portLayout = data.portLayout === "split" ? "split" : "alternating";
    device.ports = [
      ...makePorts("WAN", wanCount, device.ports),
      ...makePorts("LAN", lanCount, device.ports),
    ];
    dropLinksToRemovedPorts(previous.project.devices);
    if (device.name !== previousName) refreshPeerLabels(device, previousName);
    if (!device.ports.some((port) => port.id === selectedPortId))
      selectedPortId = null;
    const message = `Updated ${device.name}`;
    cancelDeviceEdit();
    commitChange(previous, message);
  } else {
    const device = {
      id: createId(),
      name: data.model.trim().slice(0, LIMITS.deviceName),
      type: finalType.slice(0, LIMITS.deviceType),
      location: data.location.trim().slice(0, LIMITS.location),
      portLayout: data.portLayout === "split" ? "split" : "alternating",
      ...details,
      ports: [...makePorts("WAN", wanCount), ...makePorts("LAN", lanCount)],
    };
    devices.push(device);
    selectedDeviceId = device.id;
    selectedPortId = null;
    cancelDeviceEdit();
    commitChange(previous, `Added ${device.name}`);
  }
});

document
  .querySelector("#portForm")
  .addEventListener("input", rememberPortDraft);
document
  .querySelector("#portForm")
  .addEventListener("change", rememberPortDraft);
document
  .querySelector("#openLinkedPortBtn")
  .addEventListener("click", openLinkedPort);
document
  .querySelector("#clearPortBtn")
  .addEventListener("click", clearCurrentPort);
document.querySelector("#backToPortsBtn").addEventListener("click", () => {
  const grid = document.querySelector("#portGrid");
  const selected = grid.querySelector(".port.is-selected");
  grid
    .closest(".ports-card")
    .scrollIntoView({ block: "start", behavior: scrollBehavior() });
  (selected || grid).focus({ preventScroll: true });
});
document
  .querySelector("#movePortSelect")
  .addEventListener("change", (event) => {
    document.querySelector("#movePortBtn").disabled = !event.target.value;
  });
document.querySelector("#movePortBtn").addEventListener("click", () => {
  const port = currentPort();
  const target = document.querySelector("#movePortSelect").value;
  if (!port || !target) return;
  if (moveCurrentPortData(port.id, target)) {
    document.querySelector("#portForm").elements.status.focus({
      preventScroll: true,
    });
  }
});
document.querySelector("#importGuideBtn").addEventListener("click", () => {
  closeMenus();
  document.querySelector("#importGuideDialog").showModal();
});
document
  .querySelector("#downloadJsonTemplateBtn")
  .addEventListener("click", () => {
    downloadTextFile(
      "vnetcore-template.json",
      JSON.stringify(templateProject(), null, 2),
      "application/json;charset=utf-8",
    );
  });
document
  .querySelector("#downloadCsvTemplateBtn")
  .addEventListener("click", () => {
    downloadTextFile(
      "vnetcore-template.csv",
      projectToCsv(templateProject()),
      "text/csv;charset=utf-8",
    );
  });
document.querySelector("#discardPortDraftBtn").addEventListener("click", () => {
  const port = currentPort();
  if (!port) return;
  portDrafts.delete(portDraftKey(currentDevice().id, port.id));
  renderPorts();
  renderPortForm();
  document.querySelector("#portForm").elements.status.focus();
});

document.querySelector("#portForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const port = currentPort();
  if (!port) return;
  const previous = snapshot();
  const data = Object.fromEntries(new FormData(event.target).entries());
  port.status = normalizeStatus(data.status);
  port.connectionType = data.connectionType.trim().slice(0, LIMITS.shortField);
  const manualConnectedTo = data.connectedTo.trim().slice(0, LIMITS.shortField);
  setPortConnection(port, data.connectedPort);
  if (!data.connectedPort) port.connectedTo = manualConnectedTo;
  port.vlan = data.vlan.trim().slice(0, 80);
  port.address = data.address.trim().slice(0, LIMITS.shortField);
  port.notes = data.notes.trim().slice(0, LIMITS.notes);
  portDrafts.delete(portDraftKey(currentDevice().id, port.id));
  commitChange(previous, `Updated ${port.portKind} port ${port.number}`);
});

document
  .querySelector("#clearAllBtn")
  .addEventListener("click", clearAllDevices);
document
  .querySelector("#newBlankProjectBtn")
  .addEventListener("click", startBlankProject);
document
  .querySelector("#editDeviceBtn")
  .addEventListener("click", beginDeviceEdit);
document
  .querySelector("#duplicateDeviceBtn")
  .addEventListener("click", duplicateCurrentDevice);
document
  .querySelector("#moveDeviceUpBtn")
  .addEventListener("click", () => moveCurrentDevice(-1));
document
  .querySelector("#moveDeviceDownBtn")
  .addEventListener("click", () => moveCurrentDevice(1));
document
  .querySelector("#cancelDeviceEditBtn")
  .addEventListener("click", cancelDeviceEdit);
document.querySelector("#undoBtn").addEventListener("click", undoLastChange);
document.querySelector("#downloadRecoveryBtn").addEventListener("click", () => {
  if (loadFailure?.raw) {
    downloadTextFile(
      "vnetcore-recovery-raw.txt",
      loadFailure.raw,
      "text/plain;charset=utf-8",
    );
  } else {
    exportJson({ ...project, devices }, "-recovery");
  }
});
document
  .querySelector("#restoreBackupBtn")
  .addEventListener("click", async () => {
    const backup = readBackupProject();
    if (!backup) {
      showNotification("No valid local backup is available.", {
        type: "warning",
      });
      return;
    }
    const confirmed = await requestConfirmation(
      "Restore the local backup?",
      `"${backup.projectName}" replaces the active project. If you need the unreadable data, download the recovery copy first.`,
      "Restore backup",
      { destructive: true },
    );
    if (!confirmed) return;
    project = backup;
    devices = project.devices;
    selectedDeviceId = devices[0]?.id || null;
    selectedPortId = null;
    loadFailure = null;
    portDrafts.clear();
    cancelDeviceEdit();
    const saved = saveProject({ keepBackup: false });
    render();
    if (saved) showNotification("Local backup restored.");
  });

document.querySelector("#exportJsonBtn").addEventListener("click", () => {
  closeMenus();
  exportJson();
});
document
  .querySelector("#backupNoticeExportBtn")
  .addEventListener("click", () => {
    exportJson();
  });
document
  .querySelector("#backupNoticeDismissBtn")
  .addEventListener("click", () => {
    const level = document.querySelector("#backupNotice").dataset.level;
    showBackupIntroduction = false;
    if (level !== "info") {
      backupNoticeState.dismissedLevel = level;
      backupNoticeState.dismissedAt = Date.now();
      saveBackupNoticeState();
    }
    hideBackupNotice();
  });
document.querySelector("#exportCsvBtn").addEventListener("click", () => {
  closeMenus();
  exportCsv();
});
document.querySelector("#importJsonBtn").addEventListener("click", () => {
  closeMenus();
  openImportPicker("json");
});
document.querySelector("#importCsvBtn").addEventListener("click", () => {
  closeMenus();
  openImportPicker("csv");
});
/* ------------------------------------------------------------------------
   Review date: the day the project was last reviewed. It is a record only,
   shown on the project card; it never raises alerts.
   ------------------------------------------------------------------------ */
const REVIEW_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function renderReviewStatus() {
  const element = document.querySelector("#projectReviewStatus");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(project.reviewDate || "");
  element.hidden = !match;
  if (!match) return;
  const date = new Date(+match[1], +match[2] - 1, +match[3]);
  const text = `Reviewed on ${REVIEW_DATE_FORMAT.format(date)}`;
  if (element.textContent !== text) element.textContent = text;
}

function openDevice(deviceId) {
  if (!devices.some((device) => device.id === deviceId)) return;
  selectedDeviceId = deviceId;
  selectedPortId = null;
  render();
  document
    .querySelector(".device-header")
    .scrollIntoView({ block: "start", behavior: scrollBehavior() });
  document.querySelector("#editDeviceBtn").focus({ preventScroll: true });
}

/* ------------------------------------------------------------------------
   Bulk edit: select several ports of the selected device and change them
   together. Shift+click (or Shift+Enter) selects a range.
   ------------------------------------------------------------------------ */
function renderBulkTools() {
  const toggle = document.querySelector("#bulkModeBtn");
  const count = bulkSelection.size;
  toggle.setAttribute("aria-pressed", String(bulkMode));
  toggle.textContent = bulkMode ? "Done selecting" : "Select multiple ports";
  toggle.disabled = !currentDevice()?.ports.length;
  document.querySelector("#bulkTools").hidden = !bulkMode;
  document
    .querySelector(".ports-card")
    .classList.toggle("is-bulk-mode", bulkMode);
  const countText = `${plural(count, "port")} selected`;
  const countElement = document.querySelector("#bulkCount");
  if (countElement.textContent !== countText)
    countElement.textContent = countText;
  const apply = document.querySelector("#bulkApplyBtn");
  apply.disabled = count === 0;
  apply.textContent = count
    ? `Apply to ${plural(count, "port")}`
    : "Apply to selected";
  document.querySelector("#bulkClearSelectionBtn").disabled = count === 0;
}

function setBulkMode(enabled) {
  bulkMode = enabled;
  bulkSelection.clear();
  bulkAnchorId = null;
  bulkDeviceId = currentDevice()?.id || null;
  renderPorts();
  renderBulkTools();
}

function shownPortIds() {
  return Array.from(document.querySelectorAll("#portGrid .port")).map(
    (button) => button.dataset.portId,
  );
}

function toggleBulkPort(portId, extendRange) {
  bulkDeviceId = currentDevice()?.id || null;
  const shown = shownPortIds();
  if (extendRange && bulkAnchorId && shown.includes(bulkAnchorId)) {
    const [from, to] = [
      shown.indexOf(bulkAnchorId),
      shown.indexOf(portId),
    ].sort((a, b) => a - b);
    shown.slice(from, to + 1).forEach((id) => bulkSelection.add(id));
  } else {
    if (bulkSelection.has(portId)) bulkSelection.delete(portId);
    else bulkSelection.add(portId);
    bulkAnchorId = portId;
  }
  renderPorts();
  renderBulkTools();
}

function selectedBulkPorts() {
  const device = currentDevice();
  return device
    ? device.ports
        .filter((port) => bulkSelection.has(port.id))
        .sort((first, second) =>
          first.portKind === second.portKind
            ? first.number - second.number
            : first.portKind === "WAN"
              ? -1
              : 1,
        )
    : [];
}

function applyBulkEdit() {
  const device = currentDevice();
  const ports = selectedBulkPorts();
  if (!device || !ports.length) return;
  const status = document.querySelector("#bulkStatus").value;
  const vlan = document.querySelector("#bulkVlan").value.trim();
  const type = document.querySelector("#bulkType").value.trim();
  if (!status && !vlan && !type) {
    showNotification("Choose a status, VLAN or type to apply.", {
      type: "warning",
      title: "Nothing to change",
    });
    return;
  }
  if (ports.some((port) => portDrafts.has(portDraftKey(device.id, port.id)))) {
    showNotification(
      "Save or discard the unsaved changes on the selected ports first.",
      { type: "warning", title: "Ports not updated" },
    );
    return;
  }
  const previous = snapshot();
  ports.forEach((port) => {
    if (status) port.status = normalizeStatus(status);
    if (vlan) port.vlan = vlan.slice(0, 80);
    if (type) port.connectionType = type.slice(0, LIMITS.shortField);
  });
  document.querySelector("#bulkStatus").value = "";
  document.querySelector("#bulkVlan").value = "";
  document.querySelector("#bulkType").value = "";
  commitChange(previous, `Updated ${plural(ports.length, "port")}`);
  renderBulkTools();
}

/* ------------------------------------------------------------------------
   Rack view: an elevation per rack, built from each device's rack name,
   lowest unit and height.
   ------------------------------------------------------------------------ */
function unitRange(device) {
  const top = device.rackUnit + (device.rackHeight || 1) - 1;
  return top === device.rackUnit
    ? `U${device.rackUnit}`
    : `U${device.rackUnit}–U${top}`;
}

function rackPlacementText(device) {
  return [device.rack, device.rackUnit ? unitRange(device) : ""]
    .filter(Boolean)
    .join(" · ");
}

function rackKind(device) {
  const type = String(device.type || "").toLowerCase();
  if (type.includes("patch")) return "patch";
  if (type.includes("switch")) return "switch";
  if (type.includes("firewall") || type.includes("router")) return "firewall";
  return "generic";
}

function sortedPorts(device) {
  return [...device.ports].sort((first, second) =>
    first.portKind === second.portKind
      ? first.number - second.number
      : first.portKind === "WAN"
        ? -1
        : 1,
  );
}

// Decorative front panel. Jacks take the documented status of each port, so
// the drawing reflects the real state of the device.
function createRackFace(device, height) {
  const kind = rackKind(device);
  const face = document.createElement("span");
  face.className = "rack-face";
  face.setAttribute("aria-hidden", "true");
  const ports = sortedPorts(device).slice(0, 52);
  if (kind === "generic") {
    const vents = document.createElement("span");
    vents.className = "rack-vents";
    const display = document.createElement("span");
    display.className = "rack-display";
    face.append(vents, display);
  } else {
    const bank = document.createElement("span");
    bank.className = "rack-jacks";
    const perRow =
      kind === "firewall"
        ? ports.length
        : ports.length > (kind === "patch" ? 24 : 12)
          ? Math.ceil(ports.length / 2)
          : ports.length;
    bank.style.setProperty("--jacks-per-row", String(Math.max(1, perRow)));
    // Switches number ports in columns (1 over 2, 3 over 4); panels in rows.
    bank.style.setProperty(
      "--jack-rows",
      String(Math.max(1, Math.ceil(ports.length / Math.max(1, perRow)))),
    );
    ports.forEach((port) => {
      const jack = document.createElement("i");
      jack.className = `rack-jack ${normalizeStatus(port.status)}${port.portKind === "WAN" ? " is-wan" : ""}`;
      bank.appendChild(jack);
    });
    face.appendChild(bank);
  }
  const leds = document.createElement("span");
  leds.className = "rack-leds";
  const counts = getDeviceCounts(device);
  [
    "power",
    counts["unknown-device"] ? "fault" : counts.active ? "link" : "idle",
  ].forEach((state) => {
    const led = document.createElement("i");
    led.className = state;
    leds.appendChild(led);
  });
  face.appendChild(leds);
  face.dataset.height = String(height);
  return face;
}

function createRackEar(height) {
  const ear = document.createElement("span");
  ear.className = "rack-ear";
  ear.setAttribute("aria-hidden", "true");
  for (let index = 0; index < height; index++) {
    ear.appendChild(document.createElement("i"));
  }
  return ear;
}

function rackOccupancy(rackName, ignoreId) {
  const key = rackName.trim().toLowerCase();
  return devices.filter(
    (device) =>
      device.id !== ignoreId &&
      device.rackUnit &&
      String(device.rack || "")
        .trim()
        .toLowerCase() === key,
  );
}

function fitsInRack(rackName, lowest, height, ignoreId, units) {
  if (lowest < 1 || lowest + height - 1 > Math.min(units, RACK_LIMITS.units)) {
    return false;
  }
  const top = lowest + height - 1;
  return rackOccupancy(rackName, ignoreId).every((other) => {
    const otherTop = other.rackUnit + (other.rackHeight || 1) - 1;
    return top < other.rackUnit || lowest > otherTop;
  });
}

function placeDeviceInRack(deviceId, rackName, lowest) {
  const device = devices.find((item) => item.id === deviceId);
  if (!device) return;
  if (device.rack === rackName && device.rackUnit === lowest) return;
  const previous = snapshot();
  device.rack = rackName;
  device.rackUnit = lowest;
  device.rackHeight ||= 1;
  commitChange(
    previous,
    `Moved ${device.name} to ${rackName} ${unitRange(device)}`,
  );
}

// Keyboard alternative to dragging: Up/Down moves to the next free position.
function nudgeRackDevice(device, direction, units) {
  const height = device.rackHeight || 1;
  for (
    let lowest = device.rackUnit + direction;
    lowest >= 1 && lowest + height - 1 <= units;
    lowest += direction
  ) {
    if (fitsInRack(device.rack, lowest, height, device.id, units)) {
      placeDeviceInRack(device.id, device.rack, lowest);
      return;
    }
  }
  showNotification(
    `There is no free space ${direction > 0 ? "above" : "below"} ${device.name} in ${device.rack}.`,
    { type: "info", title: "Device not moved" },
  );
}

function startRackDrag(event, device) {
  rackDrag = { deviceId: device.id, height: device.rackHeight || 1 };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", device.name);
  event.currentTarget.classList.add("is-dragging");
  document.querySelector("#rackView").classList.add("is-dragging");
}

function endRackDrag(event) {
  rackDrag = null;
  event?.currentTarget?.classList?.remove("is-dragging");
  document.querySelector("#rackView").classList.remove("is-dragging");
  document
    .querySelectorAll(".rack-drop-preview")
    .forEach((preview) => (preview.hidden = true));
}

// drawnUnits: units shown (may exceed the rack size to reveal misplaced
// devices); rackSize: the project rack size that drops must fit within.
function attachRackDropZone(slots, rackName, drawnUnits, rackSize) {
  const preview = document.createElement("span");
  preview.className = "rack-drop-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.hidden = true;
  slots.appendChild(preview);
  const target = (event) => {
    const rect = slots.getBoundingClientRect();
    const row = Math.floor(
      ((event.clientY - rect.top) / rect.height) * drawnUnits,
    );
    const height = rackDrag.height;
    // The pointer marks the top unit of the device being dropped.
    const top = Math.min(drawnUnits, Math.max(height, drawnUnits - row));
    return top - height + 1;
  };
  slots.addEventListener("dragover", (event) => {
    if (!rackDrag) return;
    const lowest = target(event);
    const valid = fitsInRack(
      rackName,
      lowest,
      rackDrag.height,
      rackDrag.deviceId,
      rackSize,
    );
    preview.hidden = false;
    preview.classList.toggle("is-invalid", !valid);
    preview.style.gridRow = `${drawnUnits - (lowest + rackDrag.height - 1) + 1} / span ${rackDrag.height}`;
    preview.textContent =
      rackDrag.height === 1
        ? `U${lowest}`
        : `U${lowest}–U${lowest + rackDrag.height - 1}`;
    if (valid) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  });
  slots.addEventListener("dragleave", (event) => {
    if (!slots.contains(event.relatedTarget)) preview.hidden = true;
  });
  slots.addEventListener("drop", (event) => {
    if (!rackDrag) return;
    const lowest = target(event);
    if (
      !fitsInRack(
        rackName,
        lowest,
        rackDrag.height,
        rackDrag.deviceId,
        rackSize,
      )
    ) {
      return;
    }
    event.preventDefault();
    const { deviceId } = rackDrag;
    endRackDrag();
    placeDeviceInRack(deviceId, rackName, lowest);
    Array.from(document.querySelectorAll("#rackView .rack-device"))
      .find((button) => button.dataset.deviceId === deviceId)
      ?.focus({ preventScroll: true });
  });
}

function renderRackView() {
  const view = document.querySelector("#rackView");
  const unplacedBox = document.querySelector("#rackUnplaced");
  const focusKey = captureListFocus(view.closest(".rack-card"));
  const racks = new Map();
  const unplaced = [];
  devices.forEach((device) => {
    const name = String(device.rack || "").trim();
    if (!name || !device.rackUnit) {
      unplaced.push(device);
      return;
    }
    const key = name.toLowerCase();
    if (!racks.has(key)) racks.set(key, { name, devices: [] });
    racks.get(key).devices.push(device);
  });
  const conflicts = new Set(
    networkIssues
      .filter((issue) => issue.code === "rack-overlap")
      .flatMap((issue) => issue.devices || []),
  );
  const placedCount = devices.length - unplaced.length;
  document.querySelector("#rackSummary").textContent = devices.length
    ? `${placedCount} of ${plural(devices.length, "device")} placed in ${plural(racks.size, "rack")}.`
    : "Add devices to plan their rack positions.";
  view.replaceChildren();
  if (!racks.size && devices.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent =
      "No device has a rack position yet. Drag a device from the list below onto a rack, or edit a device and set Rack and Position (U).";
    view.appendChild(empty);
  }
  [...racks.values()]
    .sort((first, second) =>
      first.name.localeCompare(second.name, undefined, { numeric: true }),
    )
    .forEach(({ name, devices: placed }) => {
      const tops = placed.map(
        (device) => device.rackUnit + (device.rackHeight || 1) - 1,
      );
      const rackSize = project.rackUnits || DEFAULT_RACK_UNITS;
      const units = Math.max(rackSize, ...tops);
      const used = new Set();
      placed.forEach((device) => {
        for (
          let unit = device.rackUnit;
          unit < device.rackUnit + (device.rackHeight || 1);
          unit++
        ) {
          used.add(unit);
        }
      });
      const rack = document.createElement("section");
      rack.className = "rack";
      rack.setAttribute("aria-label", `Rack ${name}, ${rackSize} units`);
      const header = document.createElement("header");
      header.className = "rack-header";
      const title = document.createElement("h3");
      title.textContent = name;
      const usage = document.createElement("small");
      const above = placed.filter(
        (device) => device.rackUnit + (device.rackHeight || 1) - 1 > rackSize,
      ).length;
      const usedInside = [...used].filter((unit) => unit <= rackSize).length;
      usage.textContent = `${usedInside} of ${rackSize}U used${above ? ` · ${plural(above, "device")} above ${rackSize}U` : ""}`;
      usage.classList.toggle("is-warning", above > 0);
      header.append(title, usage);

      const cabinet = document.createElement("div");
      cabinet.className = "rack-cabinet";
      const frame = document.createElement("div");
      frame.className = "rack-frame";
      frame.style.setProperty("--rack-units", String(units));
      const scale = document.createElement("div");
      scale.className = "rack-rail rack-scale";
      scale.setAttribute("aria-hidden", "true");
      for (let unit = units; unit >= 1; unit--) {
        const mark = document.createElement("span");
        mark.textContent = String(unit);
        scale.appendChild(mark);
      }
      const slots = document.createElement("div");
      slots.className = "rack-slots";
      const rightRail = document.createElement("div");
      rightRail.className = "rack-rail";
      rightRail.setAttribute("aria-hidden", "true");
      // Top of the rack first, which is also the reading order.
      [...placed]
        .sort((first, second) => second.rackUnit - first.rackUnit)
        .forEach((device) => {
          const height = device.rackHeight || 1;
          const top = device.rackUnit + height - 1;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "rack-device";
          button.dataset.kind = rackKind(device);
          button.dataset.deviceId = device.id;
          button.draggable = true;
          button.classList.toggle(
            "is-selected",
            device.id === selectedDeviceId,
          );
          button.classList.toggle("is-conflict", conflicts.has(device.id));
          button.classList.toggle("is-compact", height === 1);
          button.dataset.focusKey = JSON.stringify(["rack-device", device.id]);
          button.setAttribute(
            "aria-pressed",
            String(device.id === selectedDeviceId),
          );
          button.setAttribute("aria-describedby", "rackHint");
          button.style.gridRow = `${units - top + 1} / span ${height}`;
          const tag = document.createElement("span");
          tag.className = "rack-tag";
          const label = document.createElement("strong");
          label.textContent = device.name;
          const meta = document.createElement("small");
          meta.textContent = `${unitRange(device)} · ${device.type}${conflicts.has(device.id) ? " · overlaps" : ""}`;
          tag.append(label, meta);
          const face = createRackFace(device, height);
          face.prepend(tag);
          button.append(createRackEar(height), face, createRackEar(height));
          button.title = `${device.name} · ${unitRange(device)}`;
          button.addEventListener("click", () => openDevice(device.id));
          button.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            nudgeRackDevice(device, event.key === "ArrowUp" ? 1 : -1, rackSize);
          });
          button.addEventListener("dragstart", (event) =>
            startRackDrag(event, device),
          );
          button.addEventListener("dragend", endRackDrag);
          slots.appendChild(button);
        });
      if (units > rackSize) {
        // Units above the chosen size exist only because a device sits there.
        const overflow = document.createElement("span");
        overflow.className = "rack-overflow-zone";
        overflow.style.gridRow = `1 / span ${units - rackSize}`;
        overflow.textContent = `Above ${rackSize}U`;
        slots.prepend(overflow);
      }
      attachRackDropZone(slots, name, units, rackSize);
      frame.append(scale, slots, rightRail);
      cabinet.appendChild(frame);
      rack.append(header, cabinet);
      view.appendChild(rack);
    });

  unplacedBox.replaceChildren();
  unplacedBox.hidden = !unplaced.length || !devices.length;
  if (unplaced.length) {
    const heading = document.createElement("h3");
    heading.textContent = `Not placed in a rack (${unplaced.length})`;
    const hint = document.createElement("p");
    hint.className = "field-hint";
    hint.textContent = racks.size
      ? "Drag a device onto a rack, or select it to set its rack and position."
      : "Select a device to set its rack and position.";
    const list = document.createElement("div");
    list.className = "rack-unplaced-list";
    unplaced.forEach((device) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-btn";
      button.draggable = true;
      button.dataset.focusKey = JSON.stringify(["rack-unplaced", device.id]);
      button.textContent = device.name;
      button.addEventListener("dragstart", (event) =>
        startRackDrag(event, device),
      );
      button.addEventListener("dragend", endRackDrag);
      button.addEventListener("click", () => {
        selectedDeviceId = device.id;
        selectedPortId = null;
        render();
        beginDeviceEdit();
        document.querySelector(".device-details-fields").open = true;
        document.querySelector("#deviceForm").elements.rack.focus();
      });
      list.appendChild(button);
    });
    unplacedBox.append(heading, hint, list);
  }
  restoreListFocus(view.closest(".rack-card"), focusKey);
}

/* ------------------------------------------------------------------------
   Offline support: the service worker is generated by npm run dist.
   ------------------------------------------------------------------------ */
function registerServiceWorker() {
  if (
    !("serviceWorker" in navigator) ||
    !/^https?:$/.test(window.location.protocol)
  ) {
    return;
  }
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker
    .register("sw.js")
    .then((registration) => {
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (
            worker.state !== "installed" ||
            !navigator.serviceWorker.controller ||
            !window.VNetCoreNotifications
          ) {
            return;
          }
          window.VNetCoreNotifications.show(
            "Reload to use it. Your saved data is not affected.",
            {
              type: "info",
              title: "A new version is ready",
              slot: "update",
              persistent: true,
              actions: [
                {
                  label: "Reload",
                  onClick: () => worker.postMessage("skip-waiting"),
                },
              ],
            },
          );
        });
      });
    })
    .catch(() => {
      // No service worker during development (it is generated by npm run dist).
    });
}

window.addEventListener("offline", () =>
  showNotification(
    "VNetCore keeps working and saves changes in this browser.",
    { type: "info", title: "You are offline" },
  ),
);
window.addEventListener("online", () =>
  showNotification("Connection restored.", {
    type: "info",
    title: "Back online",
  }),
);

document
  .querySelector("#projectRackUnitsSelect")
  .addEventListener("change", (event) => {
    const size = Number(event.target.value);
    if (size === project.rackUnits) return;
    const previous = snapshot();
    project.rackUnits = size;
    commitChange(previous, `Rack size set to ${size}U`);
  });
document
  .querySelector("#bulkModeBtn")
  .addEventListener("click", () => setBulkMode(!bulkMode));
document.querySelector("#bulkSelectShownBtn").addEventListener("click", () => {
  shownPortIds().forEach((id) => bulkSelection.add(id));
  bulkDeviceId = currentDevice()?.id || null;
  renderPorts();
  renderBulkTools();
});
document
  .querySelector("#bulkClearSelectionBtn")
  .addEventListener("click", () => {
    bulkSelection.clear();
    bulkAnchorId = null;
    renderPorts();
    renderBulkTools();
    document.querySelector("#bulkSelectShownBtn").focus();
  });
document
  .querySelector("#bulkApplyBtn")
  .addEventListener("click", applyBulkEdit);

document.querySelector("#printBtn").addEventListener("click", () => {
  renderPrintReport();
  window.print();
});
document.querySelector("#themeToggleBtn").addEventListener("click", () => {
  const nextTheme =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(nextTheme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {
    // The theme remains active for the current session when storage is unavailable.
  }
});

document
  .querySelector("#fileImportInput")
  .addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file || !importMode) return;
    if (file.size > LIMITS.fileBytes) {
      showNotification(
        `The file exceeds the ${LIMITS.fileBytes / 1024 / 1024} MB limit.`,
        { type: "warning" },
      );
      importMode = null;
      return;
    }
    const mode = importMode;
    importMode = null;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      try {
        reviewImport(parseImportContent(mode, String(reader.result || "")));
      } catch (error) {
        showNotification(`Import rejected: ${error.message}`, {
          type: "error",
          title: "Import could not be completed",
          persistent: true,
        });
      }
    });
    reader.addEventListener("error", () =>
      showNotification(
        `Could not read the file: ${reader.error?.message || "unknown error"}`,
        { type: "error" },
      ),
    );
    reader.addEventListener("abort", () =>
      showNotification("File import was cancelled.", { type: "info" }),
    );
    reader.readAsText(file);
  });

document.querySelector("#importDialog").addEventListener("close", (event) => {
  if (event.target.returnValue === "default") applyPendingImport();
  else pendingImport = null;
});

document.querySelectorAll(".menu-btn").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = button.closest(".menu");
    const shouldOpen = !menu.classList.contains("open");
    closeMenus();
    if (shouldOpen) {
      menu.querySelector(".menu-options").hidden = false;
      menu.classList.add("open");
      button.setAttribute("aria-expanded", "true");
      menu.querySelector(".menu-options button").focus();
    }
  });
  button.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const menu = button.closest(".menu");
    closeMenus();
    menu.querySelector(".menu-options").hidden = false;
    menu.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    const items = menu.querySelectorAll('[role="menuitem"]');
    items[event.key === "ArrowUp" ? items.length - 1 : 0].focus();
  });
});
document.querySelectorAll(".menu-options").forEach((menu) => {
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      closeMenus();
      return;
    }
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      items[next].focus();
    }
  });
});
document.addEventListener("focusin", (event) => {
  const openMenu = document.querySelector(".menu.open");
  if (openMenu && !openMenu.contains(event.target)) closeMenus();
});
document.addEventListener("click", () => closeMenus());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const openButton = document.querySelector(".menu.open .menu-btn");
    closeMenus({ restoreFocus: openButton });
  }
});

document.querySelector("#toggleSidebarBtn").addEventListener("click", () => {
  setSidebarExpanded(
    document.querySelector("#sidebar").classList.contains("is-collapsed"),
  );
});

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedChanges && portDrafts.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
});

if (devices.length && window.matchMedia?.("(max-width: 980px)").matches) {
  document.querySelector(".project-card").open = false;
  document.querySelector(".add-device-card").open = false;
}
// boot.js hid these panels before the first paint; they are now really closed.
document.documentElement.classList.remove("collapse-panels");
window.addEventListener("resize", updatePortScrollHint);
if (window.ResizeObserver) {
  new ResizeObserver(updatePortScrollHint).observe(
    document.querySelector("#portGrid"),
  );
}

render();
backupNoticeState.infoShown = true;
saveBackupNoticeState();
renderBackupNotice();
setInterval(renderBackupNotice, 60 * 1000);
window.addEventListener("focus", () => {
  renderBackupNotice();
  renderReviewStatus();
});
registerServiceWorker();
window.addEventListener("storage", (event) => {
  if (event.key !== BACKUP_NOTICE_KEY && event.key !== null) return;
  backupNoticeState = loadBackupNoticeState();
  showBackupIntroduction = !backupNoticeState.infoShown;
  renderBackupNotice();
});
if (loaded.migrated) {
  saveProject({ keepBackup: false });
  showNotification("Existing project migrated to the new data format.");
} else if (loadFailure) {
  const preserved = quarantineUnreadableData(loadFailure);
  setSaveStatus("Stored data could not be loaded.", "error");
  showNotification(
    preserved
      ? `Stored data could not be read and a copy was preserved for recovery: ${loadFailure.error.message}`
      : `Stored data could not be read. Download the recovery copy before editing: ${loadFailure.error.message}`,
    {
      recovery: true,
      backup: Boolean(readBackupProject()),
      persistent: true,
    },
  );
} else {
  setSaveStatus("Saved locally", "saved");
}

// The landing page's "Try the demo" link opens ./?demo=1. The sample project
// is added to the workspace as its own project: existing projects are never
// replaced, except a single blank project that holds no data at all.
const DEMO_PROJECT_ID = "vnetcore-demo";

function isBlankProject(candidate) {
  return (
    candidate.devices.length === 0 &&
    candidate.connections.length === 0 &&
    !candidate.owner &&
    !candidate.reviewDate &&
    candidate.projectName === EMPTY_PROJECT.projectName
  );
}

function openDemoProject(source) {
  const existing = projectRecords.find(
    (record) => record.id === DEMO_PROJECT_ID,
  );
  if (existing) {
    activateProject(existing.id);
    return;
  }
  let demo;
  try {
    demo = normalizeProject(source, { strict: true });
  } catch (error) {
    showNotification(`The demo project could not be opened: ${error.message}`, {
      type: "error",
    });
    return;
  }
  const previous = snapshot();
  saveProject();
  const replaceBlank =
    projectRecords.length === 1 &&
    isBlankProject({ ...projectRecords[0].project, devices });
  const record = { id: DEMO_PROJECT_ID, project: demo };
  if (replaceBlank) projectRecords = [record];
  else projectRecords.push(record);
  activeProjectId = record.id;
  project = record.project;
  devices = project.devices;
  selectedDeviceId = devices[0]?.id || null;
  selectedPortId = null;
  portDrafts.clear();
  cancelDeviceEdit();
  const saved = saveProject({ keepBackup: false });
  rememberForUndo(previous, "Opened the demo project");
  render();
  if (saved)
    showNotification(
      replaceBlank
        ? "Opened the demo project. Change anything you like; it is saved like any other project."
        : "Added the demo project. Your other projects are untouched.",
      { undo: true },
    );
}

function handleDemoRequest() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("demo") !== "1") return;
  url.searchParams.delete("demo");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  // Never write to storage while saved data could not be read.
  if (loadFailure) return;
  if (window.VNetCoreDemoProject) {
    openDemoProject(window.VNetCoreDemoProject);
    return;
  }
  const script = document.createElement("script");
  script.src = "demo-project.js";
  script.addEventListener("load", () =>
    openDemoProject(window.VNetCoreDemoProject),
  );
  script.addEventListener("error", () =>
    showNotification("The demo project could not be loaded.", {
      type: "error",
    }),
  );
  document.head.appendChild(script);
}

handleDemoRequest();
