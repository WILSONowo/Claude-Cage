import { PasswordInput } from "./password-input";
import React, { useEffect, useId, useRef, useState } from "react";
import { api, writeClipboard } from "./api";
import { QrCode } from "lucide-react";

export function MobilePairSettings({ relay, savedRelay, onChange, onConfirm }) {
  const tokenId = useId();
  const [custom, setCustom] = useState(Boolean(relay));
  const [token, setToken] = useState("");
  const [code, setCode] = useState(null);
  const [paired, setPaired] = useState(false);
  const [device, setDevice] = useState(null);
  const [power, setPower] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const statusRevision = useRef(0);
  useEffect(() => {
    let active = true;
    const check = async () => {
      const revision = statusRevision.current;
      try {
        const state = await api("/mobile-pair");
        if (!active || revision !== statusRevision.current) return;
        setPaired(state.paired);
        setDevice(state.paired ? state.device ?? null : null);
        setPower(state.paired ? state.keep_awake ?? null : null);
        if (state.paired) setCode(null);
        else if (code && Date.now() >= Date.parse(code.expires)) {
          setCode(null);
          setNotice("二维码已过期，请重新生成。");
        } else if (code && state.status.includes("未完成")) {
          setCode(null);
          setNotice(state.status);
        }
      } catch (e) {
        if (active && revision === statusRevision.current) setNotice(e.message);
      }
    };
    check();
    const timer = setInterval(check, code ? 1500 : 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [code]);
  async function generate() {
    setBusy(true);
    setNotice("");
    setCode(null);
    try {
      setCode(
        await api("/mobile-pair", {
          relay: savedRelay,
          admin: custom ? token : "",
        }),
      );
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !(await onConfirm({
        title: "移除配对手机？",
        body: device?.model
          ? `移除 ${device.model} 后，这部手机需要重新扫码才能访问工作台。`
          : "这部手机需要重新扫码才能访问工作台。",
        confirm: "移除手机",
      }))
    )
      return;
    setBusy(true);
    try {
      await api("/mobile-pair", {}, "DELETE");
      statusRevision.current++;
      setPaired(false);
      setDevice(null);
      setPower(null);
      setNotice("");
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Center the QR and its actions. Relay controls use the same theme below.
  return (
    <section className="remote-link-settings" aria-label="远程连接">
      <div className="section-title">
        <h3>远程连接</h3>
        <p>
          配对后，可用手机操作浏览器和 Claude Desktop，也可继续 Claude Code 会话、审批工具请求。
        </p>
      </div>
      <section className="remote-pair-card" aria-label="手机配对">
        <h4>{paired ? "手机已配对" : "用手机连接 Cage"}</h4>
        {paired && (
          <p className="remote-pair-device" aria-label="已配对手机">
            {device?.model ? (
              <>
                <strong>{device.model}</strong>
                <span>{device.platform === "ios" ? "iOS" : "Android"}</span>
              </>
            ) : (
              <span>未能读取型号，请更新手机端 Cage 后重连。</span>
            )}
          </p>
        )}
        {paired ? (
          <p role="status">在手机上选择「重新连接」打开工作台。</p>
        ) : (
          <p className="remote-pair-instruction">
            在手机 Cage 的「连接电脑」中选择「扫码连接」，或在「使用配对码」中粘贴配对码。
          </p>
        )}
        {paired && power?.active && <p className="note">远程待机已请求防止电脑休眠，屏幕仍可熄灭。移除配对或停止后台服务后恢复原休眠设置。</p>}
        {paired && power?.error && <p role="alert">主机防休眠未生效：{power.error}</p>}
        {code && (
          <div className="remote-pair-code">
            <img
              src={code.image}
              alt="手机配对二维码"
              width="320"
              height="320"
            />
            <p className="field-help">二维码约 2 分钟有效。</p>
          </div>
        )}
        {!code && !paired && (
          <div className="remote-pair-placeholder" aria-hidden="true">
            <QrCode size={64} strokeWidth={1.25} />
          </div>
        )}
        <div className="remote-pair-actions">
          {paired ? (
            <button type="button" disabled={busy} onClick={remove}>
              移除配对手机
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || relay !== savedRelay || (custom && !relay)}
              onClick={generate}
            >
              <QrCode size={18} />
              {busy ? "正在生成…" : code ? "刷新二维码" : "生成配对二维码"}
            </button>
          )}
          {code && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await writeClipboard(code.manual);
                  setNotice("已复制一次性配对码。");
                } catch {
                  setNotice("复制失败，请使用二维码。");
                }
              }}
            >
              复制配对码
            </button>
          )}
        </div>
        {!paired && (
          <p className="remote-pair-privacy">
            仅向受信任的手机提供二维码或配对码。
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </section>
      <section className="remote-relay-settings" aria-label="中继设置">
        <div className="remote-relay-row">
          <div>
            <h4>中继服务</h4>
          </div>
          <div
            className="remote-relay-options"
            role="group"
            aria-label="中继服务"
          >
            <button
              type="button"
              aria-pressed={!custom}
              onClick={() => {
                setCustom(false);
                setToken("");
                onChange("");
                setCode(null);
              }}
            >
              Cage 官方中继
            </button>
            <button
              type="button"
              aria-pressed={custom}
              onClick={() => setCustom(true)}
            >
              自建中继
            </button>
          </div>
        </div>
        {custom && (
          <>
            <label>
              自建中继地址
              <input
                value={relay}
                placeholder="https://relay.example.com"
                onChange={(e) => {
                  onChange(e.target.value);
                  setToken("");
                  setCode(null);
                }}
              />
            </label>
            <div className="secret-field">
              <label htmlFor={tokenId}>管理令牌（可选）</label>
              <PasswordInput
                id={tokenId}
                label="管理令牌"
                disabled={busy}
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
          </>
        )}
        {relay !== savedRelay && (
          <small>保存后可用新中继生成配对码。</small>
        )}
      </section>
    </section>
  );
}
