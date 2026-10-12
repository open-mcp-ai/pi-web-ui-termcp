/**
 * termcp — two things, and nothing else.
 *
 *  1. **一台 MCP 服务器。** 用官方那条命令把 termcp 配好，AI 就有它的工具。
 *  2. **一个窗口。** 把 `<prefix>` 反代到 termcp 的 HTTP 端口，嵌进顶栏看。
 *
 * 没有别的。不探测 termcp 在不在跑（`daemon stdio` 本身就是「确保实例存在」），
 * 不解析二进制路径（npx 会做），不写配置文件（`host.mcp.install` 会写），
 * 不管进程生命周期（宿主会管）。
 *
 * 命令就是 termcp.org 给所有客户端的那一条，无条件使用：
 *
 *     npx -y @open-mcp-ai/termcp daemon stdio
 *
 * ── 为什么要预热（唯一一处不那么显然的代码）────────────────────────────────
 *
 * 宿主的 MCP 握手超时是**硬编码的 8 秒**（`mcp-bridge.ts` 的 `start(timeoutMs = 8000)`，
 * 配置里的 `timeout` 字段只存不读），而 npx 首次运行要下载 ~12MB 二进制。实测不预热：
 *
 *     [mcp] 服务器「termcp」启动失败： initialize 超时 (8000ms) → 0 个工具
 *
 * 所以 install 之前先跑一次 `-version` 让它落地。装过之后这步是瞬间的。
 */

/** termcp 自己的默认端口。 */
const DEFAULT_PORT = 18765;
/** 反代挂载路径。 */
const DEFAULT_PREFIX = "/termcp";
/** 官方命令。改这里之前先看 termcp.org —— 所有客户端用的都是它。 */
const CMD = ["npx", "-y", "@open-mcp-ai/termcp"];
/** 等 npx 冷启动把二进制下载完。一次性开销，给足。 */
const WARMUP_TIMEOUT_MS = 180000;
/**
 * 归属标记。宿主 `check()` 分不出「谁配的」，靠它认出自己写的那条 ——
 * 写进 `description`（`saveMcpServer` 会持久化，`listAllMcpServers` 会读回来）。
 */
const MARK = "[plugin:termcp]";

export default {
	activate(host) {
		const port = () => {
			const n = Number(host.getSettings()?.port);
			return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : DEFAULT_PORT;
		};
		const prefix = () => {
			const p = String(host.getSettings()?.prefix ?? DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
			return p.startsWith("/") ? p.replace(/\/+$/, "") : `/${p}`;
		};
		/**
		 * 开关。**真正落地的地方只有一个：MCP 配置条目自己的 `enabled`** —— MCP 面板里
		 * 那个开关、窗口工具栏那个勾选框，最终改的都是它。
		 *
		 * 为什么不用声明式设置项另做一个开关：插件接口面上 `getSettings` /
		 * `onSettingsChanged` 都是**只读**的（写设置是 `PluginManager.savePluginSettings`，
		 * 只在 Web 客户端的 `plugin_settings` 消息路径上，插件构不到）。更要紧的是两个
		 * 真相源一定会打架 —— 实测踩过：在 MCP 面板里停用 termcp，插件又把它默启回来。
		 *
		 * 语义（对应用户的预期）：
		 *   - 条目 `enabled: false` → **不碰它**，绝不自作主张装回来；
		 *   - 条目不存在 → 看用户最后说过什么；没说过（首次）才装；
		 *   - 条目 `enabled: true` 但参数变了 → 刷新。
		 * 要彻底删条目：设置 →「MCP」里的垃圾桶（宿主的 Web 消息路径，插件构不到）。
		 */
		/** 窗口刚拨的开关意图：true/false = 待应用；null = 没有待应用的意图。 */
		let desired = null;
		/**
		 * 用户最后表达的开关意愿（true/false），**落盘**（storage.json 的 `wanted` 键）。
		 *
		 * 用途：关掉后用户去 MCP 面板把条目**删了** —— 条目就不存在于任何地方了，
		 * 这时若只看「条目不存在」，会被当成「首次安装」而把它复活。而用户说的
		 * 「卸载就是删了」「disable 就不该装回来」都是同一个意思：**别自作主张**。
		 *
		 * 它只在条目**不存在**时参与判断，所以不是第二个开关、不会与条目打架：
		 * 条目在就听条目的（含 MCP 面板拨的），条目不在才看这里（无值 = 首次装）。
		 */
		const WANTED_KEY = "wanted";
		const readWanted = () => {
			const v = host.storage?.get?.(WANTED_KEY);
			return v === true || v === false ? v : null;
		};
		let lastIntent = readWanted();
		const rememberIntent = (v) => {
			lastIntent = v;
			try {
				host.storage?.set?.(WANTED_KEY, v);
			} catch {
				/* 存不下就只活在内存里：本进程内仍然一致 */
			}
		};
		/** 上一次 sync 看到的条目 enabled（null = 条目不存在），供窗口回显与挂反代判断。 */
		let lastEntryEnabled = null;

		// ── 1. 反代：让窗口有东西可看 ──────────────────────────────────────────
		/** 当前注册前缀的注销函数（注册被拒时是宿主给的空操作函数）。 */
		let offProxy = null;
		/** 反激活后置位：晚到的 status 不该把已拆掉的反代又挂回来。 */
		let stopped = false;
		/** 上次注册的「前缀 → 端口」，只用来决定要不要写日志。 */
		let mountedKey = "";
		/** 撤掉反代（幂等）。 */
		const unmount = () => {
			const off = offProxy;
			offProxy = null;
			try {
				off?.();
			} catch {
				/* 已经注销过了 */
			}
		};
		const mount = () => {
			if (stopped) return;
			// 关掉时不留反代：一个指向「已停用服务」的路由只会让窗口变成 502，
			// 客户端那边有明确的「已关闭」占位，比一个坏 iframe 清楚。
			if (lastEntryEnabled === false) {
				unmount();
				mountedKey = "";
				return;
			}
			// 必须先撤旧的再挂：宿主的副作用栈是**每注册一次 push 一条**
			// （`effects.add`），不撤就重挂会每问一次状态就漏一条，栈无限长。
			// 撤与挂之间没有 await，同一个 tick 内完成，不会给请求留空窗。
			unmount();
			// 重挂是必要的：前缀若被**另一个**插件占着，这一次会挂不上，而它让位后
			// 下一次问状态就自愈了。宿主侧分辨不出成败（`registerProxy` 失败时返回的
			// 同样是「一个什么都不做的函数」，不是 null），失败只进它的运行时诊断，
			// 插件不谎报状态、也不重复判断。
			const p = prefix();
			const pt = port();
			offProxy = host.registerProxy(p, { port: pt });
			const key = `${p} → 127.0.0.1:${pt}`;
			if (key !== mountedKey) {
				mountedKey = key;
				host.log("info", `proxy ${key}`);
			}
		};

		// ── 2. MCP：把工具交给 AI ──────────────────────────────────────────────
		/**
		 * 交给宿主的启动目标。`daemon stdio` 就是「确保实例存在」：在跑就接管，
		 * 没在跑就拉起。`--idle-timeout` 只作用于它自己拉起的实例，用户手动启的
		 * 那个不受影响。
		 */
		const target = () => ({
			name: "termcp",
			command: CMD[0],
			args: [...CMD.slice(1), "daemon", "stdio", "--port", String(port()), "--idle-timeout", "10m"],
			scope: "global",
			description: `termcp — AI-native terminal ${MARK}`,
		});

		/** 当前状态，给窗口的状态栏用。 */
		let state = "pending";
		let note = "";
		let toolCount = 0;

		const sync = async () => {
			// 老宿主（0.104.0 之前）没有 host.mcp。查能力，不查版本号：
			// `manifest.engines` 在发布包里是坏的（`readHostVersion()` 读的
			// `<pkgRoot>/package.json` 不在 tarball 里，回 null 后静默放行），
			// 约束不会生效还每次激活吐一条误导警告。
			if (typeof host.mcp?.check !== "function" || typeof host.mcp?.install !== "function") {
				state = "no-host-api";
				note = "当前 pi-web-ui 没有 host.mcp（需要 0.104.0+）";
				host.log("warn", "当前宿主没有 host.mcp 接口（需 pi-web-ui 0.104.0+）——只有窗口可用，AI 看不到 termcp 工具");
				return;
			}
			try {
				const want = target();
				const before = await host.mcp.check("termcp");
				const current = before?.server;
				// 只碰自己写的那条（带归属标记）；用户手写的条目一律不碰。
				const ours = before?.installed && String(current?.description ?? "").includes(MARK);
				const same =
					ours &&
					current?.command === want.command &&
					JSON.stringify(current?.args ?? []) === JSON.stringify(want.args);

				// ── 想要开还是关 ────────────────────────────────────────────────
				// 窗口刚拨的意图优先（那是用户刚做的动作）；没有意图就跟随条目现状。
				// 关键：条目被外部停用（enabled:false）时 wantOn=false 于是**什么都不做**
				// —— 不会把用户在 MCP 面板里关掉的 termcp 默默默启回来。
				const entryEnabled = before?.installed ? current?.enabled !== false : null;
				lastEntryEnabled = entryEnabled;
				// 没意图时：条目在就看它，条目不在看用户最后说过什么，都没说过才默认装（首次）。
				const wantOn =
					desired !== null ? desired : entryEnabled !== null ? entryEnabled : lastIntent === null ? true : lastIntent;

				if (wantOn) {
					// ── 开：已配好、参数一致、且**本来就启着** → 不动 ─────────────
					// 为什么必须加 `entryEnabled !== false`：参数一致但条目被停用时，
					// same 也是 true；假如就那样返回，窗口那个开关就永远打不开它了。
					// 其余什么都不做的情形：那不是我们的条目（手写配置）。
					if ((same && entryEnabled !== false) || (before?.installed && !ours)) {
						state = before.running ? "ok" : "stopped";
						note = current?.error ?? "";
						toolCount = (before.tools ?? []).length;
						if (!ours) host.log("info", "检测到手工配置的 termcp，保持原样");
						return;
					}
				} else {
					// ── 关：把条目停用掉（已经是停用就什么都不做）─────────────
					// 为什么不删：`host.mcp` 只给了 list/check/install/promptInstall，
					// **没有删除 API**（删除在 agent-service 里，插件面看不到）。要真删
					// 得用设置 →「MCP」里那个垃圾桶（那是宿主的 Web 消息路径）。
					if (ours && current?.enabled !== false) {
						const res = await host.mcp.install({ ...want, overwrite: true, enabled: false });
						host.log(
							res?.ok ? "info" : "warn",
							res?.ok ? "已停用 termcp（要彻底删掉：设置 →「MCP」→ 垃圾桶）" : `停用失败：${res?.error ?? "未知错误"}`,
						);
					}
					lastEntryEnabled = false;
					state = "off";
					note = "";
					toolCount = 0;
					rememberIntent(false);
					desired = null;
					return;
				}

				// 冷启动要下载二进制，别让宿主的 8 秒握手超时撞上（见文件头）。
				try {
					await host.bash(`${CMD.join(" ")} -version`, { timeoutMs: WARMUP_TIMEOUT_MS });
				} catch {
					/* 预热失败不拦路，让 install 去报真正的错 */
				}

				// overwrite 只在「已经有自己那条」时给：首次安装不该带上它，
				// 免得多一步给用户手写条目覆盖授权。（有标记时才走这条路。）
				// enabled: true 显式带上：这条路径也是「窗口开关把停用的条目重新打开」的
				// 入口，不带就会把刚打开的那条又写回停用。
				const res = await host.mcp.install({ ...want, enabled: true, ...(ours ? { overwrite: true } : {}) });
				if (!res?.ok) {
					state = "failed";
					note = res?.error ?? "host.mcp.install 未返回结果";
					toolCount = 0;
					host.log("warn", `MCP 接入失败：${note}`);
					return;
				}
				state = "ok";
				note = res.error ?? "";
				toolCount = (res.tools ?? []).length;
				lastEntryEnabled = true;
				rememberIntent(true);
				desired = null;
				host.log("info", `termcp MCP 已接入：${toolCount} 个工具`);
			} catch (err) {
				state = "failed";
				note = err instanceof Error ? err.message : String(err);
				toolCount = 0;
				host.log("warn", `MCP 接入异常：${note}`);
			}
		};

		// ── 3. 窗口：问状态 / 扳开关 ─────────────────────────────────────────
		const offMessage = host.onMessage(async (msg, from) => {
			if (!msg || typeof msg !== "object") return;
			// 窗口里的开关：只记一个「待应用意图」，由 sync() 去落地（它才看得到条目现状）。
			// 不直接写 storage：那样会多出一个与条目并存的真相源，两边迟早打架。
			if (msg.type === "switch") {
				desired = msg.on === true;
				await sync();
			} else if (msg.type !== "status") {
				return;
			}
			// 重挂一次反代：这既是「前缀曾被别的插件占着」的恢复点，也顺手吸收了宿主
			// 那点时序问题 —— 反代注册失败只进宿主的运行时诊断，插件侧看不见，重挂是
			// 唯一的自愈手段。窗口每次打开都会问状态。
			// 必须放在 sync 之后：mount 要按 sync 定下的开关状态决定挂还是拆。
			mount();
			const out = {
				type: "status",
				payload: {
					port: port(),
					prefix: prefix(),
					enabled: lastEntryEnabled !== false,
					mcp: state,
					mcpNote: note,
					toolCount,
				},
			};
			if (from) host.sendTo(from, out);
			else host.broadcast(out);
		});

		const offSettings = host.onSettingsChanged(() => {
			// 保存端口/挂载路径也会走到这里 —— 那时什么都不该变（尤其不能把用户在
			// 窗口里关掉的 termcp 默默打开，实测踩过）。开关只认条目现状与窗口意图。
			mount();
			void sync();
		});

		// 先 sync 再 mount：mount 要根据「开关是不是关着」决定挂不挂反代，而那个答案
		// 只有 sync 查完配置条目才知道（否则关着的时候一启动还是会把反代挂上）。
		void (async () => {
			await sync();
			mount();
		})();

		return () => {
			stopped = true;
			offMessage();
			offSettings();
			const off = offProxy;
			offProxy = null;
			try {
				off?.();
			} catch {
				/* 已经注销过了 */
			}
			// 不删那条 MCP 配置：`host.mcp` 根本没有删除 API，而且它是宿主的、也是
			// 设置面板里看得见的一条正常服务器。插件重载顺手杀掉连接和用户的终端
			// 是不对的。要停就用上面那个开关（或设置面板），而不是把条目抠掉。
		};
	},
};

export { CMD, DEFAULT_PORT, DEFAULT_PREFIX, MARK, WARMUP_TIMEOUT_MS };
