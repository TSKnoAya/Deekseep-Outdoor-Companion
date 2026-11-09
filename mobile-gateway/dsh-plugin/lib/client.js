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

    /** 宿主插件是旧版（缺接口）时 DSH web 层回 405，和「网关起不来」是两回事。 */
    function isStaleHost(r) {
      const text = `${r?.code ?? ""} ${r?.error ?? ""}`;
      return /405/.test(text) || text.includes("方法不对");
    }

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
      // 没有这一行，padding 会加到 100% 之上 → 输入框超出卡片（第一次就是这样溢出的）
      boxSizing: "border-box",
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

    /**
     * 把二维码矩阵（'0'/'1' 字符串）画成内联 SVG。
     *
     * 为什么不用 <img src="data:image/svg+xml,...">：DSH 页面的 CSP 可能拦 data: 图片，
     * 而且字符串拼接容易在深色主题下发灰。内联 <path> 两种都不怕。
     * 每行把连续的黑块合成一条横线，37×37 只有几百段，比逐格画 <rect> 小得多。
     */
    function qrSvg(qr, px) {
      const n = qr.size;
      let d = "";
      for (let y = 0; y < n; y++) {
        const row = qr.rows[y];
        let x = 0;
        while (x < n) {
          if (row[x] !== "1") { x++; continue; }
          let run = 1;
          while (x + run < n && row[x + run] === "1") run++;
          d += `M${x} ${y}h${run}v1h-${run}z`;
          x += run;
        }
      }
      // 静区（quiet zone）必须有 4 格白边，否则很多扫描器直接不识别
      return h("svg", {
        viewBox: `${-4} ${-4} ${n + 8} ${n + 8}`,
        width: px,
        height: px,
        shapeRendering: "crispEdges",
        style: { display: "block", borderRadius: "6px", background: "#fff" },
        role: "img",
        "aria-label": "配对二维码",
      },
        h("rect", { x: -4, y: -4, width: n + 8, height: n + 8, fill: "#fff" }),
        h("path", { d, fill: "#000" }));
    }

    /** 设备列表里的"最后活跃"：刚刚 / N 分钟前 / N 小时前 / MM-DD HH:mm。 */
    function relativeTime(ms) {
      const t = Number(ms);
      if (!t) return "时间未知";
      const diff = Date.now() - t;
      if (diff < 60_000) return "刚刚";
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function Section() {
      const [status, setStatus] = useState(null);
      const [statusErr, setStatusErr] = useState("");
      const [model, setModel] = useState(null);
      const [provider, setProvider] = useState("");
      const [modelName, setModelName] = useState("");
      // 可选清单来自 /models（DSH 的 llm 注册表）。空数组时退回手动输入。
      const [catalog, setCatalog] = useState([]);
      const [catalogErr, setCatalogErr] = useState("");
      const [manual, setManual] = useState(false);
      const [pair, setPair] = useState(null);
      // 生成的二维码可能有多个（以太网 / Wi-Fi / Tailscale），记住用户选了哪一个
      const [qrIdx, setQrIdx] = useState(0);
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
        // 可选清单：拿不到就退回手动输入（不阻塞上面两块）
        const c = await api("/models");
        if (c?.ok && Array.isArray(c.providers)) {
          setCatalog(c.providers);
          setCatalogErr(c.providers.length ? "" : "DSH 没有报告任何可用 provider");
        } else {
          setCatalog([]);
          setCatalogErr(c?.hint || c?.error || "取不到可选模型清单");
        }
        // 角色上下文（「把鱼带到手机」）：拿不到就整块提示，不影响上面几块
        const p = await api("/persona");
        if (p?.ok) {
          setPersona(p);
          setPersonaErr("");
        } else {
          setPersona(null);
          setPersonaErr(p?.hint || p?.error || "读不到角色上下文状态");
        }
        // 已配对设备：网络抖动时保留上次结果，只改错误提示
        const dv = await api("/devices");
        if (dv?.ok) {
          setDevices(dv.devices || []);
          setDevicesErr("");
        } else {
          setDevicesErr(dv?.hint || dv?.error || "读不到设备列表");
        }
        setBusy("");
      }, []);

      const [persona, setPersona] = useState(null);
      const [personaErr, setPersonaErr] = useState("");
      const [devices, setDevices] = useState([]);
      const [devicesErr, setDevicesErr] = useState("");
      /** 第一次点「吊销」只标记；第二次才真执行（不弹 confirm，WebView 里行为不一致） */
      const [revokePending, setRevokePending] = useState("");

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
        if (r?.ok) {
          setPair(r);
          setQrIdx(0);
          setLeft(r.expiresAt ? Math.ceil((Number(r.expiresAt) - Date.now()) / 1000) : 0);
        } else setErr(r?.hint || r?.error || "生成失败");
      };

      const startGateway = async () => {
        setBusy("starting");
        setErr("");
        setNote("");
        const r = await api("/start", { method: "POST" });
        setBusy("");
        if (r?.ok) {
          setNote(r.already ? "网关本来就在跑，已刷新状态。" : `网关已启动（PID ${r.pid ?? "?"}），日志在 ${r.log || "状态目录"}。`);
          refresh();
        } else if (isStaleHost(r)) {
          // 设置页 JS 是每次打开重新取的，宿主插件却只在 DSH 启动时加载。
          // 两边版本不一致时会出现「有按钮、没接口」，这里必须说清是重启 DSH，不是网关坏了。
          setErr("DSH 还在运行旧版插件（没有启动接口，HTTP 405）。\n请完全退出 DSH（托盘图标 → 退出）再打开，然后重试。");
        } else {
          setErr([r?.error, r?.hint].filter(Boolean).join("\n"));
        }
      };

      const stopGateway = async () => {
        setBusy("stopping");
        setErr("");
        setNote("");
        const r = await api("/stop", { method: "POST" });
        setBusy("");
        if (r?.ok) {
          setNote("网关已停止。");
          refresh();
        } else {
          setErr([r?.error, r?.hint].filter(Boolean).join("\n"));
        }
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
        } else if (isStaleHost(r)) {
          setErr("DSH 还在运行旧版插件（HTTP 405），请完全退出 DSH 再打开后重试。");
        } else {
          setErr(r?.hint || r?.error || "保存失败");
        }
      };

      const revoke = async (id) => {
        if (revokePending !== id) {
          setRevokePending(id);
          return;
        }
        setRevokePending("");
        setErr("");
        setNote("");
        const r = await api("/devices/revoke", { method: "POST", body: JSON.stringify({ id }) });
        if (r?.ok) {
          setNote(`已吊销，剩余 ${r.remaining} 台。那台手机需要重新配对。`);
          refresh();
        } else {
          setErr(r?.hint || r?.error || "吊销失败");
        }
      };

      const togglePersona = async () => {
        setBusy("persona");
        setErr("");
        setNote("");
        const r = await api("/persona", {
          method: "PUT",
          body: JSON.stringify({ enabled: !persona?.enabled }),
        });
        setBusy("");
        if (r?.ok) {
          setPersona(r);
          setNote(r.enabled ? "已开启：手机的对话会带上这个角色的人格与记忆。" : "已关闭：手机只当普通助手，不带角色。");
        } else if (isStaleHost(r)) {
          setErr("DSH 还在运行旧版插件（HTTP 405），请完全退出 DSH 再打开后重试。");
        } else {
          setErr(r?.hint || r?.error || "改不动这个开关");
        }
      };

      /** 手机固定用哪条鱼；空值 = 跟随桌面当前角色。 */
      const changeCharacter = async (id) => {
        setBusy("persona");
        setErr("");
        setNote("");
        const r = await api("/persona", {
          method: "PUT",
          body: JSON.stringify({ characterId: id || null }),
        });
        setBusy("");
        if (r?.ok) {
          setPersona(r);
          const tail = r.enabled ? "" : " 注入当前是关闭的，点右上角「开启」后才会生效。";
          setNote(id
            ? `手机已固定使用「${r.character || id}」，下一条消息生效；旧会话里仍是原角色，建议新开一个。${tail}`
            : `已改为跟随桌面当前角色。${tail}`);
        } else if (isStaleHost(r)) {
          setErr("DSH 还在运行旧版插件（HTTP 405），请完全退出 DSH 再打开后重试。");
        } else {
          setErr([r?.error, r?.hint].filter(Boolean).join("\n"));
        }
      };

      const running = Boolean(status?.running);

      const copyText = async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          setNote(`已复制：${text}`);
        } catch {
          // 非 https 或浏览器不给权限时 clipboard 会失败——退化成让用户手动选
          setNote(`复制失败，请手动选中这行：${text}`);
        }
      };

      return h("div", { style: { padding: "4px 2px" } },
        h("h2", { style: { fontSize: "16px", margin: "0 0 4px" } }, "手机网关"),
        h("p", { style: { ...label, marginBottom: "14px" } },
          "手机 App ⇄ 本机网关 ⇄ DSH。这里管三件事：网关在不在、配对码、手机端用哪个模型。"),

        // ① 状态
        h("div", { style: box },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", gap: "8px" } },
            h("strong", { style: { fontSize: "13px" } }, "① 网关状态"),
            h("div", { style: { display: "flex", gap: "8px" } },
              // 网关没跑时，这里就是启动入口——不用去双击 bat、不用开命令行
              running
                ? (status?.managed
                    ? h("button", { style: btn(), onClick: stopGateway, disabled: busy === "stopping" },
                        busy === "stopping" ? "停止中…" : "停止网关")
                    : null)
                : h("button", {
                    style: btn({ borderColor: "rgba(63,185,80,.7)", color: "#3fb950" }),
                    onClick: startGateway,
                    disabled: busy === "starting",
                  }, busy === "starting" ? "启动中…（最多约 10 秒）" : "启动网关"),
              h("button", { style: btn(), onClick: refresh, disabled: busy === "refresh" },
                busy === "refresh" ? "刷新中…" : "刷新"))),
          running
            ? h("div", null,
                h(Row, { k: "运行中", v: "是", tone: "#3fb950" }),
                h(Row, { k: "监听", v: status.listen ? `${status.listen.host}:${status.listen.port}` : "?" }),
                // 手机该填哪个地址 —— 之前这块只显示 0.0.0.0，用户根本不知道该抄什么
                h("div", { style: { margin: "6px 0 8px" } },
                  h("div", { style: { ...label, marginBottom: "4px" } }, "手机端「网关地址」填："),
                  (status.addresses && status.addresses.loopbackOnly)
                    ? h("div", { style: { fontSize: "12.5px", color: "#d29922", lineHeight: 1.6 } },
                        "网关只监听了回环地址（127.0.0.1），手机连不上。",
                        h("br"), "点「停止网关」后重新点「启动网关」会用 0.0.0.0:8788 重新启动。")
                    : ((status.addresses && status.addresses.list) || []).length
                      ? (status.addresses.list).map((a) =>
                          h("div", { key: a.ip, style: { display: "flex", gap: "8px", alignItems: "center", padding: "2px 0", flexWrap: "wrap" } },
                            h("code", { style: { ...mono, fontSize: "13.5px" } }, a.url),
                            h("button", { style: btn({ padding: "3px 9px", fontSize: "12px" }), onClick: () => copyText(a.url) }, "复制"),
                            a.tailscale ? h("span", { style: { fontSize: "11.5px", opacity: 0.8 } }, "Tailscale，外出也能用") : null))
                      : h("div", { style: { fontSize: "12.5px", color: "#d29922" } },
                          "没检测到局域网 IP：先连上 Wi-Fi/网线（网关正在监听所有网卡）。"),
                ),
                h(Row, { k: "DSH", v: status.dsh?.connected ? `已连接（${status.dsh.name || "?"}）` : "未连接", tone: status.dsh?.connected ? "#3fb950" : "#d29922" }),
                h(Row, { k: "已配对", v: `${status.devices ?? 0} 台设备` }),
                status?.managed
                  ? null
                  : h("div", { style: { ...label, marginTop: "6px", lineHeight: 1.6 } },
                      "这个网关是从命令行/start-gateway.bat 起的：这里只能看状态，停止要关掉那个窗口。"))
            : h("div", null,
                h(Row, { k: "运行中", v: "否", tone: "#f85149" }),
                h("div", { style: { ...label, marginTop: "8px", lineHeight: 1.6 } },
                  "点右上角「启动网关」即可，不用开命令行；手机要能连，网关会监听 0.0.0.0:8788。"),
                status?.log
                  ? h("div", { style: { ...label, ...mono, marginTop: "6px", fontSize: "11px", wordBreak: "break-all" } }, `日志：${status.log}`)
                  : null,
                status?.lastError
                  ? h("div", {
                      style: {
                        marginTop: "8px", padding: "8px 10px", borderRadius: "8px",
                        background: "rgba(248,81,73,.12)", fontSize: "12px", lineHeight: 1.6,
                        whiteSpace: "pre-wrap", wordBreak: "break-word",
                      },
                    }, [status.lastError.error, status.lastError.hint].filter(Boolean).join("\n"))
                  : null,
                h("div", { style: { ...label, marginTop: "8px", lineHeight: 1.6 } },
                  "也可以用 start-gateway.bat 启动（那个窗口要一直开着；DSH 退出也不受影响）。",
                  "按钮启动的网关会跟着 DSH 一起停，随时可以在这里关掉。"))),

        // ② 配对码 / 扫码配对
        h("div", { style: box },
          h("strong", { style: { fontSize: "13px" } }, "② 配对（扫码或手输）"),
          h("p", { style: { ...label, margin: "6px 0 8px", lineHeight: 1.6 } },
            "换手机、重装 App 时需要。5 分钟内有效，过期重新生成即可；平时不用管。",
            h("br"),
            "二维码里同时带着网关地址和配对码，手机 App 里点「扫码配对」扫一下就行。"),
          h("div", { style: { display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" } },
            h("button", { style: btn(), onClick: makePair, disabled: !running || busy === "pair" },
              busy === "pair" ? "生成中…" : "生成二维码 / 配对码"),
            pair?.code
              ? h("span", { style: { ...mono, fontSize: "22px", letterSpacing: "4px" } }, pair.code)
              : null,
            pair?.code
              ? h("span", { style: { ...label, marginBottom: 0 } }, left > 0 ? `${left} 秒后失效` : "已失效，请重新生成")
              : null),

          // 二维码生成失败/没有可用地址：必须当场说清怎么办，不能只留一个空位
          pair?.warn
            ? h("div", {
                style: {
                  marginTop: "10px", padding: "9px 12px", borderRadius: "8px",
                  background: "rgba(210,153,34,.14)", fontSize: "12.5px", lineHeight: 1.65,
                },
              },
                h("div", null, pair.warn.error),
                h("div", { style: { opacity: 0.85 } }, pair.warn.hint || ""))
            : null,

          (() => {
            const urls = Array.isArray(pair?.urls) ? pair.urls : [];
            // 网关没重启时接口还是旧版：不报错，但也拿不到矩阵——必须说清原因
            if (!urls.length) {
              if (!pair?.code || pair.warn || left <= 0) return null;
              return h("p", { style: { ...label, margin: "10px 0 0", lineHeight: 1.65 } },
                "网关还在跑旧版本，这次没返回二维码。重启网关窗口后再点「生成」，就能扫了；现在仍可以用上面的 6 位码手输。");
            }
            // 过期的码扫了只会得到「配对码过期」；与其让人扫一张废码，不如直接收起来
            if (left <= 0) return null;
            const idx = Math.min(qrIdx, urls.length - 1);
            const cur = urls[idx];
            return h("div", { style: { marginTop: "14px" } },
              urls.length > 1
                ? h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" } },
                    urls.map((u, i) =>
                      h("button", {
                        key: u.url,
                        style: btn({
                          padding: "4px 10px", fontSize: "12px",
                          borderColor: i === idx ? "rgba(63,185,80,.9)" : undefined,
                          color: i === idx ? "#3fb950" : "inherit",
                        }),
                        onClick: () => setQrIdx(i),
                      }, u.tailscale ? `Tailscale · ${u.ip}` : u.ip)))
                : null,
              h("div", { style: { display: "flex", gap: "20px", alignItems: "flex-start", flexWrap: "wrap" } },
                qrSvg(cur.qr, 216),
                h("div", { style: { flex: "1 1 180px", minWidth: "180px" } },
                  h("div", { style: label }, "这个二维码对应的地址"),
                  h("div", { style: { ...mono, fontSize: "12.5px", wordBreak: "break-all" } }, cur.url),
                  h("p", { style: { ...label, marginTop: "10px", lineHeight: 1.65 } },
                    "手机 App 配对页 →「扫码配对」，对着这个二维码扫。",
                    h("br"),
                    "也可以直接用系统相机/微信扫，点结果里的链接会打开 App。"))));
          })()),

        // ③ 模型
        h("div", { style: box },
          h("strong", { style: { fontSize: "13px" } }, "③ 手机端用哪个模型"),
          h("p", { style: { ...label, margin: "6px 0 10px", lineHeight: 1.6 } },
            "手机走的是 DSH 的 acp profile，和桌面端不是同一份配置。下面两项改完点保存，网关会自动重连 ACP（不用重启窗口，不用重装 App）。"),
          model && model.current
            ? h("div", { style: { ...label, marginBottom: "10px" } },
                "当前：", h("span", { style: mono }, `${model.current.provider} / ${model.current.model}`))
            : h("div", { style: { ...label, marginBottom: "10px" } }, "当前：未配置（ACP 会用 deepseek-official，多半会报 no API key）"),
          (() => {
            const useSelect = catalog.length > 0 && !manual;
            const models = (catalog.find((p) => p.id === provider) || {}).models || [];
            return h("div", { style: { display: "grid", gap: "10px" } },
              h("div", null,
                h("div", { style: label }, "provider"),
                useSelect
                  ? h("select", {
                      style: input,
                      value: provider,
                      onChange: (e) => {
                        const next = e.target.value;
                        setProvider(next);
                        // 换 provider 时把 model 落到它的第一个，避免留下不属于它的型号
                        const first = (catalog.find((p) => p.id === next) || {}).models?.[0];
                        setModelName(first ? first.id : "");
                      },
                    },
                    catalog.map((p) => h("option", { key: p.id, value: p.id }, p.id)))
                  : h("input", { style: input, value: provider, onChange: (e) => setProvider(e.target.value), placeholder: "our-free-model / deepseek-account / ..." })),
              h("div", null,
                h("div", { style: label }, "model"),
                useSelect
                  ? h("select", {
                      style: input,
                      value: modelName,
                      onChange: (e) => setModelName(e.target.value),
                    },
                    models.length
                      ? models.map((m) => h("option", { key: m.id, value: m.id }, m.id))
                      : h("option", { value: "" }, "（这个 provider 没报模型）"))
                  : h("input", { style: input, value: modelName, onChange: (e) => setModelName(e.target.value), placeholder: "kilo-auto/free / deepseek-v4.1-flash / ..." })),
              h("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
                catalog.length
                  ? h("button", { style: btn({ padding: "4px 10px", fontSize: "12px" }), onClick: () => setManual(!manual) },
                      manual ? "改用下拉选择" : "手动填写")
                  : null,
                catalogErr ? h("span", { style: { ...label, marginBottom: 0 } }, catalogErr) : null));
          })(),
          h("div", { style: { display: "flex", gap: "10px", marginTop: "12px", alignItems: "center" } },
            h("button", { style: btn(), onClick: saveModel, disabled: !running || busy === "save" || !provider || !modelName },
              busy === "save" ? "保存中…" : "保存并生效"),
            model?.file ? h("span", { style: { ...label, marginBottom: 0, ...mono, fontSize: "11px", wordBreak: "break-all", maxWidth: "60%" } }, model.file) : null)),

        // ④ 角色上下文（「把鱼带到手机」）
        h("div", { style: box },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" } },
            h("strong", { style: { fontSize: "13px" } }, "④ 手机上是「哪条鱼」"),
            h("button", {
              style: btn({ padding: "4px 12px", fontSize: "12px" }),
              onClick: togglePersona,
              disabled: !running || !persona?.available || busy === "persona",
            }, busy === "persona" ? "切换中…" : (persona?.enabled ? "关闭" : "开启"))),
          personaErr
            ? h("p", { style: { ...label, margin: 0, color: "#d29922", lineHeight: 1.6 } }, personaErr)
            : !persona?.available
              ? h("p", { style: { ...label, margin: 0, lineHeight: 1.6 } },
                  "没找到 SurfCore 的角色（",
                  persona?.reason === "no-character" ? "还没创建角色" : (persona?.reason || "未安装"),
                  "）。装好 SurfCore 并选中一个角色后，这里会出现它的名字。")
              : h("div", null,
                  // 本机有多条鱼时才给选择器：只有一条时选不选都一样，多一个控件只会添乱
                  (persona.characters || []).length > 1
                    ? h("div", { style: { margin: "6px 0 10px" } },
                        h("div", { style: label }, "手机固定用哪条鱼"),
                        h("select", {
                          style: input,
                          value: persona.selectedId || "",
                          disabled: !running || busy === "persona",
                          onChange: (e) => changeCharacter(e.target.value),
                        },
                          h("option", { value: "" },
                            persona.followingDesktop && persona.character
                              ? `跟随桌面当前（${persona.character}）`
                              : "跟随桌面当前角色"),
                          (persona.characters || []).map((c) => h("option", { key: c.id, value: c.id }, c.name))),
                        persona.selectionMissing
                          ? h("div", { style: { ...label, marginTop: "6px", lineHeight: 1.6, color: "#d29922" } },
                              "之前固定的角色在这台电脑上已经没有了，现在临时用桌面当前角色，请重新选一个。")
                          : null,
                        h("div", { style: { ...label, marginTop: "6px", lineHeight: 1.6 } },
                          "切换后从下一条消息开始生效；旧会话的上下文里仍是原角色，建议新开一个会话。"))
                    : h("div", { style: { ...label, margin: "6px 0 10px", lineHeight: 1.6 } },
                        "本机只有一条鱼，所以没有可选项；在 SurfCore 里再建一条后，这里会出现「手机固定用哪条鱼」。"),
                  h(Row, { k: "状态", v: persona.enabled ? "已开启" : "已关闭", tone: persona.enabled ? "#3fb950" : undefined }),
                  h(Row, { k: "角色", v: persona.character || "?" }),
                  h(Row, { k: "来源", v: persona.followingDesktop ? "跟随桌面当前角色" : "手机固定选择" }),
                  h(Row, { k: "SurfCore", v: persona.surfcoreVersion ? `v${persona.surfcoreVersion}` : "版本未知" }),
                  h(Row, {
                    k: "注入内容",
                    v: persona.memorySkipped
                      ? `人格 ${persona.personaChars} 字（记忆卡在 SurfCore 里已关闭，只送人格）`
                      : `人格 ${persona.personaChars} 字 + 记忆 ${persona.memoryChars} 字 / 上限 ${persona.maxChars ?? "?"}${persona.truncated ? "（已截断）" : ""}`,
                  }),
                  h(Row, { k: "已生效会话", v: (persona.sessions || []).length ? `${persona.sessions.length} 个` : "还没有（发第一条消息时生效）" }),
                  h("p", { style: { ...label, margin: "8px 0 0", lineHeight: 1.65 } },
                    "开启后，手机发的第一条消息会带上这条鱼的人格卡与记忆卡，此后它记得的事和 QQ 上是同一份。",
                    h("br"),
                    "第一轮之后不会每轮重复注入（省 token，也避免它把设定当成反复叮嘱）；电脑上的记忆更新时，会自动再注入一次。"))),

        // ⑤ 已配对设备
        h("div", { style: box },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" } },
            h("strong", { style: { fontSize: "13px" } }, `⑤ 已配对设备（${devices.length}）`),
            h("button", {
              style: btn({ padding: "4px 10px", fontSize: "12px" }),
              onClick: () => {
                if (revokePending !== "__all__") { setRevokePending("__all__"); return; }
                setRevokePending("");
                api("/devices/revoke", { method: "POST", body: JSON.stringify({ all: true }) })
                  .then((r) => {
                    if (r?.ok) { setNote(`已清空 ${r.revoked} 台设备，之后每台手机都要重新配对。`); refresh(); }
                    else setErr(r?.hint || r?.error || "清空失败");
                  });
              },
              disabled: !running || devices.length === 0,
            }, revokePending === "__all__" ? "再点一次确认清空" : "清空全部")),
          h("p", { style: { ...label, margin: "4px 0 10px", lineHeight: 1.6 } },
            "手机丢了、换机、或想清掉测试机时在这里吊销。吊销后那台手机要重新扫码配对；不影响正在用的其它设备。"),
          devicesErr
            ? h("div", { style: { ...label, margin: 0, color: "#d29922" } }, devicesErr)
            : devices.length === 0
              ? h("div", { style: { ...label, margin: 0 } }, "还没有配对的设备。")
              : h("div", { style: { display: "grid", gap: "6px" } },
                  devices.map((d) => h("div", {
                    key: d.id,
                    style: {
                      display: "flex", alignItems: "center", gap: "10px",
                      padding: "6px 8px", borderRadius: "8px",
                      background: "rgba(127,127,127,.08)",
                    },
                  },
                    h("div", { style: { flex: 1, minWidth: 0 } },
                      h("div", { style: { fontSize: "12.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                        `${d.name || "未命名设备"}`),
                      h("div", { style: { ...label, margin: 0, ...mono, fontSize: "11px", opacity: 0.75 } },
                        `${d.id} · ${relativeTime(d.lastSeenAt || d.createdAt)}`)),
                    h("button", {
                      style: btn({ padding: "3px 9px", fontSize: "11.5px" }),
                      onClick: () => revoke(d.id),
                      disabled: revokePending !== "" && revokePending !== d.id,
                    }, revokePending === d.id ? "确认吊销" : "吊销"))))),

        note ? h("div", { style: { padding: "9px 12px", borderRadius: "8px", background: "rgba(63,185,80,.12)", fontSize: "12.5px", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, note) : null,
        (err || statusErr) ? h("div", { style: { padding: "9px 12px", borderRadius: "8px", background: "rgba(248,81,73,.12)", fontSize: "12.5px", marginTop: "8px", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, err || statusErr) : null,
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
