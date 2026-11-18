import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Toaster, toast } from "sonner";
import "sonner/dist/styles.css";

const container = document.querySelector("#toastRoot");
const root = createRoot(container);
const activeSlots = new Map();
const titles = {
  success: "Changes saved",
  error: "Action needs attention",
  warning: "Please review",
  info: "Project update",
};

function StatusIcon({ type }) {
  const paths = {
    success: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    error: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>,
    warning: <><path d="m12 3 10 17H2L12 3Z" /><path d="M12 9v4m0 3h.01" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[type]}</svg>;
}

function dismissSlot(slot) {
  const id = activeSlots.get(slot);
  if (id !== undefined) {
    activeSlots.delete(slot);
    toast.dismiss(id);
  }
}

function NotificationCard({ id, slot, message, type, title, actions }) {
  const close = () => {
    if (activeSlots.get(slot) === id) dismissSlot(slot);
  };
  return (
    <div className="vnet-toast" data-kind={type}>
      <span className="vnet-toast-icon"><StatusIcon type={type} /></span>
      <div className="vnet-toast-content">
        <strong>{title || titles[type]}</strong>
        <p>{message}</p>
        {actions.length > 0 && <div className="vnet-toast-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                if (activeSlots.get(slot) !== id) return;
                close();
                action.onClick();
              }}
            >{action.label}</button>
          ))}
        </div>}
      </div>
      <button className="vnet-toast-close" type="button" aria-label="Dismiss notification" onClick={close}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

function setTheme(theme) {
  flushSync(() => root.render(
    <Toaster
      theme={theme === "light" ? "light" : "dark"}
      position="bottom-right"
      visibleToasts={3}
      expand
      duration={6500}
      offset={{ bottom: "max(24px, env(safe-area-inset-bottom))", right: "max(24px, env(safe-area-inset-right))" }}
      mobileOffset={{ bottom: "max(12px, env(safe-area-inset-bottom))", left: 12, right: 12 }}
      containerAriaLabel="Project notifications"
      toastOptions={{ className: "vnet-toast-shell" }}
    />,
  ));
}

setTheme(document.documentElement.dataset.theme);

window.VNetCoreNotifications = {
  setTheme,
  dismiss: dismissSlot,
  show(message, options = {}) {
    const slot = options.slot || "operation";
    const type = Object.hasOwn(titles, options.type) ? options.type : "success";
    dismissSlot(slot);
    const clearSlot = ({ id }) => {
      if (activeSlots.get(slot) === id) activeSlots.delete(slot);
    };
    const id = toast.custom((id) => (
      <NotificationCard
        id={id}
        slot={slot}
        message={message}
        type={type}
        title={options.title}
        actions={options.actions || []}
      />
    ), {
      duration: options.persistent ? Infinity : options.duration || 6500,
      onDismiss: clearSlot,
      onAutoClose: clearSlot,
      testId: `notification-${type}`,
    });
    activeSlots.set(slot, id);
    return id;
  },
};
