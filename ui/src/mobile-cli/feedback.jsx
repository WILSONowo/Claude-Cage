import React from "react";
import { RefreshCw } from "lucide-react";

export function Notice({ children, onRetry, label = "重新读取" }) {
  return <div className="notice" role="alert">{children}
    {onRetry && <button type="button" className="action secondary" onClick={onRetry}><RefreshCw size={15} />{label}</button>}
  </div>;
}
export function Empty({ icon: Icon, title, children }) {
  return <div className="center-message"><Icon size={25} strokeWidth={1.6} /><strong>{title}</strong>{children && <p className="note">{children}</p>}</div>;
}
