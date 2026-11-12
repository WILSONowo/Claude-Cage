import React from "react";
import logo from "./logo.png";
import "./setup-scene.css";

export function SetupBrand({ context }) {
  return <header className="setup-brand">
    <img src={logo} alt="" />
    <strong>Claude Cage</strong>
    <span>{context}</span>
  </header>;
}
