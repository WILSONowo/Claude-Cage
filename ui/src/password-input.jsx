import React, { useEffect, useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import "./password-input.css";

export function PasswordInput({
  label,
  id,
  value,
  defaultValue,
  disabled,
  className = "",
  onChange,
  ...inputProps
}) {
  const fallbackID = useId();
  const inputID = id || fallbackID;
  const [revealed, setRevealed] = useState(false);
  const [filled, setFilled] = useState(Boolean(defaultValue));
  const hasValue = value === undefined ? filled : Boolean(value);
  const visible = hasValue && revealed && !disabled;
  useEffect(() => {
    if (!hasValue || disabled) setRevealed(false);
  }, [hasValue, disabled]);

  return (
    <span className="password-input">
      <input
        {...inputProps}
        id={inputID}
        className={`password-value ${className}`.trim()}
        type={visible ? "text" : "password"}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        onChange={(event) => {
          if (value === undefined) setFilled(Boolean(event.target.value));
          onChange?.(event);
        }}
      />
      <button
        className="password-reveal"
        type="button"
        disabled={disabled || !hasValue}
        aria-controls={inputID}
        aria-label={`显示${label}`}
        aria-pressed={visible}
        title={`${visible ? "隐藏" : "显示"}${label}`}
        onPointerDown={(event) => {
          // Keep the caret in the editor when the eye is tapped or clicked.
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => setRevealed((previous) => !previous)}
      >
        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </span>
  );
}
