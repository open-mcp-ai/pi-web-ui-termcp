/**
 * termcp 窗口 —— 把反代过来的 termcp 界面铺满顶栏视图。
 *
 * 为什么用 iframe 而不是重写：termcp 的前端是一整套终端工作区（xterm 网格、
 * 会话窗口、标签页、端口转发对话框、审批队列）。重写就是维护第二份实现，而且
 * 一定会漂移。宿主的 registerProxy 就是为这个准备的 —— 它转发 HTTP 和
 * WebSocket 升级（终端 I/O 走 WebSocket）。
 *
 * 地址推导：iframe 指向 `<应用根><prefix>/`，根从**本 bundle 自己的 URL** 算出来
 * （`.../plugins/termcp/client/`）。这样 pi-web-ui 挂在 nginx 子路径下也能解析，
 * 插件不必硬编码应用根。prefix 是设置项，服务端随状态消息送来 —— 视图 ctx
 * 读不到设置。
 *
 * 状态栏只说一件事：AI 那边通没通。它不探测端口（那是宿主 MCP 桥的事，
 * 而且第二意见只会跟它打架），也不报反代挂没挂上 —— 宿主 registerProxy 失败时
 * 返回的是「一个什么都不做的函数」，插件侧分辨不出，谎报比不报更糟。
 *
 * 工具栏上的开关：只发意图（`{type:"switch",on}`），等回执（status 里的 enabled）
 * 才更新显示——不先本地置位，免得写失败时界面骗人。兵底超时防回包丢失卡死。
 */
export default {
	mount(container, ctx) {
		container.style.cssText = "height:100%;width:100%;display:flex;flex-direction:column;min-height:0";

		const bar = document.createElement("div");
		bar.style.cssText =
			"display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:12px;border-bottom:1px solid var(--border-subtle,#223);color:var(--text-dim,#94a3b8);flex:none";
		const label = document.createElement("span");
		label.textContent = "termcp";
		const state = document.createElement("span");
		state.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
		const note = document.createElement("span");
		note.style.cssText = "font-size:11px;opacity:.7;white-space:nowrap";
		const reload = document.createElement("button");
		reload.type = "button";
		reload.textContent = "重载";
		reload.style.cssText =
			"all:unset;cursor:pointer;padding:1px 8px;border:1px solid var(--border-subtle,#223);border-radius:5px;font-size:11px";
		const open = document.createElement("a");
		open.textContent = "新标签打开";
		open.style.cssText = "color:inherit;font-size:11px;text-decoration:underline;cursor:pointer";
		// 开关。放在窗口里是因为声明式设置埋在「设置 → 界面插件 → 展开配置」三层下，
		// 而用到 termcp 的人就在这个窗口里。
		const toggleLabel = document.createElement("label");
		toggleLabel.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px";
		toggleLabel.title = "关闭 = 拆掉窗口反代 + 停用 MCP（AI 不再拿到 termcp 工具）；与设置 →「MCP」里那个开关是同一个";
		const toggle = document.createElement("input");
		toggle.type = "checkbox";
		toggle.style.cssText = "margin:0;cursor:pointer";
		const toggleText = document.createElement("span");
		toggleText.textContent = "启用";
		toggleLabel.append(toggle, toggleText);
		bar.append(label, state, note, open, toggleLabel, reload);

		const frame = document.createElement("iframe");
		frame.title = "termcp";
		// clipboard：终端工作区要复制粘贴。
		frame.setAttribute("allow", "clipboard-read; clipboard-write");
		frame.style.cssText = "flex:1;min-height:0;width:100%;border:0;background:transparent";

		// (…/plugins/termcp/client/) → 应用根。部署在根时为空串。
		const base = new URL("../../..", import.meta.url).pathname.replace(/\/+$/, "");

		let prefix = "/termcp"; // 服务端报出真实值之前的缺省
		const load = () => {
			const src = `${base}${prefix}/`;
			if (frame.getAttribute("src") === src) return;
			frame.src = src;
			open.href = src;
			open.target = "_blank";
			open.rel = "noreferrer";
		};

		container.append(bar, frame);
		load();

		const setState = (text, tone) => {
			state.textContent = text;
			state.style.color = tone === "warn" ? "var(--amber,#f59e0b)" : tone === "bad" ? "var(--red,#f87171)" : "inherit";
		};
		setState("正在读取状态…", null);

		const off = ctx?.onData?.((msg) => {
			if (!msg || msg.type !== "status" || !msg.payload) return;
			const p = msg.payload;

			if (typeof p.prefix === "string" && p.prefix && p.prefix !== prefix) {
				prefix = p.prefix;
				load();
			}

			// 服务端是权威：开关的回显一律听它的（不先本地置位，免得写失败时状态骗人）。
			toggle.checked = p.enabled !== false;
			toggle.disabled = false;
			toggleText.textContent = toggle.checked ? "启用" : "已关闭";

			const where = `127.0.0.1:${p.port} · ${p.prefix}/`;
			// 关掉时反代已经拆了，iframe 只会撞上宿主 SPA 兜底（在「termcp 窗口」里
			// 显示 pi-web-ui 自己）——那是最困惑的失败。所以先把 frame 收起来。
			if (p.enabled === false) {
				frame.style.display = "none";
			setState("termcp 已关闭 · 勾上面的「启用」重新打开", "warn");
				note.textContent = "AI 现在拿不到 termcp 工具";
				return;
			}
			frame.style.display = "";

			if (p.mcp === "ok") {
				setState(`运行中 · ${where} · AI 可用 ${p.toolCount} 个工具`, null);
				note.textContent = "";
			} else if (p.mcp === "stopped") {
				setState(`窗口可用 · ${where} · MCP 已配置但未运行`, "warn");
				note.textContent = String(p.mcpNote ?? "");
			} else if (p.mcp === "failed") {
				setState(`窗口可用 · ${where} · MCP 接入失败`, "bad");
				note.textContent = String(p.mcpNote ?? "");
			} else if (p.mcp === "no-host-api") {
				setState(`窗口可用 · ${where} · 当前 pi-web-ui 没有 host.mcp`, "warn");
				note.textContent = "AI 工具需 pi-web-ui 0.104.0+";
			} else {
				setState(`已挂载 ${where} · 正在接入 MCP…`, null);
				note.textContent = "";
			}
		});

		ctx?.send?.({ type: "status" });

		// 开关：只发意图，等回执（onData 里的 enabled）才更新显示。
		// 加一个兵底超时：回包丢了（服务端忙 / 通道断）不能把按钮永久卡在禁用态。
		let toggleTimer = 0;
		toggle.addEventListener("change", () => {
			toggle.disabled = true;
			ctx?.send?.({ type: "switch", on: toggle.checked });
			clearTimeout(toggleTimer);
			toggleTimer = setTimeout(() => {
				toggle.disabled = false;
				ctx?.send?.({ type: "status" });
			}, 8000);
		});

		reload.addEventListener("click", () => {
			// 先把 src 清掉再设回去，强制真刷新：termcp 的会话存在服务端，
			// 刷新是重连，不丢东西。
			const cur = frame.src;
			frame.src = "about:blank";
			requestAnimationFrame(() => {
				frame.src = cur;
			});
			ctx?.send?.({ type: "status" });
		});

		return () => {
			clearTimeout(toggleTimer);
			off?.();
			container.textContent = "";
		};
	},
};
