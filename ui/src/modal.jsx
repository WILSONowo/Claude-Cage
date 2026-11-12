import { X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const tabStops = 'input, button, select, textarea, a[href], [tabindex], [contenteditable="true"]';
const available = node => node.tabIndex >= 0 && !node.matches(":disabled") &&
  !node.closest("[inert]") && node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";

export function Modal({ title, children, onClose, wide = false, footer, anchor, className = "", style, headerActions, initialFocusRef }) {
  const panel = useRef(),
    closeRef = useRef(onClose);
  // React focuses autoFocus children during commit, before layout effects run.
  const [opener] = useState(() => anchor || document.activeElement);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!anchor) return;
    const node = panel.current;
    anchor.setAttribute("aria-expanded", "true");
    const position = () => {
      if (!anchor.isConnected) {
        closeRef.current?.();
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8));
      const below = rect.bottom + 6;
      const top = below + box.height <= window.innerHeight - 8
        ? below : Math.max(8, rect.top - box.height - 6);
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(node);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      // Hover actions stay visible while expanded. Restore focus before
      // removing that state so keyboard users can continue on the same row.
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
      anchor.removeAttribute("aria-expanded");
      observer.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [anchor]);
  useEffect(() => {
    const first = initialFocusRef?.current || (panel.current.contains(document.activeElement)
      ? document.activeElement : [...panel.current.querySelectorAll(tabStops)].find(available));
    (first || panel.current).focus({ preventScroll: true });
    const key = (e) => {
      if (
        [...document.querySelectorAll('[role="dialog"]')].at(-1) !==
        panel.current
      )
        return;
      if (e.key === "Escape") {
        if (e.isComposing || e.keyCode === 229 || (e.target.closest(".search-field") && e.target.value)) return;
        if (e.target.closest('[role="combobox"][aria-expanded="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current?.();
      }
      if (e.key === "Tab") {
        const nodes = [...panel.current.querySelectorAll(tabStops)].filter(available);
        if (!nodes.length) { e.preventDefault(); return; }
        const popup = e.target.closest(".select-surface");
        if (popup) {
          // A floating select lives under body. Tab follows its trigger in the dialog.
          const listId = popup.querySelector('[role="listbox"]')?.id;
          const trigger = nodes.findIndex(node => node.getAttribute("aria-controls") === listId);
          if (trigger >= 0) {
            e.preventDefault();
            nodes[(trigger + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus();
            return;
          }
        }
        const index = nodes.indexOf(document.activeElement);
        if (e.shiftKey && index <= 0) {
          e.preventDefault();
          nodes.at(-1).focus();
        } else if (!e.shiftKey && (index === nodes.length - 1 || index < 0)) {
          e.preventDefault();
          nodes[0].focus();
        }
      }
    };
    const closeEvent = () => {
      if (
        [...document.querySelectorAll('[role="dialog"]')].at(-1) ===
        panel.current
      )
        closeRef.current?.();
    };
    document.addEventListener("cage-close-modal", closeEvent);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("cage-close-modal", closeEvent);
      if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className={`modal-scrim${anchor ? " anchored-modal-scrim" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <section
        ref={panel}
        className={`modal ${wide ? "wide" : ""} ${className}`}
        style={style}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          {headerActions}
          {onClose && (
            <button
              className="icon-button close-modal"
              aria-label="关闭面板"
              onClick={onClose}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </header>
        {children}
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}
