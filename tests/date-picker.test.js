const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");

function openApp(t, reviewDate = "2026-03-15") {
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
  window.localStorage.setItem(
    "vnetcore.project.v9",
    JSON.stringify({ projectName: "Dates", reviewDate, devices: [] }),
  );
  ["core.js", "app.js", "date-picker.js"].forEach((file) =>
    window.eval(fs.readFileSync(path.join(root, file), "utf8")),
  );
  const document = window.document;
  const key = (value, options = {}) =>
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  const stored = () =>
    JSON.parse(window.localStorage.getItem("vnetcore.project.v9"));
  return {
    window,
    document,
    key,
    stored,
    toggle: document.querySelector("#reviewDatePickerBtn"),
    picker: document.querySelector("#datePicker"),
    title: () => document.querySelector("#datePickerTitle").textContent,
  };
}

test("the calendar button opens the custom picker on the saved date", (t) => {
  const { document, toggle, picker, title } = openApp(t);
  assert.equal(picker.hidden, true);
  toggle.click();
  assert.equal(picker.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(title(), "March 2026");
  assert.equal(document.activeElement.dataset.date, "2026-03-15");
  assert.equal(
    document.activeElement.getAttribute("aria-label"),
    "Sunday, March 15, 2026",
  );
  assert.equal(
    document.activeElement.closest("td").getAttribute("aria-selected"),
    "true",
  );
  assert.equal(picker.querySelectorAll(".date-picker-day").length, 42);
  assert.equal(picker.querySelectorAll('[tabindex="0"]').length, 1);
});

test("arrow, Home/End and Page keys move the focused day", (t) => {
  const { document, key, toggle, title } = openApp(t);
  toggle.click();
  key("ArrowRight");
  assert.equal(document.activeElement.dataset.date, "2026-03-16");
  key("ArrowDown");
  assert.equal(document.activeElement.dataset.date, "2026-03-23");
  key("Home");
  assert.equal(document.activeElement.dataset.date, "2026-03-22");
  key("End");
  assert.equal(document.activeElement.dataset.date, "2026-03-28");
  key("PageDown");
  assert.equal(title(), "April 2026");
  assert.equal(document.activeElement.dataset.date, "2026-04-28");
  key("PageUp", { shiftKey: true });
  assert.equal(title(), "April 2025");
});

test("months keep a valid day when the next month is shorter", (t) => {
  const { document, key, toggle } = openApp(t, "2026-01-31");
  toggle.click();
  key("PageDown");
  assert.equal(document.activeElement.dataset.date, "2026-02-28");
});

test("choosing a day saves the review date and returns focus to the button", (t) => {
  const { document, toggle, picker, stored } = openApp(t);
  toggle.click();
  Array.from(picker.querySelectorAll(".date-picker-day"))
    .find((day) => day.dataset.date === "2026-03-20")
    .click();
  assert.equal(picker.hidden, true);
  assert.equal(
    document.querySelector("#projectReviewDateInput").value,
    "2026-03-20",
  );
  assert.equal(stored().reviewDate, "2026-03-20");
  assert.equal(document.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("Escape closes without changes and Clear removes the date", (t) => {
  const { key, toggle, picker, stored } = openApp(t);
  toggle.click();
  key("ArrowRight");
  key("Escape");
  assert.equal(picker.hidden, true);
  assert.equal(stored().reviewDate, "2026-03-15");
  toggle.click();
  picker.querySelector('[data-action="clear"]').click();
  assert.equal(stored().reviewDate, "");
});

test("previous and next buttons change the month shown", (t) => {
  const { toggle, picker, title } = openApp(t);
  toggle.click();
  picker.querySelector('[data-step="1"]').click();
  assert.equal(title(), "April 2026");
  picker.querySelector('[data-step="-1"]').click();
  picker.querySelector('[data-step="-1"]').click();
  assert.equal(title(), "February 2026");
});
