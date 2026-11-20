export function browserGraphicsFlags(settings = {}) {
  const flags = [];
  const backend = settings.backend;
  if (["gl", "vulkan", "swiftshader"].includes(backend)) {
    flags.push("--use-gl=angle", "--use-angle=" + backend);
    if (backend !== "swiftshader") flags.push("--enable-zero-copy");
  }
  if (settings.disable_webgl === true) flags.push("--disable-3d-apis", "--disable-webgl");
  if (settings.block_canvas_read === true) flags.push("--disable-reading-from-canvas");
  return flags;
}
