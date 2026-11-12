export function sameSnapshot(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameSnapshot(left[key], right[key]));
}

export function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function orderedTabs(tabs, saved) {
  const order = saved.order || [];
  const rank = new Map();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  return [...tabs].sort((a, b) => {
    const pinned =
      Number(Boolean(saved[b.id]?.pinned)) -
      Number(Boolean(saved[a.id]?.pinned));
    if (pinned) return pinned;
    return (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length);
  });
}

const clientMount = /^\/run\/cage-client-projects\/[0-9a-f]{32}$/;
const folderName = (path) => path?.split(/[\\/]/).filter(Boolean).at(-1);

export function rememberClientProjectName(share) {
  if (!clientMount.test(share.guest_path)) return;
  try { sessionStorage.setItem(share.guest_path, folderName(share.path)); }
  catch { /* The mount is usable without browser storage. */ }
}

export function projectName(path, defaultWorkspace) {
  if (clientMount.test(path)) {
    try { return sessionStorage.getItem(path) || "本机共享项目"; }
    catch { return "本机共享项目"; }
  }
  if (path === defaultWorkspace && path?.endsWith("-workspace")) return "默认工作区";
  return folderName(path) || "新项目";
}

export function tabName(tab, saved, project) {
  return (tab.incognito ? "无痕 · " : "") + (
    saved[tab.id]?.title ||
    (tab.kind === "editor"
      ? `文件 · ${tab.workspace ? projectName(tab.workspace) : project}`
      : tab.title) ||
    "新标签页"
  );
}

// The focused tab and its neighbour retain their screen positions on focus changes.
export function focusTab(layout, id) {
  if (layout.active === id) return layout;
  if (!id) return { active: "" };
  if (layout.other === id)
    return { active: id, other: layout.active, side: layout.side === "left" ? "right" : "left" };
  if (layout.other && id.startsWith("terminal:") !== layout.active.startsWith("terminal:") &&
      id.startsWith("terminal:") === layout.other.startsWith("terminal:"))
    return { ...focusTab(layout, layout.other), active: id };
  return { ...layout, active: id };
}

export function splitTab(layout, tabs, id, side) {
  if (!tabs.some(tab => tab.id === id)) return layout;
  const opposite = layout.side === side ? layout.other : layout.active;
  const other = [opposite, layout.other, layout.active, ...tabs.map(tab => tab.id)]
    .find(candidate => candidate !== id && tabs.some(tab => tab.id === candidate));
  return other ? { active: id, other, side } : layout;
}
