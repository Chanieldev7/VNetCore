/* Calendar popover for the review date. Native date pickers cannot be styled,
   so the calendar button opens this one instead; typing a date in the native
   field still works. Keyboard support follows the WAI-ARIA date picker dialog
   pattern: arrows move by day or week, Home/End to the start or end of the
   week, Page Up/Down by month (with Shift, by year), Enter selects, Escape
   closes and returns focus to the calendar button. */
(function datePicker() {
  "use strict";

  const toggle = document.querySelector("#reviewDatePickerBtn");
  const input = document.querySelector("#projectReviewDateInput");
  const picker = document.querySelector("#datePicker");
  if (!toggle || !input || !picker) return;

  const title = picker.querySelector("#datePickerTitle");
  const body = picker.querySelector("tbody");
  const monthFormat = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  });
  const dayFormat = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const GAP = 6;
  const EDGE = 8;

  let viewYear = 0;
  let viewMonth = 0;
  let focusDate = null;

  // Dates are local calendar days built from year/month/day, never parsed
  // from strings by the Date constructor, so time zones cannot shift them.
  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function parseIso(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return null;
    const date = new Date(+match[1], +match[2] - 1, +match[3]);
    return date.getMonth() === +match[2] - 1 ? date : null;
  }

  function toIso(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function sameDay(first, second) {
    return Boolean(first && second) && first.getTime() === second.getTime();
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  // Keeps the day when possible: Jan 31 + 1 month is Feb 28 (or 29).
  function addMonths(date, months) {
    const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(
      target.getFullYear(),
      target.getMonth() + 1,
      0,
    ).getDate();
    return new Date(
      target.getFullYear(),
      target.getMonth(),
      Math.min(date.getDate(), lastDay),
    );
  }

  function render() {
    title.textContent = monthFormat.format(new Date(viewYear, viewMonth, 1));
    const selected = parseIso(input.value);
    const today = startOfToday();
    const first = new Date(viewYear, viewMonth, 1);
    const start = addDays(first, -first.getDay());
    body.replaceChildren();
    // Always six weeks, so the popover keeps one height across months.
    for (let week = 0; week < 6; week++) {
      const row = document.createElement("tr");
      for (let weekday = 0; weekday < 7; weekday++) {
        const date = addDays(start, week * 7 + weekday);
        const cell = document.createElement("td");
        const button = document.createElement("button");
        const isSelected = sameDay(date, selected);
        const isToday = sameDay(date, today);
        button.type = "button";
        button.className = "date-picker-day";
        button.textContent = String(date.getDate());
        button.dataset.date = toIso(date);
        button.tabIndex = sameDay(date, focusDate) ? 0 : -1;
        button.setAttribute(
          "aria-label",
          `${dayFormat.format(date)}${isToday ? ", today" : ""}`,
        );
        button.classList.toggle("is-outside", date.getMonth() !== viewMonth);
        button.classList.toggle("is-selected", isSelected);
        button.classList.toggle("is-today", isToday);
        if (isToday) button.setAttribute("aria-current", "date");
        cell.setAttribute("aria-selected", String(isSelected));
        cell.appendChild(button);
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
  }

  function focusDay(date) {
    focusDate = date;
    viewYear = date.getFullYear();
    viewMonth = date.getMonth();
    render();
    body.querySelector('[tabindex="0"]')?.focus();
  }

  function position() {
    const anchor = input.getBoundingClientRect();
    const width = picker.offsetWidth;
    const height = picker.offsetHeight;
    const left = Math.max(
      EDGE,
      Math.min(anchor.left, window.innerWidth - width - EDGE),
    );
    let top = anchor.bottom + GAP;
    // Open upwards when there is no room below but there is room above.
    if (
      top + height > window.innerHeight - EDGE &&
      anchor.top - height - GAP > EDGE
    ) {
      top = anchor.top - height - GAP;
    }
    picker.style.left = `${Math.round(left)}px`;
    picker.style.top = `${Math.round(top)}px`;
  }

  function isOpen() {
    return !picker.hidden;
  }

  function open() {
    const selected = parseIso(input.value);
    focusDate = selected || startOfToday();
    viewYear = focusDate.getFullYear();
    viewMonth = focusDate.getMonth();
    render();
    picker.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    position();
    body.querySelector('[tabindex="0"]')?.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    picker.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) toggle.focus();
  }

  // Writes the value the same way typing does, so the app saves it as usual.
  function choose(date) {
    input.value = date ? toIso(date) : "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  }

  toggle.addEventListener("click", () => {
    if (isOpen()) close();
    else open();
  });

  picker.addEventListener("click", (event) => {
    const day = event.target.closest(".date-picker-day");
    if (day) {
      choose(parseIso(day.dataset.date));
      return;
    }
    const nav = event.target.closest("[data-step]");
    if (nav) {
      focusDate = addMonths(focusDate, Number(nav.dataset.step));
      viewYear = focusDate.getFullYear();
      viewMonth = focusDate.getMonth();
      render();
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "today") choose(startOfToday());
    if (action === "clear") choose(null);
  });

  body.addEventListener("keydown", (event) => {
    const moves = {
      ArrowLeft: () => addDays(focusDate, -1),
      ArrowRight: () => addDays(focusDate, 1),
      ArrowUp: () => addDays(focusDate, -7),
      ArrowDown: () => addDays(focusDate, 7),
      Home: () => addDays(focusDate, -focusDate.getDay()),
      End: () => addDays(focusDate, 6 - focusDate.getDay()),
      PageUp: () => addMonths(focusDate, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focusDate, event.shiftKey ? 12 : 1),
    };
    if (!moves[event.key]) return;
    event.preventDefault();
    focusDay(moves[event.key]());
  });

  picker.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  // Close when focus moves elsewhere. A null relatedTarget happens while the
  // grid re-renders, and outside clicks are handled by pointerdown below.
  picker.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next && !picker.contains(next) && next !== toggle) {
      close({ restoreFocus: false });
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (
      isOpen() &&
      !picker.contains(event.target) &&
      !toggle.contains(event.target)
    ) {
      close({ restoreFocus: false });
    }
  });

  window.addEventListener("resize", () => {
    if (isOpen()) position();
  });
  // Capture scrolls from the side panel as well as the page.
  document.addEventListener(
    "scroll",
    () => {
      if (isOpen()) position();
    },
    true,
  );
})();
