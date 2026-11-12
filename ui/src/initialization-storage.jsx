import React, { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api, native, nativeAvailable } from "./api";

export function InitializationStorage({ value, onChange, disabled }) {
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (value) return;
    let live = true;
    api("/environment/storage").then(location => {
      if (live) onChange({ location, directory: location.suggested_directory || location.directory });
    }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [Boolean(value), onChange, attempt]);
  const locked = disabled || !value || value.location.has_environment;
  async function choose() {
    try {
      const directory = await native("chooseFolder", { purpose: "environmentStorage" });
      if (directory) { onChange({ ...value, directory }); setError(""); }
    } catch (error) { setError(error.message); }
  }
  return <section className="initialization-storage" aria-label="环境存储目录">
    <label htmlFor="initialization-directory">存储目录</label>
    <p>镜像、缓存和虚拟磁盘保存在此处。更改位置需选择本地空文件夹。</p>
    <p>更新、重装和卸载均保留此目录。手动删除将丢失环境数据。</p>
    <div className="initialization-directory-control">
      <input id="initialization-directory" value={value?.directory || ""} disabled={locked} spellCheck={false} placeholder={value ? "请输入存储目录的完整路径" : "正在读取默认目录…"} onChange={event => onChange({ ...value, directory: event.target.value })} />
      {nativeAvailable() && <button type="button" disabled={locked} onClick={choose}><FolderOpen size={16} />选择文件夹</button>}
    </div>
    {value?.location.has_environment && <p>已有虚拟磁盘，继续使用原存储目录。完成初始化后可在设置中迁移。</p>}
    {error && <p role="alert">{error}<button onClick={() => { setError(""); retry(value => value + 1); }}>重新读取</button></p>}
  </section>;
}
