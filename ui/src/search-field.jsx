import React, { useRef } from "react";
import { Search, X } from "lucide-react";
import "./search-field.css";

export function SearchField({ label, value, onValueChange, inputRef, className = "", placeholder = label,
  disabled, onKeyDown, type = "text", ...inputProps }) {
  const ownRef = useRef(null);
  const field = inputRef || ownRef;
  const clear = () => {
    onValueChange("");
    field.current?.focus({ preventScroll: true });
  };
  return <span className={"search-field " + className}>
    <Search size={15} aria-hidden="true" />
    <input {...inputProps} ref={field} type={type} inputMode="search" autoComplete="off" spellCheck={false}
      aria-label={label} placeholder={placeholder} value={value} disabled={disabled}
      onChange={event => onValueChange(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Escape" || event.key === "Enter") event.stopPropagation();
          return;
        }
        if (event.key === "Escape" && value) {
          event.preventDefault(); event.stopPropagation(); clear();
        } else onKeyDown?.(event);
      }} />
    {value && <button type="button" className="search-clear" disabled={disabled} aria-label={"清除" + label}
      title="清除搜索" onMouseDown={event => event.preventDefault()} onClick={clear}><X size={14} aria-hidden="true" /></button>}
  </span>;
}
