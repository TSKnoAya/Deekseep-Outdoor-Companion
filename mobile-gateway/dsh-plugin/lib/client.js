/**
 * mobile-gateway 插件 —— 客户端半边（DSH 设置里的「手机网关」一页）。
 *
 * 三个块：
 *   ① 网关状态（跑没跑、监听地址、DSH 连没连、已配对几台）
 *   ② 配对码（点一下生成，5 分钟倒计时）——换手机/重装 App 时用，不用去重启网关窗口
 *   ③ 手机端模型（读/写 ACP profile 的 provider + model，保存后由网关重开 ACP 子进程）
 *
 * 数据全部走后端代理 /dsh-mobile-gateway/api/*，本页不直接碰文件或端口。
 */
window.__ModuleLoader__.load({
  id: "mobile-gateway",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState } = React;

    const API = "/dsh-mobile-gateway/api";

    async function api(path, init) {
      const res = await fetch(API + path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = { ok: false, error: `HTTP ${res.status}` };
      }
      return body;
    }

    const box = {
      border: "1px solid rgba(127,127,127,.28)",
      borderRadius: "10px",
      padding: "14px",
      marginBottom: "12px",
    };
    const label = { fontSize: "12px", opacity: 0.72, marginBottom: "4px" };
    const mono = { fontFamily: "ui-monospace, Consolas, monospace" };
    const btn = (extra) => ({
      padding: "7px 14px",
      borderRadius: "8px",
      border: "1px solid rgba(127,127,127,.35)",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      fontSize: "13px",
      ...extra,
    });
    const input = {
      width: "100%",
      padding: "7px 10px",
      borderRadius: "8px",
      border: "1px solid rgba(127,127,127,.35)",
      background: "transparent",
      color: "inherit",
      fontSize: "13px",
      ...mono,
    };

    function Row({ k, v, tone }) {
      return h("div", { style: { display: "flex", gap: "10px", padding: "3px 0", fontSize: "13px" } },
        h("span", { style: { ...label, marginBottom: 0, width: "96px", flex: "0 0 auto" } }, k),
        h("span", { style: { color: tone || "inherit", wordBreak: "break-all" } }, v));
    }

    function Section() {
      const [status, setStatus] = useState(null);
      const [statusErr, setStatusErr] = useState("");
      const [model, setModel] = useState(null);
      const [provider, setProvider] = useState("");
      const [modelName, setModelName] = useState("");
      const [pair, setPair] = useState(null);
      const [busy, setBusy] = useState("");
      const [note, setNote] = useState("");
      const [err, setErr] = useState("");
      const [left, setLeft] = useState(0);

      const refresh = useCallback(async () => {
        setBusy("refresh");
        setErr("");
        setStatusErr("");
        const s = await api("/status");
        if (s?.ok) setStatus(s);
        else {
          setStatus(null);
          setStatusErr(s?.hint || s?.error || "网关没在运行");
        }
        const m = await api("/acp-model");
        if (m?.ok) {
          setModel(m);
          setProvider((m.current && m.current.provider) || "");
          setModelName((m.current && m.current.model) || "");
        }
        setBusy("");
      }, []);

      useEffect(() => {
        refresh();
        const t = setInterval(refresh, 15000);
        return () => clearInterval(t);
      }, [refresh]);

      // 配对码倒计时
      useEffect(() => {
        if (!pair?.expiresAt) return undefined;
        const tick = () => {
          const ms = Math.max(0, Number(pair.expiresAt) - Date.now());
          setLeft(Math.ceil(ms / 1000));
        };
        tick();
        const t = setInterval(tick, 500);
        return () => clearInterval(t);
      }, [pair]);

      const makePair = async () => {
        setBusy("pair");
        setErr("");
        setNote("");
        const r = await api("/pair", { method: "POST" });
        setBusy("");
        if (r?.ok) setPair(r);
        else setErr(r?.hint || r?.error || "生成失败");
      };

      const saveModel = async () => {
        setBusy("save");
        setErr("");
        setNote("");
        const r = await api("/acp-model", {
          method: "PUT",
          body: JSON.stringify({ provider, model: modelName }),
        });
        setBusy("");
        if (r?.ok) {
          setNote(r.reloaded ? "已保存，ACP 子进程已按新配置重连（约 3 秒）。" : `已保存，但重连失败：${r.reloadError || "未知"}`);
          refresh();
        } else {
          setErr(r?.hint || r?.error || "保存失败");
        }
      };

      const running = Boolean(status?.running);

      return h("div", { style: { padding: "4px 2px" } },
        h("h2", { style: { fontSize: "16px", margin: "0 0 4px" } }, "手机网关"),
        h("p", { style: { ...label, marginBottom: "14px" } },
          "手机 App ⇄ 本机网关 ⇄ DSH。这里管三件事：网关在不在、配对码、手机端用哪个模型。"),

        // ① 状态
        h("div", { style: box },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
            h("strong", { style: { fontSize: "13px" } }, "① 网关状态"),
            h("button", { style: btn(), onClick: refresh, disabled: busy === "refresh" },
              busy === "refresh" ? "刷新中…" : "刷新")),
          running
            ? h("div", null,
                h(Row, { k: "运行中", v: "是", tone: "#3fb950" }),
                h(Row, { k: "监听", v: status.listen ? `${status.listen.host}:${status.listen.port}` : "?" }),
                h(Row, { k: "DSH", v: status.dsh?.connected ? `已连接（${status.dsh.name || "?"}）` : "未连接", tone: status.dsh?.connected ? "#3fb950" : "#d29922" }),
                h(Row, { k: "已配对", v: `${status.devices ?? 0} 台设备` }))
            : h("div", null,
                h(Row, { k: "运行中", v: "否", tone: "#f85149" }),
                h("div", { style: { ...label, marginTop: "8px", lineHeight: 1.6 } },
                  "在手机网关目录双击 start-gateway.bat。窗口开着手机才能连，关掉就断（配对不会失效）。"))),

        // ② 配对码
        h("div", { style: box },
          h("strong", { style: { fontSize: "13px" } }, "② 配对码"),
          h("p", { style: { ...label, margin: "6px 0 8px", lineHeight: 1.6 } },
            "换手机、重装 App 时需要。5 分钟内有效，过期重新生成即可；平时不用管。"),
          h("div", { style: { display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" } },
            h("button", { style: btn(), onClick: makePair, disabled: !running || busy === "pair" },
              busy === "pair" ? "生成中…" : "生成配对码"),
            pair?.code
              ? h("span", { style: { ...mono, fontSize: "22px", letterSpacing: "4px" } }, pair.code)
              : null,
            pair?.code
              ? h("span", { style: { ...label, marginBottom: 0 } }, left > 0 ? `${left} 秒后失效` : "已失效，请重新生成")
              : null)),

        // ③ 模型
        h("div", { style: box },
          h("strong", { style: { fontSize: "13px" } }, "③ 手机端用哪个模型"),
          h("p", { style: { ...label, margin: "6px 0 10px", lineHeight: 1.6 } },
            "手机走的是 DSH 的 acp profile，和桌面端不是同一份配置。下面两项改完点保存，网关会自动重连 ACP（不用重启窗口，不用重装 App）。"),
          model && model.current
            ? h("div", { style: { ...label, marginBottom: "10px" } },
                "当前：", h("span", { style: mono }, `${model.current.provider} / ${model.current.model}`))
            : h("div", { style: { ...label, marginBottom: "10px" } }, "当前：未配置（ACP 会用 deepseek-official，多半会报 no API key）"),
          h("div", { style: { display: "grid", gap: "10px" } },
            h("div", null,
              h("div", { style: label }, "provider"),
              h("input", { style: input, value: provider, onChange: (e) => setProvider(e.target.value), placeholder: "our-free-model / deepseek-account / ..." })),
            h("div", null,
              h("div", { style: label }, "model"),
              h("input", { style: input, value: modelName, onChange: (e) => setModelName(e.target.value), placeholder: "kilo-auto/free / deepseek-v4.1-flash / ..." }))),
          h("div", { style: { display: "flex", gap: "10px", marginTop: "12px", alignItems: "center" } },
            h("button", { style: btn(), onClick: saveModel, disabled: !running || busy === "save" || !provider || !modelName },
              busy === "save" ? "保存中…" : "保存并生效"),
            model?.file ? h("span", { style: { ...label, marginBottom: 0, ...mono, fontSize: "11px" } }, model.file) : null)),

        note ? h("div", { style: { padding: "9px 12px", borderRadius: "8px", background: "rgba(63,185,80,.12)", fontSize: "12.5px" } }, note) : null,
        (err || statusErr) ? h("div", { style: { padding: "9px 12px", borderRadius: "8px", background: "rgba(248,81,73,.12)", fontSize: "12.5px", marginTop: "8px" } }, err || statusErr) : null,
      );
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: "mobile-gateway", order: 9, label: () => "手机网关" },
              Section,
            ),
            "mobile-gateway: settings section",
          ),
        "mobile-gateway: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.MobileGatewaySection = Section;
    return module.exports;
  },
});
