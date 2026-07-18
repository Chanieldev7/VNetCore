const STORAGE_KEY = 'vnetcore.project.v7';

const STATUS_LABELS = {
  active: 'Active',
  'no-link': 'No link',
  available: 'Available',
  'unknown-device': 'Unknown Device'
};

const STATUS_MIGRATION = {
  connected: 'active',
  uplink: 'active',
  empty: 'available',
  issue: 'unknown-device',
  Active: 'active',
  'No link': 'no-link',
  Available: 'available',
  'Unknown Device': 'unknown-device'
};

const CSV_HEADERS = [
  'projectName',
  'deviceName',
  'deviceType',
  'deviceLocation',
  'portKind',
  'portNumber',
  'status',
  'connectionType',
  'connectedTo',
  'vlan',
  'address',
  'notes'
];

const emptyProject = {
  projectName: 'Unnamed project',
  devices: []
};

let project = loadProject();
let devices = project.devices;
let selectedDeviceId = devices[0]?.id || null;
let selectedPortNumber = null;
let selectedPortKind = null;
let importMode = null;
let shouldWarnBeforeLeaving = true;

function makeMixedPorts(wanCount, lanCount) {
  const wanPorts = Array.from({ length: wanCount }, (_, index) => ({
    number: index + 1,
    status: 'no-link',
    connectedTo: 'Internet Provider',
    connectionType: 'WAN',
    vlan: 'WAN',
    address: '',
    notes: 'Default WAN port.',
    portKind: 'WAN'
  }));

  const lanPorts = Array.from({ length: lanCount }, (_, index) => ({
    number: index + 1,
    status: 'available',
    connectedTo: '',
    connectionType: '',
    vlan: '',
    address: '',
    notes: '',
    portKind: 'LAN'
  }));

  return [...wanPorts, ...lanPorts];
}

function normalizeStatus(status) {
  const value = String(status || '').trim();

  if (STATUS_LABELS[value]) {
    return value;
  }

  return STATUS_MIGRATION[value] || 'available';
}

function loadProject() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (!saved) {
      return cloneProject(emptyProject);
    }

    const parsed = JSON.parse(saved);

    if (Array.isArray(parsed)) {
      return {
        projectName: 'Unnamed project',
        devices: normalizeDevices(parsed)
      };
    }

    return {
      projectName: parsed.projectName || 'Unnamed project',
      devices: normalizeDevices(parsed.devices || [])
    };
  } catch {
    return cloneProject(emptyProject);
  }
}

function cloneProject(sourceProject) {
  return {
    projectName: sourceProject.projectName,
    devices: normalizeDevices(sourceProject.devices)
  };
}

function normalizeDevices(deviceList) {
  return deviceList.map(device => {
    const ports = Array.isArray(device.ports) ? device.ports : [];

    return {
      id: device.id || crypto.randomUUID(),
      name: device.name || device.model || 'Unnamed device',
      type: device.type || 'Other',
      location: device.location || '',
      ports: ports.map((port, index) => {
        const isWan =
          port.portKind === 'WAN' ||
          port.connectionType === 'WAN' ||
          port.vlan === 'WAN';

        return {
          number: Number(port.number || index + 1),
          status: normalizeStatus(port.status),
          connectedTo: port.connectedTo || '',
          connectionType: port.connectionType || '',
          vlan: port.vlan || '',
          address: port.address || '',
          notes: port.notes || '',
          portKind: port.portKind || (isWan ? 'WAN' : 'LAN')
        };
      })
    };
  });
}

function save() {
  project.devices = devices;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
}

function currentDevice() {
  return devices.find(device => device.id === selectedDeviceId) || devices[0] || null;
}

function currentPort() {
  const device = currentDevice();

  if (!device || selectedPortNumber === null || selectedPortKind === null) {
    return null;
  }

  return device.ports.find(port => {
    return port.number === selectedPortNumber && port.portKind === selectedPortKind;
  }) || null;
}

function getLanCount(device) {
  if (!device) return 0;
  return device.ports.filter(port => port.portKind !== 'WAN').length;
}

function getWanCount(device) {
  if (!device) return 0;
  return device.ports.filter(port => port.portKind === 'WAN').length;
}

function createTrashIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');

  icon.innerHTML = `
    <path d="M3 6h18"></path>
    <path d="M8 6V4h8v2"></path>
    <path d="M19 6l-1 14H6L5 6"></path>
    <path d="M10 11v6"></path>
    <path d="M14 11v6"></path>
  `;

  return icon;
}

function getDeviceCounts(device) {
  const counts = {
    active: 0,
    'no-link': 0,
    available: 0,
    'unknown-device': 0
  };

  if (!device) {
    return counts;
  }

  device.ports.forEach(port => {
    const status = normalizeStatus(port.status);

    if (counts[status] !== undefined) {
      counts[status]++;
    }
  });

  return counts;
}

function renderProjectName() {
  const input = document.querySelector('#projectNameInput');
  const display = document.querySelector('#projectDisplayName');

  input.value = project.projectName;
  display.textContent = project.projectName || 'Unnamed project';
}

function renderDevices() {
  const list = document.querySelector('#deviceList');
  list.innerHTML = '';

  if (devices.length === 0) {
    const emptyMessage = document.createElement('p');

    emptyMessage.textContent = 'No devices have been added.';
    emptyMessage.style.textAlign = 'center';
    emptyMessage.style.fontSize = '13px';
    emptyMessage.style.padding = '10px';
    emptyMessage.style.color = 'var(--text-muted)';

    list.appendChild(emptyMessage);
    return;
  }

  devices.forEach(device => {
    const container = document.createElement('div');
    container.className = 'device-item-container';

    const btn = document.createElement('button');
    btn.className = `device-item ${device.id === selectedDeviceId ? 'active' : ''}`;

    const strong = document.createElement('strong');
    strong.textContent = device.name;

    const br = document.createElement('br');

    const small = document.createElement('small');
    small.textContent = `${device.type} · ${device.location || 'No location'} · LAN: ${getLanCount(device)} · WAN: ${getWanCount(device)}`;

    btn.appendChild(strong);
    btn.appendChild(br);
    btn.appendChild(small);

    btn.onclick = () => {
      selectedDeviceId = device.id;
      selectedPortNumber = null;
      selectedPortKind = null;
      render();
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.title = `Delete ${device.name}`;
    delBtn.appendChild(createTrashIcon());

    delBtn.onclick = event => {
      event.stopPropagation();
      deleteDevice(device.id, device.name);
    };

    container.appendChild(btn);
    container.appendChild(delBtn);
    list.appendChild(container);
  });
}

function deleteDevice(id, name) {
  const confirmed = confirm(`Are you sure you want to delete "${name}"? This action cannot be undone.`);

  if (!confirmed) {
    return;
  }

  devices = devices.filter(device => device.id !== id);

  if (selectedDeviceId === id) {
    selectedDeviceId = devices[0]?.id || null;
    selectedPortNumber = null;
    selectedPortKind = null;
  }

  render();
}

function clearAllDevices() {
  if (devices.length === 0) {
    alert('There are no devices to delete.');
    return;
  }

  const confirmed = confirm('Are you sure you want to delete all devices? This action cannot be undone.');

  if (!confirmed) {
    return;
  }

  devices = [];
  selectedDeviceId = null;
  selectedPortNumber = null;
  selectedPortKind = null;
  render();
}

function renderHeader() {
  const device = currentDevice();
  const header = document.querySelector('.device-header');

  if (!device) {
    header.style.display = 'none';
    updateLegendCounts(null);
    return;
  }

  header.style.display = 'flex';

  document.querySelector('#deviceType').textContent = device.type;
  document.querySelector('#deviceName').textContent = device.name;
  document.querySelector('#deviceMeta').textContent = `${device.location || 'No location'} · LAN: ${getLanCount(device)} · WAN: ${getWanCount(device)}`;

  updateLegendCounts(device);
}

function updateLegendCounts(device) {
  const counts = getDeviceCounts(device);

  document.querySelector('#countActive').textContent = counts.active;
  document.querySelector('#countNoLink').textContent = counts['no-link'];
  document.querySelector('#countAvailable').textContent = counts.available;
  document.querySelector('#countUnknownDevice').textContent = counts['unknown-device'];
}

function createPortElement(port, isSelected = false) {
  port.status = normalizeStatus(port.status);

  const el = document.createElement('div');
  el.className = `port ${port.status} ${isSelected ? 'selected' : ''}`;

  const portNumber = document.createElement('div');
  portNumber.className = 'port-number';
  portNumber.textContent = `${port.portKind} ${port.number}`;

  const portLabel = document.createElement('div');
  portLabel.className = 'port-label';

  if (port.status === 'available') {
    portLabel.title = 'Available';
    portLabel.textContent = 'Available';
  } else {
    portLabel.title = port.connectionType || STATUS_LABELS[port.status] || 'No type';
    portLabel.textContent = port.connectionType || STATUS_LABELS[port.status] || 'No type';
  }

  const portSubLabel = document.createElement('div');
  portSubLabel.className = 'port-sublabel';
  portSubLabel.title = port.connectedTo || port.vlan || '';
  portSubLabel.textContent = port.connectedTo || port.vlan || '-';

  el.appendChild(portNumber);
  el.appendChild(portLabel);
  el.appendChild(portSubLabel);

  return el;
}

function renderPorts() {
  const grid = document.querySelector('#portGrid');
  const device = currentDevice();

  grid.innerHTML = '';

  if (!device) {
    const message = document.createElement('div');

    message.textContent = 'Add or select a device from the sidebar to view its interfaces.';
    message.style.padding = '20px';
    message.style.color = 'var(--text-muted)';

    grid.appendChild(message);
    return;
  }

  device.ports.forEach(port => {
    const isSelected = port.number === selectedPortNumber && port.portKind === selectedPortKind;
    const el = createPortElement(port, isSelected);

    el.onclick = () => {
      selectedPortNumber = port.number;
      selectedPortKind = port.portKind;
      renderPorts();
      renderForm();
    };

    grid.appendChild(el);
  });
}

function renderForm() {
  const port = currentPort();
  const detailsCard = document.querySelector('.card.details');
  const form = document.querySelector('#portForm');

  if (!port) {
    detailsCard.style.display = 'none';
    return;
  }

  detailsCard.style.display = 'block';
  port.status = normalizeStatus(port.status);

  for (const [key, value] of Object.entries(port)) {
    if (form.elements[key]) {
      form.elements[key].value = value ?? '';
    }
  }
}

function renderProjectDevicesSummary() {
  const container = document.querySelector('#projectDevicesSummary');
  container.innerHTML = '';

  if (devices.length === 0) {
    const message = document.createElement('p');
    message.textContent = 'No devices have been added to this project.';
    message.style.color = 'var(--text-muted)';
    message.style.fontSize = '14px';
    container.appendChild(message);
    return;
  }

  devices.forEach(device => {
    const counts = getDeviceCounts(device);

    const button = document.createElement('button');
    button.className = `summary-device ${device.id === selectedDeviceId ? 'active' : ''}`;

    const name = document.createElement('strong');
    name.textContent = device.name;

    const meta = document.createElement('small');
    meta.textContent = `${device.type} · ${device.location || 'No location'} · LAN: ${getLanCount(device)} · WAN: ${getWanCount(device)}`;

    const br = document.createElement('br');

    const status = document.createElement('small');
    status.textContent = `Active: ${counts.active} · No link: ${counts['no-link']} · Available: ${counts.available} · Unknown Device: ${counts['unknown-device']}`;

    button.appendChild(name);
    button.appendChild(meta);
    button.appendChild(br);
    button.appendChild(status);

    button.onclick = () => {
      selectedDeviceId = device.id;
      selectedPortNumber = null;
      selectedPortKind = null;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    container.appendChild(button);
  });
}

function createPrintStatusLegend() {
  const legend = document.createElement('section');
  legend.className = 'print-status-legend';

  const title = document.createElement('h2');
  title.textContent = 'Port status legend';

  const items = document.createElement('div');
  items.className = 'print-legend-items';

  const statuses = [
    { className: 'active', label: 'Active' },
    { className: 'no-link', label: 'No link' },
    { className: 'available', label: 'Available' },
    { className: 'unknown-device', label: 'Unknown Device' }
  ];

  statuses.forEach(status => {
    const item = document.createElement('span');
    item.className = 'print-legend-item';

    const line = document.createElement('i');
    line.className = `print-legend-line ${status.className}`;

    const text = document.createElement('span');
    text.textContent = status.label;

    item.appendChild(line);
    item.appendChild(text);
    items.appendChild(item);
  });

  legend.appendChild(title);
  legend.appendChild(items);

  return legend;
}

function renderPrintReport() {
  const report = document.querySelector('#printReport');

  if (!report) {
    return;
  }

  report.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'print-header';

  const title = document.createElement('h1');
  title.textContent = 'VNetCore';

  const subtitle = document.createElement('p');
  subtitle.textContent = 'Network Infrastructure Documentation';

  const projectNameBox = document.createElement('div');
  projectNameBox.className = 'print-project-name';

  const projectLabel = document.createElement('span');
  projectLabel.textContent = 'Project name';

  const projectName = document.createElement('strong');
  projectName.textContent = project.projectName || 'Unnamed project';

  projectNameBox.appendChild(projectLabel);
  projectNameBox.appendChild(projectName);

  header.appendChild(title);
  header.appendChild(subtitle);
  header.appendChild(projectNameBox);

  report.appendChild(header);
  report.appendChild(createPrintStatusLegend());

  if (devices.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No devices have been added to this project.';
    report.appendChild(empty);
    return;
  }

  devices.forEach(device => {
    const deviceSection = document.createElement('section');
    deviceSection.className = 'print-device';

    const deviceHeader = document.createElement('div');
    deviceHeader.className = 'print-device-header';

    const name = document.createElement('h2');
    name.textContent = device.name;

    const meta = document.createElement('p');
    meta.textContent = `${device.type} · ${device.location || 'No location'} · LAN: ${getLanCount(device)} · WAN: ${getWanCount(device)}`;

    deviceHeader.appendChild(name);
    deviceHeader.appendChild(meta);

    const portsWrapper = document.createElement('div');
    portsWrapper.className = 'print-ports';

    device.ports.forEach(port => {
      portsWrapper.appendChild(createPortElement(port));
    });

    deviceSection.appendChild(deviceHeader);
    deviceSection.appendChild(portsWrapper);
    report.appendChild(deviceSection);
  });
}

function renderFooterYear() {
  const yearElement = document.querySelector('#currentYear');

  if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
  }
}

function renderDeviceTypeField() {
  const typeSelect = document.querySelector('#deviceTypeSelect');
  const customTypeInput = document.querySelector('#customDeviceTypeInput');

  if (!typeSelect || !customTypeInput) {
    return;
  }

  if (typeSelect.value === 'Other') {
    customTypeInput.classList.add('visible');
    customTypeInput.required = true;
  } else {
    customTypeInput.classList.remove('visible');
    customTypeInput.required = false;
    customTypeInput.value = '';
  }
}

function render() {
  renderProjectName();
  renderDevices();
  renderHeader();
  renderPorts();
  renderForm();
  renderProjectDevicesSummary();
  renderPrintReport();
  renderFooterYear();
  renderDeviceTypeField();
  save();
}

function safeFileName(value) {
  return String(value || 'vnetcore-project')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'vnetcore-project';
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();

  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportJson() {
  project.devices = devices;

  const filename = `${safeFileName(project.projectName)}.json`;
  const content = JSON.stringify(project, null, 2);

  downloadTextFile(filename, content, 'application/json;charset=utf-8');
}

function csvEscape(value) {
  const text = String(value ?? '');

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function projectToCsv() {
  const rows = [CSV_HEADERS];

  devices.forEach(device => {
    device.ports.forEach(port => {
      rows.push([
        project.projectName,
        device.name,
        device.type,
        device.location,
        port.portKind,
        port.number,
        STATUS_LABELS[normalizeStatus(port.status)],
        port.connectionType,
        port.connectedTo,
        port.vlan,
        port.address,
        port.notes
      ]);
    });
  });

  return rows.map(row => row.map(csvEscape).join(',')).join('\n');
}

function exportCsv() {
  const filename = `${safeFileName(project.projectName)}.csv`;
  const content = projectToCsv();

  downloadTextFile(filename, content, 'text/csv;charset=utf-8');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      value += '"';
      i++;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === ',' && !insideQuotes) {
      row.push(value);
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }

      row.push(value);

      if (row.some(cell => cell.trim() !== '')) {
        rows.push(row);
      }

      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  row.push(value);

  if (row.some(cell => cell.trim() !== '')) {
    rows.push(row);
  }

  return rows;
}

function csvRowsToObjects(rows) {
  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map(header => header.trim());

  return rows.slice(1).map(row => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = row[index] ?? '';
    });

    return item;
  });
}

function importCsvContent(text) {
  const rows = parseCsv(text);
  const records = csvRowsToObjects(rows);

  if (records.length === 0) {
    alert('The CSV file does not contain valid data.');
    return;
  }

  const groupedDevices = new Map();
  const importedProjectName = records[0].projectName?.trim() || 'Imported project';

  records.forEach(record => {
    const deviceName = record.deviceName?.trim() || 'Unnamed device';
    const deviceType = record.deviceType?.trim() || 'Other';
    const deviceLocation = record.deviceLocation?.trim() || '';
    const key = `${deviceName}|||${deviceType}|||${deviceLocation}`;

    if (!groupedDevices.has(key)) {
      groupedDevices.set(key, {
        id: crypto.randomUUID(),
        name: deviceName,
        type: deviceType,
        location: deviceLocation,
        ports: []
      });
    }

    groupedDevices.get(key).ports.push({
      number: Number(record.portNumber || groupedDevices.get(key).ports.length + 1),
      status: normalizeStatus(record.status),
      connectedTo: record.connectedTo || '',
      connectionType: record.connectionType || '',
      vlan: record.vlan || '',
      address: record.address || '',
      notes: record.notes || '',
      portKind: record.portKind?.trim() || 'LAN'
    });
  });

  project = {
    projectName: importedProjectName,
    devices: normalizeDevices(Array.from(groupedDevices.values()))
  };

  devices = project.devices;
  selectedDeviceId = devices[0]?.id || null;
  selectedPortNumber = null;
  selectedPortKind = null;

  render();
}

function importJsonContent(text) {
  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      project = {
        projectName: 'Imported project',
        devices: normalizeDevices(parsed)
      };
    } else {
      project = {
        projectName: parsed.projectName || 'Imported project',
        devices: normalizeDevices(parsed.devices || [])
      };
    }

    devices = project.devices;
    selectedDeviceId = devices[0]?.id || null;
    selectedPortNumber = null;
    selectedPortKind = null;

    render();
  } catch (error) {
    alert('Error importing JSON: ' + error.message);
  }
}

function openImportPicker(mode) {
  const input = document.querySelector('#fileImportInput');

  importMode = mode;
  input.value = '';
  input.accept = mode === 'json' ? '.json,application/json' : '.csv,text/csv';
  input.click();
}

function closeMenus() {
  document.querySelectorAll('.menu.open').forEach(menu => {
    menu.classList.remove('open');
  });
}

document.querySelector('#projectNameInput').addEventListener('input', event => {
  project.projectName = event.target.value.trim() || 'Unnamed project';
  save();
  renderProjectName();
  renderPrintReport();
});

document.querySelector('#deviceTypeSelect').addEventListener('change', renderDeviceTypeField);

document.querySelector('#deviceForm').addEventListener('submit', event => {
  event.preventDefault();

  const data = Object.fromEntries(new FormData(event.target).entries());

  const wanCount = Number(data.wanPorts || 0);
  const lanCount = Number(data.lanPorts || 0);

  if (lanCount <= 0) {
    alert('You must add at least one LAN port.');
    return;
  }

  const selectedType = data.type;
  const customType = data.customType?.trim();
  const finalType = selectedType === 'Other' ? customType : selectedType;

  if (!finalType) {
    alert('You must specify the device type.');
    return;
  }

  const device = {
    id: crypto.randomUUID(),
    name: data.model.trim(),
    type: finalType,
    location: data.location.trim(),
    ports: makeMixedPorts(wanCount, lanCount)
  };

  devices.push(device);
  selectedDeviceId = device.id;
  selectedPortNumber = null;
  selectedPortKind = null;

  event.target.reset();
  render();
});

document.querySelector('#portForm').addEventListener('submit', event => {
  event.preventDefault();

  const port = currentPort();

  if (!port) {
    return;
  }

  const data = Object.fromEntries(new FormData(event.target).entries());

  port.number = Number(data.number);
  port.status = normalizeStatus(data.status);
  port.connectionType = data.connectionType.trim();
  port.connectedTo = data.connectedTo.trim();
  port.vlan = data.vlan.trim();
  port.address = data.address.trim();
  port.notes = data.notes.trim();

  render();
});

document.querySelector('#clearAllBtn').onclick = clearAllDevices;

document.querySelector('#exportJsonBtn').onclick = () => {
  closeMenus();
  exportJson();
};

document.querySelector('#exportCsvBtn').onclick = () => {
  closeMenus();
  exportCsv();
};

document.querySelector('#importJsonBtn').onclick = () => {
  closeMenus();
  openImportPicker('json');
};

document.querySelector('#importCsvBtn').onclick = () => {
  closeMenus();
  openImportPicker('csv');
};

document.querySelector('#fileImportInput').addEventListener('change', event => {
  const file = event.target.files[0];

  if (!file || !importMode) {
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    const content = String(reader.result || '');

    if (importMode === 'json') {
      importJsonContent(content);
    }

    if (importMode === 'csv') {
      importCsvContent(content);
    }

    importMode = null;
  };

  reader.readAsText(file);
});

document.querySelector('#printBtn').onclick = () => {
  renderPrintReport();
  window.print();
};

document.querySelectorAll('.menu-btn').forEach(button => {
  button.addEventListener('click', event => {
    event.stopPropagation();

    const menu = button.closest('.menu');
    const isOpen = menu.classList.contains('open');

    closeMenus();

    if (!isOpen) {
      menu.classList.add('open');
    }
  });
});

document.addEventListener('click', closeMenus);

window.addEventListener('beforeunload', event => {
  event.preventDefault();

  event.returnValue =
    'Are you sure you want to leave? It is recommended to export your project first to make sure your changes are saved.';
});

render();