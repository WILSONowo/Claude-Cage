import React, { useId, useState } from "react";
import { api } from "./api";
import { InlineSelect } from "./inline-select";
import { Modal } from "./modal";

const emptyHost = () => ({
  name: "",
  host: "",
  port: 22,
  user: "",
  auth: { kind: "key_file", identity_file: "" },
  executable: "cage",
  config_path: "",
});

export function HostForm({ initial, platform, onSaved, onClose }) {
  const formId = useId();
  const [form, setForm] = useState(() =>
    initial ? structuredClone(initial) : emptyHost(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (field, value) =>
    setForm((old) => ({
      ...old,
      [field]: value,
      ...(["host", "port"].includes(field) ? { host_key: undefined } : {}),
    }));
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api(
        form.id ? `/client/hosts/${form.id}` : "/client/hosts",
        { ...form, port: Number(form.port) },
        form.id ? "PUT" : "POST",
      );
      await onSaved(saved);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={form.id ? "编辑远程主机" : "添加远程主机"}
      onClose={busy ? undefined : onClose}
      footer={<>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" type="submit" form={formId} disabled={busy}>
          {busy ? "正在保存…" : "保存主机"}
        </button>
      </>}
    >
      <form id={formId} className="modal-body remote-host-form" onSubmit={save}>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <fieldset disabled={busy}>
          <label>
            主机名称
            <input
              required
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="东京开发机"
              maxLength={200}
            />
          </label>
          <div className="remote-form-row">
            <label>
              服务器地址
              <input
                required
                value={form.host}
                onChange={(event) => update("host", event.target.value)}
                placeholder="IP 地址或域名"
                autoComplete="off"
                spellCheck="false"
              />
            </label>
            <label className="remote-port">
              SSH 端口
              <input
                required
                type="number"
                min="1"
                max="65535"
                value={form.port}
                onChange={(event) => update("port", event.target.value)}
              />
            </label>
          </div>
          <label>
            SSH 用户名
            <input
              required
              value={form.user}
              onChange={(event) => update("user", event.target.value)}
              placeholder="cage"
              autoComplete="off"
              spellCheck="false"
            />
          </label>
          <label>
            SSH 登录方式
            <InlineSelect
              aria-label="SSH 登录方式"
              disabled={busy}
              value={form.auth.kind}
              onValueChange={(kind) =>
                update("auth", {
                  kind,
                  identity_file:
                    kind === "key_file" ? form.auth.identity_file || "" : "",
                })
              }
            >
              <option value="key_file">本机密钥文件</option>
              <option value="agent">本机 SSH agent</option>
            </InlineSelect>
          </label>
          {form.auth.kind === "key_file" && (
            <label>
              本机私钥文件
              <input
                aria-label="本机私钥文件"
                required
                value={form.auth.identity_file}
                onChange={(event) =>
                  update("auth", {
                    ...form.auth,
                    identity_file: event.target.value,
                  })
                }
                placeholder="私钥文件的绝对路径"
                aria-describedby={formId + "-key-help"}
                autoComplete="off"
                spellCheck="false"
              />
              <small id={formId + "-key-help"}>
                密钥保存在本机。路径示例 <code>{platform === "windows"
                  ? "C:\\Users\\你的名字\\.ssh\\id_ed25519"
                  : platform === "darwin" ? "/Users/你的名字/.ssh/id_ed25519" : "/home/你的名字/.ssh/id_ed25519"}</code>
              </small>
            </label>
          )}
          <details>
            <summary>云端安装路径</summary>
            <div className="remote-advanced">
              <label>
                Cage 程序路径
                <input
                  value={form.executable || ""}
                  onChange={(event) => update("executable", event.target.value)}
                  placeholder="cage"
                  spellCheck="false"
                />
                <small>留空使用 cage，或填写云端程序的绝对路径。</small>
              </label>
              <label>
                Cage 配置文件
                <input
                  value={form.config_path || ""}
                  onChange={(event) =>
                    update("config_path", event.target.value)
                  }
                  placeholder="可选"
                  spellCheck="false"
                />
                <small>留空使用 <code>~/.claude-cage/config.json</code>。自定义配置请填写云端绝对路径。</small>
              </label>
            </div>
          </details>
        </fieldset>
      </form>
    </Modal>
  );
}
