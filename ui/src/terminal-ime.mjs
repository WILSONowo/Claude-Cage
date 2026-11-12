export function installTerminalIME(host, terminal) {
  const beforeInput = (event) => {
    if (event.target !== terminal.textarea || event.inputType !== "insertText" ||
        !event.data || event.isComposing) return;
    // xterm 6 can retain a previous keydown when macOS commits IME punctuation
    // before its own keydown (xtermjs/xterm.js#6144). Keep xterm's input handling
    // and _keyPressHandled deduplication, but clear that stale ordering gate.
    const core = terminal._core;
    if (typeof core?._keyDownSeen === "boolean") core._keyDownSeen = false;
  };
  host.addEventListener("beforeinput", beforeInput, { capture: true });
  return () => host.removeEventListener("beforeinput", beforeInput, { capture: true });
}
