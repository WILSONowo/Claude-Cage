import React, { Children, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSelectPopup } from "./select-popup";
import { SearchField } from "./search-field";
import { Check, ChevronDown } from "lucide-react";
import "./inline-select.css";

// Keep keyboard focus on the control; the popup does not change page layout.
export function InlineSelect({
  children,
  value,
  onValueChange,
  disabled,
  editable = false,
  filterable = true,
  displayLabel,
  ...props
}) {
  const id = useId();
  const root = useRef(null);
  const control = useRef(null);
  const list = useRef(null);
  const [open, setOpen] = useState(false);
  const filterInput = useRef(null);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(null);
  const options = Children.toArray(children).flatMap((child) => {
    const group = child.type === "optgroup" ? child.props.label : null;
    return (group ? Children.toArray(child.props.children) : [child]).map(
      ({ props: option }) => ({
        value: String(option.value),
        label:
          Children.toArray(option.children).join("") || String(option.value),
        disabled: option.disabled || (group && child.props.disabled),
        group,
      }),
    );
  });
  const selected = options.find((option) => option.value === String(value));
  const searchable = filterable && !editable && options.length >= 10;
  const needle = open ? filter.trim().toLocaleLowerCase() : "";
  const filtered = needle ? options.filter(item =>
    [item.label, item.value, item.group].some(text => text?.toLocaleLowerCase().includes(needle))) : options;
  const visible = open && !disabled;
  const active = filtered.findIndex(
    (item) => item.value === cursor && !item.disabled,
  );
  const position = useSelectPopup(visible, control, list, filtered.length);
  useEffect(() => {
    if (visible && active >= 0) {
      const row = list.current.querySelector(`[data-index="${active}"]`);
      row?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [visible, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current.contains(event.target) && !list.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("click", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      document.removeEventListener("click", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  }, [open]);
  const show = () => {
    setFilter(editable && !selected ? String(value ?? "") : "");
    setCursor(selected?.value ?? null);
    setOpen(true);
    if (searchable) requestAnimationFrame(() => filterInput.current?.focus({ preventScroll: true }));
  };
  const choose = (item) => {
    if (item.disabled) return;
    control.current.focus();
    setOpen(false);
    onValueChange(item.value);
  };
  const keydown = (event) => {
    const key = event.key;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const typing = event.currentTarget === filterInput.current;
    if (typing && ["Home", "End", " "].includes(key)) return;
    if (key === "Tab") {
      if (typing && !event.defaultPrevented) control.current.focus({ preventScroll: true });
      setOpen(false);
    } else if (key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      control.current.focus({ preventScroll: true });
      setOpen(false);
    } else if (key === "Enter" || (!editable && key === " ")) {
      if (editable && !visible) return;
      event.preventDefault();
      if (!visible) show();
      else if (active >= 0) choose(filtered[active]);
      else if (typing && filtered.some(item => !item.disabled)) choose(filtered.find(item => !item.disabled));
      else setOpen(false);
    } else if (
      ["ArrowUp", "ArrowDown"].includes(key) ||
      (!editable && ["Home", "End"].includes(key))
    ) {
      event.preventDefault();
      const enabled = filtered.filter((item) => !item.disabled);
      const index = enabled.findIndex((item) => item.value === cursor);
      let next =
        key === "Home"
          ? 0
          : key === "End"
            ? enabled.length - 1
            : Math.min(
                enabled.length - 1,
                Math.max(0, index + (key === "ArrowUp" ? -1 : 1)),
              );
      if (!visible && selected && key.startsWith("Arrow"))
        next = enabled.indexOf(selected);
      setCursor(enabled[next]?.value ?? null);
      if (!visible) setFilter("");
      setOpen(true);
    } else if (searchable && !typing && key.length === 1 && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      setFilter(key);
      setCursor(null);
      setOpen(true);
      requestAnimationFrame(() => filterInput.current?.focus());
    }
  };
  const common = {
    ...props,
    ref: control,
    disabled,
    role: "combobox",
    "aria-haspopup": "listbox",
    "aria-expanded": visible,
    "aria-controls": visible ? id : undefined,
    "aria-activedescendant":
      visible && active >= 0 ? id + "-" + active : undefined,
    onKeyDown: keydown,
  };
  return (
    <span ref={root} className="inline-select">
      {editable ? (
        <input
          {...common}
          aria-autocomplete="list"
          autoComplete="off"
          value={value}
          onClick={() => { if (!visible) show(); }}
          onChange={(event) => {
            onValueChange(event.target.value);
            setFilter(event.target.value);
            setCursor(null);
            setOpen(true);
          }}
        />
      ) : (
        <button
          {...common}
          type="button"
          value={value}
          className="inline-select-trigger"
          onClick={() => {
            control.current.focus();
            open ? setOpen(false) : show();
          }}
        >
          <span>{displayLabel ?? selected?.label ?? value}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      {visible && createPortal(
        <span ref={list} className="select-surface" style={position}>
          {searchable && <SearchField inputRef={filterInput} label="搜索选项" placeholder="搜索选项"
            value={filter} onValueChange={next => { setFilter(next); setCursor(null); }}
            role="combobox" aria-expanded={visible} aria-controls={id} aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? id + "-" + active : undefined}
            onKeyDown={keydown} />}
          <span id={id} role="listbox" aria-label={(props["aria-label"] || "") + "选项"}
            className="inline-select-list" onMouseDown={event => event.preventDefault()}
            onClick={event => event.preventDefault()}>
          {filtered.map((item, index) => (
            <React.Fragment key={item.value}>
              {item.group && item.group !== filtered[index - 1]?.group && (
                <span className="inline-select-group" aria-hidden="true">
                  {item.group}
                </span>
              )}
              <span
                role="option"
                id={id + "-" + index}
                data-index={index}
                data-value={item.value}
                data-active={index === active || undefined}
                aria-disabled={Boolean(item.disabled)}
                aria-selected={item === selected}
                onClick={() => choose(item)}
              >
                <span>
                  {editable && item.label !== item.value
                    ? item.value + " · "
                    : ""}
                  {item.label}
                </span>
                {item === selected && <Check size={14} aria-hidden="true" />}
              </span>
            </React.Fragment>
          ))}
          </span>
          {!filtered.length && <span className="select-empty" role="status">{needle ? "没有匹配的选项" : "暂无选项"}</span>}
        </span>, document.body
      )}
    </span>
  );
}
