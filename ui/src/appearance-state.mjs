import { isLinux, isWindows } from "./platform.mjs";

export const systemUIFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif';
export const systemCodeFont = isLinux
  ? '"Sarasa Mono SC", "Noto Sans Mono CJK SC", "Noto Sans Mono", "DejaVu Sans Mono", monospace'
  : isWindows
    ? '"Cascadia Mono", Consolas, "Sarasa Mono SC", monospace'
    : '"SF Mono", Menlo, Monaco, monospace';
import { presets } from "./appearance-presets.mjs";
export {
  presets,
  presetNames,
  presetGroups,
  presetInfo,
  themeCatalog,
  applyThemePreset,
} from "./appearance-presets.mjs";
export const defaultAppearance = {
  customThemes: [],
  mode: "system",
  lightTheme: {
    ...presets.light["claude-desktop"],
    preset: "claude-desktop",
    opaqueWindows: false,
    fonts: { ui: "", code: "" },
  },
  darkTheme: {
    ...presets.dark["claude-desktop"],
    preset: "claude-desktop",
    opaqueWindows: false,
    fonts: { ui: "", code: "" },
  },
  uiFontSize: 14,
  codeFontSize: 13,
  pointerCursors: false,
  fontSmoothing: true,
  reducedMotion: "system",
};
function normalizeVariant(value = {}, variant) {
  const defaults = defaultAppearance[variant + "Theme"];
  const light = variant === "light";
  const legacy = value?.preset === "claude-desktop" && value.accent === "#d97757" &&
    value.surface === (light ? "#faf9f5" : "#262624") &&
    value.ink === (light ? "#262624" : "#faf9f5") && value.contrast === defaults.contrast;
  return {
    ...defaults, ...value,
    ...(legacy && { accent: defaults.accent, surface: defaults.surface, ink: defaults.ink }),
    colors: { ...value?.colors }, terminal: { ...value?.terminal },
    fonts: { ...defaults.fonts, ...value?.fonts },
  };
}
export function normalizeAppearance(value = {}) {
  value = value && typeof value === "object" ? value : {};
  return {
    ...defaultAppearance,
    ...value,
    customThemes: Array.isArray(value.customThemes) ? value.customThemes : [],
    lightTheme: normalizeVariant(value.lightTheme, "light"),
    darkTheme: normalizeVariant(value.darkTheme, "dark"),
  };
}
export function mix(a, b, weight) {
  const rgb = (hex) =>
    [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const left = rgb(a),
    right = rgb(b);
  return (
    "#" +
    left
      .map((value, index) =>
        Math.round(value + (right[index] - value) * weight)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
export function themeVariables(theme, variant) {
  const { surface, ink, accent, contrast } = theme;
  const chrome = mix(surface, ink, 0.025 + contrast * 0.00055);
  const line = mix(surface, ink, 0.09 + contrast * 0.0013);
  const variables = {
    "--paper": surface,
    "--chrome": chrome,
    "--chrome-dark": mix(surface, ink, 0.1),
    "--ink": ink,
    "--strong": mix(ink, variant === "light" ? "#000000" : "#ffffff", 0.15),
    "--muted": mix(ink, surface, 0.15),
    "--accent": accent,
    "--focus": accent,
    "--input": surface,
    "--line": line,
    "--hover": mix(surface, ink, 0.09),
    "--selected": mix(surface, ink, 0.13),
    "--selection": mix(surface, accent, 0.32),
    "--button": ink,
    "--button-ink": surface,
    "--link": accent,
    "--success": variant === "dark" ? "#70bf56" : "#357c3c",
    "--danger": variant === "dark" ? "#f26d78" : "#bb3535",
    "--warning": variant === "dark" ? "#e6b450" : "#af7a22",
    "--inactive": "#a3a3a3",
    "--ui-font-family": theme.fonts.ui || systemUIFont,
    "--code-font-family": theme.fonts.code || systemCodeFont,
    "--accent-ink": luminance(accent) > 0.4 ? "#111111" : "#ffffff",
  };
  const dark = variant === "dark";
  const stock = presets[variant]["claude-desktop"];
  const claude = theme.preset === "claude-desktop" && surface === stock.surface &&
    ink === stock.ink && contrast === stock.contrast;
  if (claude) {
    Object.assign(variables, {
      "--chrome": dark ? "#1f1f1f" : "#ffffff",
      "--chrome-dark": dark ? "#0b0b0b" : "#f9f9f9",
      "--input": dark ? "#252525" : "#ffffff",
      "--muted": dark ? "#9c9c9c" : "#666666",
      "--line": dark ? "#303030" : "#e0e0e0",
      "--selected": dark ? "#373737" : "#ebebeb",
      "--hover": dark ? "#2a2a2a" : "#ececec",
      "--link": accent,
      "--strong": ink,
    });
  }
  if (theme.preset === "cage") {
    variables["--chrome"] = mix(surface, ink, 0.045);
    variables["--muted"] = mix(ink, surface, 0.30);
    variables["--line"] = mix(surface, ink, 0.085 + contrast * 0.0007);
    variables["--selected"] = mix(surface, accent, variant === "dark" ? 0.18 : 0.095);
  }
  for (const [key, value] of Object.entries(theme.colors || {})) {
    if (colorTokens[key]) variables[colorTokens[key]] = value;
  }
  variables["--sidebar"] = theme.colors?.sidebar || (claude ? variables["--chrome-dark"] : variables["--chrome"]);
  variables["--sidebar-ink"] = theme.colors?.sidebarInk || ink;
  variables["--toolbar"] = theme.colors?.toolbar || surface;
  variables["--toolbar-ink"] = theme.colors?.toolbarInk || ink;
  // Shared components also use these aliases.
  variables["--border"] = variables["--line"];
  variables["--surface"] = variables["--paper"];
  const colors = theme.colors || {};
  const fieldBorder = colors.line || (claude ? (dark ? "#ffffff0a" : "#00000014") : line);
  const hoverBorder = claude && !colors.line
    ? (dark ? "rgb(255 255 255 / 20%)" : "rgb(11 11 11 / 20%)")
    : `color-mix(in srgb, ${fieldBorder} 70%, ${ink})`;
  const focus = variables["--focus"];
  const page = claude ? variables["--chrome-dark"] : variables["--paper"];
  const glow = claude && dark && focus === stock.accent
    ? "rgb(23 87 172 / 60%)" : `color-mix(in srgb, ${focus} 12%, transparent)`;
  const composerBorder = colors.line || (claude ? (dark ? "#ffffff14" : "#0000001f") : line);
  const edge = `${dark ? "inset " : ""}0 0 0 1px ${composerBorder}`;
  Object.assign(variables, {
    "--panel-bg": claude ? variables["--chrome"] : surface,
    "--field-bg": colors.input || (claude ? (dark ? "rgb(255 255 255 / 5%)" : "rgb(255 255 255 / 50%)") : variables["--input"]),
    "--field-border": fieldBorder,
    "--field-border-hover": hoverBorder,
    "--field-shadow": `inset 0 0 0 1px ${fieldBorder}`,
    "--field-shadow-hover": `inset 0 0 0 1px ${hoverBorder}`,
    "--field-ring": `inset 0 0 0 1px ${page}, 0 0 0 1px ${focus}, 0 0 6px 1px ${glow}`,
    "--field-radius": "6px",
    "--composer-bg": colors.input || (claude && dark ? "#303030" : variables["--input"]),
    "--composer-action-bg": claude && accent === stock.accent ? "#c56849" : accent,
    "--composer-shadow": `0 4px 20px rgb(0 0 0 / 3.5%), ${edge}`,
    "--composer-shadow-focus": `0 4px 20px rgb(0 0 0 / 7.5%), ${edge}`,
  });
  return variables;
}
export function terminalTheme(theme, variant) {
  const vars = themeVariables(theme, variant);
  return {
    background: theme.surface,
    foreground: theme.ink,
    cursor: theme.ink,
    cursorAccent: theme.surface,
    selectionBackground: vars["--selection"],
    black: variant === "dark" ? "#202020" : "#242424",
    red: variant === "dark" ? "#f26d78" : "#c43d3d",
    green: variant === "dark" ? "#aad94c" : "#4b7b23",
    yellow: theme.preset === "claude-desktop" ? (variant === "dark" ? "#edbd62" : "#946400") : theme.accent,
    blue: variant === "dark" ? "#59c2ff" : "#206bb1",
    magenta: variant === "dark" ? "#d2a6ff" : "#a03e9c",
    cyan: variant === "dark" ? "#95e6cb" : "#187b74",
    white: variant === "dark" ? "#bfbdb6" : "#dadada",
    brightBlack: "#737373",
    brightRed: "#fa7784",
    brightGreen: "#a4d86a",
    brightYellow: "#ffd173",
    brightBlue: "#73d0ff",
    brightMagenta: "#d4bfff",
    brightCyan: "#95e6cb",
    brightWhite: "#ffffff",
    ...theme.terminal,
  };
}

// Optional overrides keep unedited colors linked to the three base colors.
export const colorGroups = [
  {
    label: "界面与层级",
    entries: [
      ["chrome", "面板背景"],
      ["sidebar", "侧栏背景"],
      ["sidebarInk", "侧栏文字"],
      ["toolbar", "工具栏背景"],
      ["toolbarInk", "工具栏文字"],
      ["chromeDark", "次级背景"],
      ["strong", "标题文字"],
      ["muted", "辅助文字"],
      ["line", "边框与分隔线"],
      ["input", "输入框背景"],
    ],
  },
  {
    label: "按钮与交互",
    entries: [
      ["button", "主按钮背景"],
      ["buttonInk", "主按钮文字"],
      ["accentInk", "强调色上的文字"],
      ["link", "链接"],
      ["focus", "焦点边框"],
      ["hover", "悬停背景"],
      ["selected", "选中背景"],
      ["selection", "文本选区"],
    ],
  },
  {
    label: "状态提示",
    entries: [
      ["success", "成功状态"],
      ["warning", "警告状态"],
      ["danger", "错误状态"],
      ["inactive", "未启动状态"],
    ],
  },
];
export const colorTokens = Object.fromEntries(
  colorGroups.flatMap((group) =>
    group.entries.map(([key]) => [
      key,
      "--" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
    ]),
  ),
);
export const terminalColorGroups = [
  {
    label: "终端",
    entries: [
      ["background", "背景"],
      ["foreground", "文字"],
      ["cursor", "光标"],
      ["cursorAccent", "光标内文字"],
      ["selectionBackground", "选区背景"],
    ],
  },
  {
    label: "终端 ANSI 配色",
    entries: [
      ["black", "黑色"],
      ["red", "红色"],
      ["green", "绿色"],
      ["yellow", "黄色"],
      ["blue", "蓝色"],
      ["magenta", "品红"],
      ["cyan", "青色"],
      ["white", "白色"],
      ["brightBlack", "亮黑"],
      ["brightRed", "亮红"],
      ["brightGreen", "亮绿"],
      ["brightYellow", "亮黄"],
      ["brightBlue", "亮蓝"],
      ["brightMagenta", "亮品红"],
      ["brightCyan", "亮青"],
      ["brightWhite", "亮白"],
    ],
  },
];
export const themeFileLimit = 256 * 1024;
export const customThemeLimit = 50;
const hexColor = /^#[0-9a-fA-F]{6}$/;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function validateTheme(theme) {
  if (!object(theme)) throw new Error("主题缺少浅色或深色配置");
  const allowed = [
    "preset",
    "accent",
    "surface",
    "ink",
    "contrast",
    "opaqueWindows",
    "fonts",
    "colors",
    "terminal",
  ];
  if (Object.keys(theme).some((key) => !allowed.includes(key)))
    throw new Error("主题包含不支持的设置");
  if (
    ![theme.accent, theme.surface, theme.ink].every(
      (value) => typeof value === "string" && hexColor.test(value),
    )
  )
    throw new Error("颜色须为六位十六进制值，例如 #fdf6e3");
  if (
    typeof theme.preset !== "string" ||
    theme.preset.length > 80 ||
    !Number.isInteger(theme.contrast) ||
    theme.contrast < 0 ||
    theme.contrast > 100 ||
    typeof theme.opaqueWindows !== "boolean"
  )
    throw new Error("主题配置无效");
  if (
    !object(theme.fonts) ||
    Object.keys(theme.fonts).some((key) => !["ui", "code"].includes(key)) ||
    [theme.fonts.ui, theme.fonts.code].some(
      (font) =>
        typeof font !== "string" ||
        font.length > 200 ||
        /[;{}<>\r\n]/.test(font),
    )
  )
    throw new Error("字体名称无效");
  for (const [field, keys] of [
    ["colors", Object.keys(colorTokens)],
    [
      "terminal",
      terminalColorGroups.flatMap((group) => group.entries.map(([key]) => key)),
    ],
  ]) {
    if (theme[field] === undefined) continue;
    if (
      !object(theme[field]) ||
      Object.entries(theme[field]).some(
        ([key, value]) =>
          !keys.includes(key) ||
          typeof value !== "string" ||
          !hexColor.test(value),
      )
    )
      throw new Error("元素颜色无效或包含不支持的颜色项目");
  }
  return structuredClone(theme);
}
export function validateThemeName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    throw new Error("请输入 1–80 个字符的主题名称");
  return name.trim();
}
export function themeDocument(name, appearance) {
  return {
    format: "cage-theme",
    version: 1,
    name: validateThemeName(name),
    lightTheme: validateTheme(appearance.lightTheme),
    darkTheme: validateTheme(appearance.darkTheme),
  };
}
export function parseThemeDocument(text) {
  if (new TextEncoder().encode(text).length > themeFileLimit)
    throw new Error("主题文件不能超过 256 KB");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("无法读取主题，请选择有效的 JSON 文件");
  }
  if (!object(data) || data.format !== "cage-theme" || data.version !== 1)
    throw new Error("不支持的主题格式或版本，请使用 Cage 导出的主题文件");
  if (
    Object.keys(data).some(
      (key) =>
        !["format", "version", "name", "lightTheme", "darkTheme"].includes(key),
    )
  )
    throw new Error("主题文件包含不支持的设置");
  return themeDocument(data.name, data);
}
export function sameTheme(left, right) {
  const canonical = (theme) => {
    const valid = validateTheme(theme);
    return JSON.stringify([
      valid.preset,
      valid.accent,
      valid.surface,
      valid.ink,
      valid.contrast,
      valid.opaqueWindows,
      valid.fonts.ui,
      valid.fonts.code,
      Object.entries(valid.colors || {}).sort(),
      Object.entries(valid.terminal || {}).sort(),
    ]);
  };
  return (
    canonical(left.lightTheme) === canonical(right.lightTheme) &&
    canonical(left.darkTheme) === canonical(right.darkTheme)
  );
}
