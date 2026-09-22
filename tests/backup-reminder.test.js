const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const KEY = "vnetcore.backup-reminder.v1";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function openApp(t, { now = START, stored, unavailable = false } = {}) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "index.html"), "utf8"),
    { url: "https://vnetcore.test/", runScripts: "outside-only" },
  );
  const { window } = dom;
  t.after(() => window.close());
  window.Date.now = () => now;
  if (stored !== undefined) window.localStorage.setItem(KEY, stored);
  if (unavailable) {
    window.Storage.prototype.getItem = () => {
      throw new Error("Storage blocked");
    };
    window.Storage.prototype.setItem = () => {
      throw new Error("Storage blocked");
    };
  }
  const downloads = [];
  window.URL.createObjectURL = () => "blob:test-backup";
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download);
  };
  for (const file of ["core.js", "app.js"]) {
    window.eval(fs.readFileSync(path.join(root, file), "utf8"));
  }
  return {
    window,
    document: window.document,
    notice: window.document.querySelector("#backupNotice"),
    downloads,
    stored: () => window.localStorage.getItem(KEY),
    advanceTo(time) {
      now = time;
      window.dispatchEvent(new window.Event("focus"));
    },
  };
}

test("first access shows information once and dismissal restores focus", (t) => {
  const app = openApp(t);
  assert.equal(app.notice.hidden, false);
  assert.equal(app.notice.dataset.level, "info");
  assert.doesNotMatch(
    app.document.querySelector("footer").textContent,
    /Data stays/,
  );
  const close = app.document.querySelector("#backupNoticeDismissBtn");
  close.focus();
  close.click();
  assert.equal(app.notice.hidden, true);
  assert.equal(app.document.activeElement.id, "exportMenuBtn");
  const reopened = openApp(t, { stored: app.stored() });
  assert.equal(reopened.notice.hidden, true);
  assert.equal(JSON.parse(reopened.stored()).firstSeenAt, START);
});

test("reminders switch exactly at seven and thirty days without exports", (t) => {
  const first = openApp(t);
  const app = openApp(t, { stored: first.stored(), now: START + 7 * DAY - 1 });
  assert.equal(app.notice.hidden, true);
  app.advanceTo(START + 7 * DAY);
  assert.equal(app.notice.hidden, false);
  assert.equal(app.notice.dataset.level, "reminder");
  app.advanceTo(START + 30 * DAY - 1);
  assert.equal(app.notice.dataset.level, "reminder");
  app.advanceTo(START + 30 * DAY);
  assert.equal(app.notice.dataset.level, "overdue");
  assert.match(app.notice.textContent, /30 days since your first visit/);
});

test("dismissal lasts 24 hours across reloads but cannot suppress escalation", (t) => {
  const first = openApp(t);
  const app = openApp(t, { stored: first.stored(), now: START + 29.5 * DAY });
  app.document.querySelector("#backupNoticeDismissBtn").click();
  const reopened = openApp(t, {
    stored: app.stored(),
    now: START + 29.75 * DAY,
  });
  assert.equal(reopened.notice.hidden, true);
  reopened.advanceTo(START + 30 * DAY);
  assert.equal(reopened.notice.hidden, false);
  assert.equal(reopened.notice.dataset.level, "overdue");
  reopened.document.querySelector("#backupNoticeDismissBtn").click();
  reopened.advanceTo(START + 31 * DAY - 1);
  assert.equal(reopened.notice.hidden, true);
  reopened.advanceTo(START + 31 * DAY);
  assert.equal(reopened.notice.hidden, false);
});

for (const button of [
  "backupNoticeExportBtn",
  "exportJsonBtn",
  "exportCsvBtn",
]) {
  test(`${button} downloads a backup and restarts the persisted clock`, (t) => {
    const first = openApp(t);
    const exportedAt = START + 40 * DAY;
    const app = openApp(t, { stored: first.stored(), now: exportedAt });
    app.document.querySelector(`#${button}`).click();
    assert.equal(app.downloads.length, 1);
    assert.match(
      app.downloads[0],
      button === "exportCsvBtn" ? /\.csv$/ : /\.json$/,
    );
    assert.equal(app.notice.hidden, true);
    assert.equal(JSON.parse(app.stored()).lastExportAt, exportedAt);
    const reopened = openApp(t, {
      stored: app.stored(),
      now: exportedAt + 7 * DAY - 1,
    });
    assert.equal(reopened.notice.hidden, true);
    reopened.advanceTo(exportedAt + 7 * DAY);
    assert.equal(reopened.notice.dataset.level, "reminder");
    assert.match(reopened.notice.textContent, /7 days since your last export/);
    reopened.advanceTo(exportedAt + 30 * DAY);
    assert.equal(reopened.notice.dataset.level, "overdue");
  });
}

test("failed downloads and local autosaves do not reset the export clock", (t) => {
  const app = openApp(t);
  app.advanceTo(START + 30 * DAY);
  app.window.URL.createObjectURL = () => {
    throw new Error("Download failed");
  };
  let downloadError;
  app.window.addEventListener("error", (event) => {
    downloadError = event.error;
    event.preventDefault();
  });
  app.document.querySelector("#exportJsonBtn").click();
  assert.match(downloadError.message, /Download failed/);
  const form = app.document.querySelector("#deviceForm");
  form.elements.model.value = "Test switch";
  form.dispatchEvent(
    new app.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.equal(app.document.querySelectorAll(".device-item").length, 1);
  assert.equal(JSON.parse(app.stored()).lastExportAt, null);
  assert.equal(app.notice.hidden, false);
  assert.equal(app.notice.dataset.level, "overdue");
});

test("invalid or blocked reminder storage does not prevent startup or export", (t) => {
  for (const options of [{ stored: "broken json" }, { unavailable: true }]) {
    const app = openApp(t, options);
    assert.equal(app.notice.dataset.level, "info");
    app.document.querySelector("#backupNoticeExportBtn").click();
    assert.equal(app.downloads.length, 1);
    assert.equal(app.notice.hidden, true);
  }
});

test("an export in another tab clears the reminder", (t) => {
  const first = openApp(t);
  const app = openApp(t, { stored: first.stored(), now: START + 40 * DAY });
  const state = JSON.parse(app.stored());
  state.lastExportAt = START + 40 * DAY;
  app.window.localStorage.setItem(KEY, JSON.stringify(state));
  app.window.dispatchEvent(
    new app.window.StorageEvent("storage", { key: KEY }),
  );
  assert.equal(app.notice.hidden, true);
});
