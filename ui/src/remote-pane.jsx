import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { api } from "./api";
import { runtimeSocketURL } from "./client-context.mjs";
import { prepareClipboardPaste, sendImage } from "./image-transfer";
import { sendFiles } from "./file-transfer";
import { installRemoteInput } from "./remote-input";
import { useWindowVisibility } from "./window-visibility";
import { displayGeometry, displaySizeSync, watchPixelRatio } from "./remote-display.mjs";
import { installLocalCursorFallback } from "./remote-cursor.mjs";
import { RefreshCw } from "lucide-react";
import RFB from "../.generated/novnc/core/rfb.js";

function canFocusCanvas(canvas) {
  const active = document.activeElement;
  return canvas && (!active || active === document.body || canvas.contains(active));
}

export default forwardRef(function RemoteView(
  { visible, focused = true, keyboard, guestPlatform = "linux", systemClipboard = true, tabId, copyScope = tabId, onStatus, onFallback, desktop = false, zoom = 1 },
  ref,
) {
  const windowVisible = useWindowVisibility();
  const screenVisible = visible && windowVisible;
  const box = useRef(),
    rfb = useRef(),
    input = useRef(),
    current = useRef({ visible, keyboard, onStatus, onFallback }),
    displayResize = useRef();
  current.current = { visible: screenVisible && focused, keyboard, guestPlatform, systemClipboard, tabId, onStatus, onFallback, zoom };
  const failures = useRef(0);
  const [connection, setConnection] = useState("connecting"),
    [connectionError, setConnectionError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [sizeError, setSizeError] = useState(false);
  useEffect(() => { displayResize.current?.update(); }, [zoom]);
  useEffect(() => { input.current?.cancelCopy(); }, [copyScope]);
  useImperativeHandle(ref, () => ({
    focus: () => rfb.current?.focus(),
    edit: (action) =>
      input.current?.focused()
        ? input.current?.edit(action)
        : false,
    copy: () => input.current?.copy(),
    receiveCopy: (value) => input.current?.receiveCopy(value),
    paste: () => input.current?.readAndPaste(),
    pasteText: (text) => input.current?.paste(text),
    transfer: () =>
      onFallback(input.current?.text() || "", "可使用本机剪贴板复制、粘贴。"),
  }));
  useEffect(() => {
    if (!screenVisible) return;
    const container = box.current;
    if (!container) return;
    let disposed = false,
      client,
      resizeObserver,
      unwatchDensity,
      sizeSync,
      reconnectTimer;
    setConnection("connecting");
    setSizeError(false);
    const retry = () => {
      if (disposed) return;
      setConnection("disconnected");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(
        () => setAttempt((v) => v + 1),
        Math.min(1000 * 2 ** failures.current++, 5000),
      );
    };
    const desktopPrefix = desktop ? "/claude-desktop" : "";
    api(`${desktopPrefix}/vnc-credentials`)
      .then(({ password, display_scale, dynamic_scale, pixel_wheel }) => {
        if (disposed) return;
        setConnectionError("");
        // Such a guest renders at the density of the screen showing it.
        let followScreen = dynamic_scale === true;
        client = new RFB(
          container,
          runtimeSocketURL(`${desktopPrefix}/vnc`),
          {
            credentials: { password }, cageBrowserDisplay: !desktop, cageCursorFallback: desktop && guestPlatform === "windows",
            // The Linux browser scrolls its page by the distance of a trackpad
            // gesture. A menu or a second pane declines it and gets wheel steps.
            cageWheelSink: !desktop && pixel_wheel === true
              ? wheel => api("/browser/wheel", wheel).then(reply => reply?.handled === true)
              : undefined,
          },
        );
        rfb.current = client;
        installLocalCursorFallback(client._cursor,
          !desktop && ["darwin", "macos"].includes(guestPlatform));
        client.scaleViewport = true;
        client.resizeSession = false;
        client.background = "#ffffff";
        client.qualityLevel = 8;
        client.compressionLevel = 2;
        client.addEventListener("connect", () => {
          if (disposed) return;
          failures.current = 0;
          setConnection("connected");
          sizeSync = displaySizeSync(
            async (size) => {
              const reply = await api(desktop ? "/claude-desktop/resize" : "/browser/resize", size);
              // The guest kept its own density: size the display for that one.
              if (size.scale !== undefined && reply?.scale !== size.scale && followScreen) {
                followScreen = false;
                resize();
              }
            },
            { onError: () => setSizeError(true), onSuccess: () => setSizeError(false) },
          );
          const resize = () => {
            if (disposed) return;
            sizeSync.update(displayGeometry(container.getBoundingClientRect(), {
              desktop, zoom: current.current.zoom, density: display_scale,
              pixelRatio: followScreen ? window.devicePixelRatio : undefined,
            }));
          };
          displayResize.current = { update: resize, retry: () => sizeSync.retry() };
          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(container);
          unwatchDensity = watchPixelRatio(resize);
          resize();
          const preparePaste = () => {
            const id = current.current.tabId;
            return prepareClipboardPaste(desktop ? "desktop" : "browser", id, {
              valid: () => !disposed && current.current.visible && current.current.tabId === id,
            });
          };
          input.current = installRemoteInput({
            events: client,
            setKeyboardTarget: target => client.cageSetKeyboardTarget(target),
            sendKey: (...key) => client.sendKey(...key),
            focus: () => client.focus(),
            pasteText: text => {
              if (desktop || current.current.systemClipboard) return client.cagePasteText(text);
              const prepared = preparePaste();
              return client.cageRunInput(() => prepared.send({ text })).finally(() => prepared.dispose());
            },
            runKeyAction: action => client.cageRunInput(action),
          }, container, {
            guestPlatform: () => current.current.guestPlatform,
            systemClipboard: () => current.current.systemClipboard,
            copyText: !desktop
              ? (_sendCopy, valid, { id, context, key }) => {
                if (current.current.systemClipboard !== false) return undefined;
                if (!valid()) throw new Error("复制位置已切换，请重新复制");
                return api("/browser/" + (key === "x" ? "cut" : "copy"), { id, context });
              }
              : undefined,
            setCopyContext: desktop ? undefined : (context, valid) => client.cageRunInput(async () => {
              if (!valid()) return;
              try { await api("/browser/copy-context", { id: current.current.tabId, context }); }
              catch {
                if (valid()) {
                  input.current?.cancelCopy();
                  current.current.onStatus("复制按钮同步暂未就绪，可使用复制快捷键或文本传递");
                }
                // A metadata failure must not cancel the user's queued click.
              }
            }),
            preparePaste,
            pasteContent: (content, prepared) => {
              const id = current.current.tabId;
              const valid = () => !disposed && current.current.visible && current.current.tabId === id;
              return client.cagePasteContent(content,
                (payload) => {
                  if (!valid()) throw new Error("输入目标已切换，请重新粘贴图片");
                  return payload.files || payload.fileSelection
                    ? sendFiles(payload, desktop ? "desktop" : "browser", id, { valid })
                    : sendImage(payload, desktop ? "desktop" : "browser", id, { prepared });
                }, valid, !desktop && !current.current.systemClipboard ? text => prepared.send({ text }) : undefined);
            },
            insertText: (text) => {
              if (desktop) {
                if (!window.cageSharedClipboardActive) return client.cagePasteText(text);
                return client.cageRunInput(async () => {
                  const valid = () => !disposed && current.current.visible;
                  const state = await api("/input", { target: "desktop", id: "desktop", mode: "status" });
                  if (!state.available || !valid()) throw new Error("输入位置已失去焦点，请重新点击输入框");
                  const session = crypto.randomUUID().replaceAll("-", "");
                  const begun = await api("/input", { target: "desktop", id: "desktop", mode: "begin", context: state.context, session, sequence: 0 });
                  if (!begun.available || !valid()) throw new Error("输入位置已失去焦点，请重新点击输入框");
                  const result = await api("/input", { target: "desktop", id: "desktop", mode: "commit", session, sequence: 1, text });
                  if (!result.available) throw new Error("文字输入未完成，请重新点击输入框");
                });
              }
              const id = current.current.tabId;
              return client.cageRunInput(() => {
                if (disposed || !current.current.visible || current.current.tabId !== id)
                  throw new Error("输入位置已切换，请重新输入");
                return api("/browser/insert-text", { id, text });
              });
            },
            insertComposition: (id, value) => client.cageRunInput(async () => {
              if (value.mode !== "cancel" && (disposed || !current.current.visible ||
                  (desktop ? "desktop" : current.current.tabId) !== id))
                throw new Error("输入位置已切换，请重新输入");
              const result = await api("/input", { target: desktop ? "desktop" : "browser", id, ...value });
              if (value.mode !== "cancel" && !result.available)
                throw new Error("输入位置已失去焦点，请重新输入");
              return result;
            }),
            tabId: () => desktop ? "desktop" : current.current.tabId,
            caretRect: async (session) => {
              const id = desktop ? "desktop" : current.current.tabId;
              const value = await api("/input", { target: desktop ? "desktop" : "browser", id, mode: "status", session });
              return !disposed && current.current.visible &&
                (desktop ? "desktop" : current.current.tabId) === id ? value : null;
            },
            mode: () => current.current.keyboard,
            isActive: () => current.current.visible,
            onStatus: (t) => current.current.onStatus(t),
            onFallback: (...args) => current.current.onFallback(...args),
          });
          if (current.current.visible && canFocusCanvas(box.current)) client.focus();
        });
        client.addEventListener("disconnect", () => {
          if (disposed) return;
          input.current?.dispose();
          input.current = null;
          sizeSync?.dispose();
          resizeObserver?.disconnect();
          unwatchDensity?.();
          displayResize.current = null;
          retry();
        });
        client.addEventListener("securityfailure", () => {
          retry();
        });
      })
      .catch((error) => {
        if (!disposed && desktop) setConnectionError(error.message);
        retry();
      });
    return () => {
      disposed = true;
      sizeSync?.dispose();
      displayResize.current = null;
      clearTimeout(reconnectTimer);
      resizeObserver?.disconnect();
      unwatchDensity?.();
      input.current?.dispose();
      input.current = null;
      client?.disconnect();
      rfb.current = null;
    };
  }, [attempt, screenVisible, desktop]);
  useEffect(() => {
    if (focused && screenVisible && connection === "connected") {
      const t = setTimeout(() => { if (canFocusCanvas(box.current)) rfb.current?.focus(); }, 80);
      return () => clearTimeout(t);
    }
  }, [focused, screenVisible, connection]);
  return (
    <div className={`remote-view ${visible ? "" : "concealed"}`}>
      <div className="remote-canvas" ref={box} />
      {sizeError && connection === "connected" && (
        <div className="remote-size-warning connection-banner" role="alert">
          画面尺寸未同步，显示比例可能有偏差。
          <button onClick={() => displayResize.current?.retry()}>重试调整</button>
        </div>
      )}
      {connection !== "connected" && (
        <div className="view-overlay">
          <RefreshCw className={connection === "connecting" ? "spin" : ""} />
          <h3>
            {connection === "connecting" ? "正在连接画面" : "画面连接已断开"}
          </h3>
          {connection === "disconnected" && (
            <>
              <p>{connectionError || "后台任务仍在运行。"}</p>
              <button className="primary" onClick={() => setAttempt((v) => v + 1)}>
                重新连接画面
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
});
