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
} = window.VNetCoreCore;

const STORAGE_KEY = `vnetcore.project.v${SCHEMA_VERSION}`;
const LEGACY_STORAGE_KEYS = ["vnetcore.project.v8", "vnetcore.project.v7"];
const BACKUP_KEY = `${STORAGE_KEY}.backup`;
const BACKUP_NOTICE_KEY = "vnetcore.backup-reminder.v1";
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
let backupNoticeState = loadBackupNoticeState();
let showBackupIntroduction = !backupNoticeState.infoShown;

const loaded = loadProject();
let project = loaded.project;
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
        project: normalizeProject(JSON.parse(saved)),
        migrated: key !== STORAGE_KEY,
      };
    } catch (error) {
      loadFailure = { error, raw: saved, key };
      return { project: cloneProject(EMPTY_PROJECT), migrated: false };
    }
  }
  return { project: cloneProject(EMPTY_PROJECT), migrated: false };
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
  const serialized = JSON.stringify(project);
  try {
    const previous = localStorage.getItem(STORAGE_KEY);
    if (keepBackup && previous && previous !== serialized) {
      localStorage.setItem(BACKUP_KEY, previous);
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    hasUnsavedChanges = false;
    setSaveStatus(
      `Saved locally at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      "saved",
    );
    return true;
  } catch (error) {
    hasUnsavedChanges = true;
    setSaveStatus("Not saved. Export a recovery copy.", "error");
    showNotification(`Local save failed: ${error.message}`, {
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
  project = normalizeProject(previous.project);
  devices = project.devices;
  selectedDeviceId = devices.some(
    (device) => device.id === previous.selectedDeviceId,
  )
    ? previous.selectedDeviceId
    : devices[0]?.id || null;
  selectedPortId = previous.selectedPortId;
  saveProject();
  render();
  showNotification(`Undone: ${previous.message}`);
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

function requestConfirmation(title, message, actionLabel) {
  const dialog = document.querySelector("#confirmDialog");
  document.querySelector("#confirmDialogTitle").textContent = title;
  document.querySelector("#confirmDialogMessage").textContent = message;
  document.querySelector("#confirmDialogAction").textContent = actionLabel;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "default"),
      { once: true },
    );
  });
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

function portDraftKey(deviceId, portId) {
  return JSON.stringify([deviceId, portId]);
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
    PORT_EDIT_FIELDS.some((field) => draft[field] !== String(port[field] ?? ""))
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
  const fields = [device.name, device.type, device.location];
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
  const confirmed = await requestConfirmation(
    "Delete device",
    `Delete "${device.name}"? You can undo this action until another ten changes are made.`,
    "Delete device",
  );
  if (!confirmed) return;
  const previous = snapshot();
  devices = devices.filter((item) => item.id !== device.id);
  if (selectedDeviceId === device.id) selectedDeviceId = devices[0]?.id || null;
  selectedPortId = null;
  commitChange(previous, `Deleted ${device.name}`);
}

async function clearAllDevices() {
  if (!devices.length) {
    showNotification("There are no devices to delete.");
    return;
  }
  const confirmed = await requestConfirmation(
    "Delete all devices",
    "Delete every device in this project?",
    "Delete all",
  );
  if (!confirmed) return;
  const previous = snapshot();
  devices = [];
  selectedDeviceId = null;
  selectedPortId = null;
  commitChange(previous, "Deleted all devices");
}

async function startBlankProject() {
  const confirmed = await requestConfirmation(
    "Start a blank project",
    "Replace the current project with a blank one? You can undo this action or restore the local backup.",
    "Start blank project",
  );
  if (!confirmed) return;
  const previous = snapshot();
  project = cloneProject(EMPTY_PROJECT);
  devices = project.devices;
  selectedDeviceId = null;
  selectedPortId = null;
  pendingImport = null;
  portDrafts.clear();
  document.querySelector("#deviceSearchInput").value = "";
  cancelDeviceEdit();
  commitChange(previous, "Started a blank project");
  setSidebarExpanded(true);
  document.querySelector(".project-card").open = true;
  document.querySelector("#projectNameInput").focus();
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
  const index = devices.findIndex((item) => item.id === device.id);
  document.querySelector("#moveDeviceUpBtn").disabled = index <= 0;
  document.querySelector("#moveDeviceDownBtn").disabled =
    index < 0 || index === devices.length - 1;
  updateLegendCounts(device);
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
  button.className = `port ${port.status} ${port.id === selectedPortId ? "is-selected" : ""}`;
  button.dataset.focusKey = portDraftKey(currentDevice().id, port.id);
  button.setAttribute("aria-pressed", String(port.id === selectedPortId));
  button.setAttribute(
    "aria-label",
    `${port.portKind} port ${port.number}, ${STATUS_LABELS[port.status]}, ${port.connectionType || "no connection type"}, ${port.connectedTo || "no destination"}`,
  );
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
  sublabel.textContent = port.connectedTo || port.vlan || "-";
  sublabel.title = sublabel.textContent;
  button.append(number, status, label, sublabel);
  if (portDrafts.has(portDraftKey(currentDevice().id, port.id))) {
    const draftLabel = document.createElement("span");
    draftLabel.className = "port-draft-label";
    draftLabel.textContent = "Unsaved";
    button.appendChild(draftLabel);
    button.setAttribute(
      "aria-label",
      `${button.getAttribute("aria-label")}, unsaved changes`,
    );
  }
  return button;
}

function renderPorts() {
  const grid = document.querySelector("#portGrid");
  const device = currentDevice();
  const focusKey = captureListFocus(grid);
  const scrollLeft = grid.scrollLeft;
  grid.replaceChildren();
  grid.classList.toggle("is-empty", !device || device.ports.length === 0);
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
      "This device has no ports. Edit the device to add interfaces.";
    grid.appendChild(message);
    updatePortScrollHint();
    return;
  }
  const layout =
    editingDeviceId === device.id
      ? document.querySelector("#devicePortLayoutSelect").value
      : device.portLayout;
  const splitLayout = layout === "split";
  const orderedPorts = [...device.ports].sort((first, second) => {
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
    button.addEventListener("click", () => {
      selectedPortId = port.id;
      renderPorts();
      renderPortForm();
    });
    grid.appendChild(button);
  });
  grid.scrollLeft = scrollLeft;
  restoreListFocus(grid, focusKey);
  updatePortScrollHint();
}

function renderPortForm() {
  const port = currentPort();
  const card = document.querySelector(".card.details");
  card.hidden = !port;
  updatePortEditStatus();
  if (!port) return;
  const form = document.querySelector("#portForm");
  const draft = portDrafts.get(portDraftKey(currentDevice().id, port.id));
  Object.entries({ ...port, ...draft }).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value ?? "";
  });
  form.elements.number.value = `${port.portKind} ${port.number}`;
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
  if (!filtered.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = devices.length
      ? "No matching devices."
      : "No devices have been added to this project.";
    container.appendChild(message);
    return;
  }
  filtered.forEach((device) => {
    const counts = getDeviceCounts(device);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `summary-device ${device.id === selectedDeviceId ? "is-selected" : ""}`;
    button.dataset.focusKey = JSON.stringify(["summary", device.id]);
    button.setAttribute("aria-pressed", String(device.id === selectedDeviceId));
    const name = document.createElement("strong");
    name.textContent = device.name;
    const meta = document.createElement("small");
    meta.textContent = `${device.type} | ${device.location || "No location"} | LAN: ${getKindCount(device, "LAN")} | WAN: ${getKindCount(device, "WAN")}`;
    const statuses = document.createElement("small");
    statuses.textContent = `Active: ${counts.active} | No link: ${counts["no-link"]} | Available: ${counts.available} | Unknown: ${counts["unknown-device"]}`;
    button.append(name, meta, statuses);
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
  showNotification(`Exported ${filename}`);
}

function exportCsv() {
  const filename = `${safeFileName(project.projectName)}.csv`;
  downloadTextFile(
    filename,
    projectToCsv({ ...project, devices }),
    "text/csv;charset=utf-8",
  );
  recordBackupExport();
  showNotification(`Exported ${filename}`);
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
document.querySelector("#deviceSearchInput").addEventListener("input", () => {
  renderDevices();
  renderProjectDevicesSummary();
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
    lanCount < 1 ||
    wanCount > 16 ||
    lanCount > 96
  ) {
    showNotification("Use whole port counts within the allowed ranges.");
    return;
  }
  const finalType = data.type === "Other" ? data.customType.trim() : data.type;
  if (!finalType) {
    showNotification("Specify the device type.");
    return;
  }
  const previous = snapshot();
  if (editingDeviceId) {
    const device = devices.find((item) => item.id === editingDeviceId);
    if (!device) return cancelDeviceEdit();
    device.name = data.model.trim().slice(0, LIMITS.deviceName);
    device.type = finalType.slice(0, LIMITS.deviceType);
    device.location = data.location.trim().slice(0, LIMITS.location);
    device.portLayout = data.portLayout === "split" ? "split" : "alternating";
    device.ports = [
      ...makePorts("WAN", wanCount, device.ports),
      ...makePorts("LAN", lanCount, device.ports),
    ];
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
      ports: [...makePorts("WAN", wanCount), ...makePorts("LAN", lanCount)],
    };
    devices.push(device);
    selectedDeviceId = device.id;
    selectedPortId = null;
    event.target.reset();
    renderDeviceTypeField();
    commitChange(previous, `Added ${device.name}`);
  }
});

document
  .querySelector("#portForm")
  .addEventListener("input", rememberPortDraft);
document
  .querySelector("#portForm")
  .addEventListener("change", rememberPortDraft);
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
  port.connectedTo = data.connectedTo.trim().slice(0, LIMITS.shortField);
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
      showNotification("No valid local backup is available.");
      return;
    }
    const confirmed = await requestConfirmation(
      "Restore local backup",
      `Restore "${backup.projectName}" and replace the active project? Download the raw recovery first if you need it.`,
      "Restore backup",
    );
    if (!confirmed) return;
    project = backup;
    devices = project.devices;
    selectedDeviceId = devices[0]?.id || null;
    selectedPortId = null;
    loadFailure = null;
    portDrafts.clear();
    cancelDeviceEdit();
    saveProject({ keepBackup: false });
    render();
    showNotification("Local backup restored.");
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
document.querySelector("#printBtn").addEventListener("click", () => {
  renderPrintReport();
  window.print();
});

document
  .querySelector("#fileImportInput")
  .addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file || !importMode) return;
    if (file.size > LIMITS.fileBytes) {
      showNotification(
        `The file exceeds the ${LIMITS.fileBytes / 1024 / 1024} MB limit.`,
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
          persistent: true,
        });
      }
    });
    reader.addEventListener("error", () =>
      showNotification(
        `Could not read the file: ${reader.error?.message || "unknown error"}`,
      ),
    );
    reader.addEventListener("abort", () =>
      showNotification("File import was cancelled."),
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
window.addEventListener("focus", renderBackupNotice);
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
  setSaveStatus("Stored data could not be loaded.", "error");
  showNotification(
    `Stored data was not overwritten: ${loadFailure.error.message}`,
    {
      recovery: true,
      backup: Boolean(readBackupProject()),
      persistent: true,
    },
  );
} else {
  setSaveStatus("Saved locally", "saved");
}
