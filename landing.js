/* Makes the hero switch on the landing page clickable: each port shows what
   is documented on it. Without this script the page still shows port 17. */
(function landing() {
  "use strict";

  const STATUS = {
    a: "Active",
    n: "No link",
    v: "Available",
    u: "Unknown device",
  };

  // [status, VLAN, goes to, IP, notes] for LAN 1–24, then WAN 1–2.
  const LAN = [
    ["a", "1 · Native", "core-sw-01 / LAN 24", "", "Uplink, keep tagged"],
    ["a", "10 · Staff", "Reception PC", "10.10.0.21", ""],
    ["n", "", "", "", "Cable runs to desk 3, nothing plugged in"],
    ["a", "30 · Voice", "Phone · Reception", "10.30.0.12", "PoE"],
    ["v", "", "", "", ""],
    ["v", "", "", "", ""],
    ["a", "10 · Staff", "Office 2 · PC", "10.10.0.27", ""],
    ["a", "10 · Staff", "Printer · Hall", "10.10.0.50", "Static IP"],
    ["a", "10 · Staff", "AP Lobby", "10.10.0.5", "PoE, ceiling mount"],
    ["u", "", "Unknown", "", "MAC 3C:52:82:1A:0F:7E, ask who owns it"],
    ["v", "", "", "", ""],
    ["a", "10 · Staff", "Office 3 · PC", "10.10.0.33", ""],
    ["a", "30 · Voice", "Phone · Office 3", "10.30.0.18", "PoE"],
    ["n", "", "", "", "Wall jack B-14, link lost after move"],
    ["a", "20 · Cameras", "cam-parking-01", "10.20.0.40", "Outdoor, PoE+"],
    ["v", "", "", "", ""],
    [
      "a",
      "20 · Cameras",
      "cam-lobby-01 / eth0",
      "10.20.0.41",
      "Ceiling, blue patch cable",
    ],
    ["a", "20 · Cameras", "cam-hall-02", "10.20.0.42", ""],
    ["v", "", "", "", ""],
    ["v", "", "", "", ""],
    ["a", "10 · Staff", "AP Meeting room", "10.10.0.6", "PoE"],
    ["n", "", "", "", "Spare run to storage room"],
    ["v", "", "", "", ""],
    ["a", "20 · Cameras", "NVR", "10.20.0.2", "Recorder, do not unplug"],
  ];
  const WAN = [
    ["a", "Trunk", "core-sw-01 / LAN 1", "", "Fiber uplink"],
    ["v", "", "", "", "Spare SFP slot"],
  ];

  const portsBox = document.querySelector("[data-ports]");
  const uplinksBox = document.querySelector("[data-uplinks]");
  const card = document.querySelector("[data-card]");
  const hint = document.querySelector("[data-hint]");
  if (!portsBox || !uplinksBox || !card) return;

  const field = (name) => card.querySelector(`[data-field="${name}"]`);
  const fields = {
    title: field("title"),
    status: field("status"),
    vlan: field("vlan"),
    to: field("to"),
    ip: field("ip"),
    notes: field("notes"),
  };

  const ports = [
    ...LAN.map((data, i) => ({ label: `Port ${i + 1}`, data })),
    ...WAN.map((data, i) => ({ label: `Uplink ${i + 1}`, data })),
  ];
  const buttons = [];

  function show(index, focus) {
    const { label, data } = ports[index];
    const [status, vlan, to, ip, notes] = data;
    fields.title.textContent = label;
    fields.status.textContent = STATUS[status];
    fields.status.dataset.s = status;
    fields.vlan.textContent = vlan || "—";
    fields.to.textContent = to || "—";
    fields.ip.textContent = ip || "—";
    fields.notes.textContent = notes || "—";
    buttons.forEach((button, i) => {
      const selected = i === index;
      button.setAttribute("aria-pressed", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    if (focus) buttons[index].focus();
  }

  function makeButton(index) {
    const { label, data } = ports[index];
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.s = data[0];
    button.setAttribute("aria-label", `${label}, ${STATUS[data[0]]}`);
    button.addEventListener("click", () => show(index, false));
    buttons.push(button);
    return button;
  }

  portsBox.replaceChildren(...LAN.map((_, i) => makeButton(i)));
  uplinksBox.replaceChildren(...WAN.map((_, i) => makeButton(LAN.length + i)));

  // One tab stop for the whole switch; arrow keys move between ports.
  // The grid has 12 columns on wide screens and 6 on phones.
  const columns = () =>
    getComputedStyle(portsBox).gridTemplateColumns.split(" ").length || 12;
  function onKey(event) {
    const current = buttons.indexOf(document.activeElement);
    if (current < 0) return;
    const last = buttons.length - 1;
    const isUplink = current >= LAN.length;
    let next = null;
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(current + 1, last);
        break;
      case "ArrowLeft":
        next = Math.max(current - 1, 0);
        break;
      case "ArrowDown":
        next = isUplink
          ? Math.min(current + 1, last)
          : Math.min(current + columns(), LAN.length - 1);
        break;
      case "ArrowUp":
        next = isUplink
          ? Math.max(current - 1, LAN.length)
          : Math.max(current - columns(), 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    show(next, true);
  }

  const group = portsBox.closest(".faceplate");
  group.setAttribute("role", "group");
  group.setAttribute(
    "aria-label",
    "Ports of access-sw-02. Use the arrow keys to move between ports.",
  );
  group.addEventListener("keydown", onKey);
  portsBox.removeAttribute("aria-hidden");
  uplinksBox.removeAttribute("aria-hidden");
  if (hint) hint.hidden = false;

  show(16, false);
})();

/* Screenshot viewer: the screenshots are plain links to the images, so they
   still open without this script. With it, they open in a dialog that can
   switch between fit-to-screen and actual size. */
(function viewer() {
  "use strict";

  const dialog = document.querySelector("[data-viewer-dialog]");
  const links = [...document.querySelectorAll("a[data-viewer]")];
  if (!dialog || !links.length || typeof dialog.showModal !== "function") {
    return;
  }
  const title = dialog.querySelector("[data-viewer-title]");
  const stage = dialog.querySelector("[data-viewer-stage]");
  const img = document.createElement("img");
  img.alt = "";
  stage.append(img);
  const zoom = dialog.querySelector("[data-viewer-zoom]");
  let index = 0;
  let opener = null;

  // Screenshots were taken at 2x, so "actual size" is half the pixel width:
  // the size the interface has in the app.
  img.addEventListener("load", () =>
    img.style.setProperty("--natural", String(img.naturalWidth / 2)),
  );

  function setZoom(on) {
    dialog.classList.toggle("is-zoomed", on);
    zoom.setAttribute("aria-pressed", String(on));
    zoom.textContent = on ? "Fit to screen" : "Actual size";
  }

  function load(next) {
    index = (next + links.length) % links.length;
    const link = links[index];
    const source = link.querySelector("img");
    const caption = link.closest("figure")?.querySelector("figcaption");
    img.src = link.href;
    img.alt = source?.alt || "";
    title.textContent = caption
      ? caption.textContent.replace(/\s+/g, " ").trim()
      : "";
    stage.scrollTo(0, 0);
    setZoom(false);
  }

  links.forEach((link, i) =>
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      opener = link;
      load(i);
      dialog.showModal();
      dialog.querySelector("[data-viewer-close]").focus();
    }),
  );

  dialog
    .querySelector("[data-viewer-prev]")
    .addEventListener("click", () => load(index - 1));
  dialog
    .querySelector("[data-viewer-next]")
    .addEventListener("click", () => load(index + 1));
  dialog
    .querySelector("[data-viewer-close]")
    .addEventListener("click", () => dialog.close());
  zoom.addEventListener("click", () =>
    setZoom(!dialog.classList.contains("is-zoomed")),
  );
  img.addEventListener("click", () =>
    setZoom(!dialog.classList.contains("is-zoomed")),
  );

  // A click on the dark area around the image closes the viewer.
  stage.addEventListener("click", (event) => {
    if (event.target === stage) dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") load(index - 1);
    if (event.key === "ArrowRight") load(index + 1);
  });
  dialog.addEventListener("close", () => {
    img.removeAttribute("src");
    opener?.focus();
  });
})();
