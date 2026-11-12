import { useLayoutEffect, useState } from "react";

// Both desktop and mobile mount the list outside scroll/overflow containers.
export function useSelectPopup(visible, control, list, count, fitLabels = false) {
  const [position, setPosition] = useState(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      if (!control.current || !list.current) return;
      const rect = control.current.getBoundingClientRect();
      const style = getComputedStyle(control.current);
      const gap = 4, margin = 8;
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
      const right = x + (viewport?.width || window.innerWidth);
      const bottom = y + (viewport?.height || window.innerHeight);
      const below = bottom - rect.bottom - gap - margin, above = rect.top - y - gap - margin;
      const availableWidth = Math.max(1, right - x - 2 * margin);
      const desktop = fitLabels || list.current.classList.contains("select-surface");
      const minimum = Math.min(Math.max(rect.width, 152), availableWidth);
      if (desktop) {
        // Size the list to its labels first, then position the measured box at the anchor.
        list.current.style.minWidth = minimum + "px";
        list.current.style.maxWidth = Math.min(availableWidth, Math.max(rect.width, 32 * parseFloat(style.fontSize))) + "px";
      }
      const width = desktop ? list.current.getBoundingClientRect().width : minimum;
      const rows = list.current.querySelector('[role="listbox"]');
      const contents = list.current.scrollHeight + (rows ? Math.max(0, rows.scrollHeight - rows.clientHeight) : 0) + 2;
      const upward = below < Math.min(contents, 240) && above > below;
      const maxHeight = Math.max(0, Math.min(300, upward ? above : below));
      const height = Math.min(contents, maxHeight);
      const next = { position: "fixed", zIndex: 10000, boxSizing: "border-box", margin: 0,
        left: Math.max(x + margin, Math.min(rect.left, right - width - margin)),
        top: upward ? Math.max(y + margin, rect.top - gap - height) : rect.bottom + gap,
        width: desktop ? "max-content" : width, maxHeight, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
      for (const key of ["--ink", "--paper", "--input", "--hover", "--strong", "--line", "--selected", "--focus", "--muted", "--control-cursor"]) next[key] = style.getPropertyValue(key);
      setPosition(old => old && Object.keys(next).every(key => old[key] === next[key]) ? old : next);
    };
    const scroll = event => { if (!list.current?.contains(event.target)) place(); };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(control.current);
    observer.observe(list.current);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", scroll, true);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place); document.removeEventListener("scroll", scroll, true);
    };
  }, [visible, control, list, count, fitLabels]);
  return position || { position: "fixed", width: "max-content", visibility: "hidden" };
}
