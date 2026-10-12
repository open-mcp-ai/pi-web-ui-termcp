/**
 * termcp 自测 —— 一个假宿主，不需要 pi-web-ui、不需要 termcp、不联网。
 *
 * 这个插件只做两件事，测试也只盯这两件：
 *
 *   1. **注入 MCP。** 命令必须是 termcp 官方那一条（`npx -y @open-mcp-ai/termcp`），
 *      无条件使用 —— 不探测 PATH、不碰 ~/.termcp 缓存、不解析二进制路径。
 *      已经配好就不动它（install 会重启服务器、杀掉用户正在用的终端）。
 *      用户手写的配置绝不覆盖。
 *   2. **开窗口。** 反代挂上；同一个前缀被别的插件占着时，下次问状态要能补挂。
 *
 * 假宿主必须**忠实于真实宿主**，否则测试会替错误背书。踩过的坑就写在
 * `registerProxy` 上（真实宿主失败时也返回函数，不是 null）。
 *
 * 跑法：node selftest.mjs
 */
import plugin, { CMD, DEFAULT_PORT, DEFAULT_PREFIX, MARK, WARMUP_TIMEOUT_MS } from "./index.mjs";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let pass = 0;
let fail = 0;
const ck = (name, ok, extra = "") => {
	if (ok) {
		pass++;
		console.log(`PASS ${name}`);
		return;
	}
	fail++;
	console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本插件在假宿主里的 id（与 manifest.json 一致）。 */
const PLUGIN_ID = "termcp";
/** 官方命令的字符串形式，断言里反复要用。 */
const CMD_STR = CMD.join(" ");
const isOfficial = (spec) =>
	spec?.command === CMD[0] && JSON.stringify((spec?.args ?? []).slice(0, CMD.length - 1)) === JSON.stringify(CMD.slice(1));

/**
 * 在受控环境里跑 `fn`，并把 PATH 上种一个假的 `termcp`。
 *
 * 种它是为了证明插件**不会**去用 —— 官方命令是唯一的答案，PATH 上有什么都不影响。
 * TERMCP_DATA_DIR 指向空目录，免得本机真实的 npx 缓存影响判断。
 */
async function withEnv(fn) {
	const savedPath = process.env.PATH;
	const savedData = process.env.TERMCP_DATA_DIR;
	const tmp = mkdtempSync(join(tmpdir(), "termcp-selftest-"));
	try {
		const binDir = join(tmp, "bin");
		mkdirSync(binDir, { recursive: true });
		const planted = join(binDir, process.platform === "win32" ? "termcp.exe" : "termcp");
		writeFileSync(planted, "#!/bin/sh\nexit 0\n");
		chmodSync(planted, 0o755);
		process.env.PATH = `${binDir}${delimiter}${savedPath}`;
		process.env.TERMCP_DATA_DIR = join(tmp, "data");
		// 顺带种一个看起来可用的 npx 缓存目录：也不该被采用。
		const cacheDir = join(process.env.TERMCP_DATA_DIR, "versions", "v9.9.9");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, process.platform === "win32" ? "termcp.exe" : "termcp"), "#!/bin/sh\nexit 0\n");
		return await fn({ planted, cacheDir });
	} finally {
		process.env.PATH = savedPath;
		process.env.TERMCP_DATA_DIR = savedData;
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * 假宿主。`mcpState` 模拟 `host.mcp.check()` 的返回，`installResult` 模拟
 * `host.mcp.install()`。`foreignPrefix` 模拟「前缀被另一个插件占着」。
 *
 * `registerProxy` 严格照抄真实宿主的两条语义（server/plugins.ts）：
 *  - 前缀被**别的** pluginId 占着 → 不注册，但**仍旧返回一个空操作函数**；
 *  - 同 pluginId 重复注册是幂等的（只覆盖自己那条，不堆重复路由）。
 */
function makeHost({ settings = {}, mcpState = { installed: false }, installResult = { ok: true, tools: [] }, foreignPrefix = null } = {}) {
	/** 前缀 → 占用它的 pluginId（宿主 proxyRoutes 的等价物）。 */
	const owners = new Map();
	/** 前缀 → 目标（真的注册上了才有）。 */
	const routes = new Map();
	const logs = [];
	const sent = [];
	const handlers = new Set();
	const calls = [];
	let current = { port: DEFAULT_PORT, prefix: DEFAULT_PREFIX, ...settings };
	let state = mcpState;
	let foreign = foreignPrefix;
	/** 宿主副作用栈的等价物：注册了没撤的条数（反激活后必须归零）。 */
	let liveEffects = 0;
	/** 插件自己的 storage（与声明式设置分开存）。 */
	const store = {};

	/** 当前**真的挂上**的路由（按前缀排序），断言用。 */
	const mounted = () => [...routes.keys()].sort();

	const host = {
		getSettings: () => current,
		onSettingsChanged: (h) => {
			handlers.add(["settings", h]);
			return () => handlers.delete(["settings", h]);
		},
		onMessage: (h) => {
			handlers.add(["msg", h]);
			return () => handlers.delete(["msg", h]);
		},
	registerProxy: (p, t) => {
			// 被别的插件占着：宿主返回的同样是「一个什么都不做的函数」，不是 null。
			// 插件侧分辨不出成功与否 —— 这正是曾经那个 `Boolean(offProxy)` 永远为
			// true 的原因，所以这里必须忠实。
			if (foreign === p || (owners.has(p) && owners.get(p) !== PLUGIN_ID)) return () => {};
			owners.set(p, PLUGIN_ID);
			routes.set(p, t);
			// 忠实于宿主的副作用栈：**每注册一次 push 一条**（effects.add）。
			// 插件若不先撤旧的就重挂，栈会无限长 —— 这个计数就是抓它的。
			liveEffects++;
			let released = false;
			return () => {
				if (!released) {
					released = true;
					liveEffects--;
				}
				if (owners.get(p) !== PLUGIN_ID) return;
				owners.delete(p);
				routes.delete(p);
			};
		},
		bash: async (cmd, opts) => {
			calls.push({ m: "bash", cmd, opts });
			return { ok: true, output: "termcp v0.0.0", exitCode: 0 };
		},
		mcp: {
			check: async (q) => {
				calls.push({ m: "check", q });
				if (!state.installed) return { installed: false, running: false, enabled: false, server: null, matches: [], tools: [] };
				const enabled = state.server?.enabled !== false;
				return {
					installed: true,
					// enabled:false 的服务器不会是 running（reloadOnce 直接跳过它）。
					running: enabled,
					enabled,
					server: state.server,
					matches: [state.server],
					tools: state.tools ?? [],
				};
			},
			install: async (spec) => {
				calls.push({ m: "install", spec });
				if (!installResult.ok) return installResult;
				// 忠实于真实宿主：重名保护（无 overwrite 就拒）与 enabled 透传。
				if (state.installed && spec.overwrite !== true) {
					return { ok: false, error: `已存在同名服务器「${spec.name}」——确认要覆盖请传 overwrite=true` };
				}
				const enabled = spec.enabled !== false;
				state = {
					installed: true,
					// 忠实于真实宿主：saveMcpServer 会持久化 description（归属标记就住那里）、
					// enabled；listAllMcpServers 再把它们读回来。enabled:false 的条目
					// reloadOnce 不会拉起，也不会进 clients，于是没有工具。
					server: { name: spec.name, command: spec.command, args: spec.args ?? [], scope: spec.scope, description: spec.description, enabled },
					tools: enabled ? (installResult.tools ?? []) : [],
				};
				return { ...installResult, name: spec.name, scope: spec.scope, status: enabled ? "running" : "stopped" };
			},
		},
		log: (lvl, ...a) => logs.push([lvl, a.join(" ")]),
		// 忠实于真实宿主：插件自己的 KV（storage.json 顶层键），与声明式设置的
		// `settings` 键互不干扰、同一把 RMW 锁。
		storage: {
			get: (k, fallback) => (k in store ? store[k] : fallback),
			set: (k, v) => {
				store[k] = v;
			},
			delete: (k) => {
				delete store[k];
			},
		},
		broadcast: (p) => sent.push(p),
		sendTo: (_c, p) => sent.push(p),
	};

	return {
		host,
		mounted,
		/** 未回滚的副作用条数（宿主的 effect 栈，反激活后必须为 0）。 */
		liveEffects: () => liveEffects,
		logs,
		calls,
		/** 另一个插件让位：前缀空出来。 */
		foreignReleases: (p) => {
			if (foreign === p) foreign = null;
		},
		/** 让插件向本客户端回一条 status（视图每次打开都这么干）。 */
		ask: async () => {
			sent.length = 0;
			for (const [kind, h] of handlers) if (kind === "msg") await h({ type: "status" }, "c1");
			return sent[sent.length - 1];
		},
		setSettings: (s) => {
			current = { ...current, ...s };
			for (const [kind, h] of handlers) if (kind === "settings") h(current);
		},
		/** 当前 MCP 配置条目（未配置为 null）——看开关到底把状态改成了什么。 */
		mcp: () => (state.installed ? state.server : null),
		/** 从外部删掉配置条目（模拟用户在 MCP 面板点垃圾桶）。 */
		deleteMcp: () => {
			state = { installed: false };
		},
		/** 从外部拨条目的 enabled（模拟用户在 MCP 面板点停用/启用）。 */
		setEntryEnabled: (on) => {
			if (!state.installed) return;
			state = { ...state, server: { ...state.server, enabled: on }, tools: on ? (installResult.tools ?? []) : [] };
		},
		/** 插件 storage 的当前内容。 */
		storage: () => ({ ...store }),
		/** 窗口侧发一条消息给插件（模拟 ctx.send）。 */
		fromView: async (payload) => {
			sent.length = 0;
			for (const [kind, h] of handlers) if (kind === "msg") await h(payload, "c1");
			return sent[sent.length - 1];
		},
	};
}

// ── 1. 注入：命令就是官方那一条 ────────────────────────────────────────────
{
	await withEnv(async () => {
		const t = makeHost({ installResult: { ok: true, tools: [{ name: "session_start" }, { name: "file_read" }] } });
		const off = plugin.activate(t.host);
		await sleep(150);

		const inst = t.calls.find((c) => c.m === "install");
		ck("1 没配过就 install", Boolean(inst), JSON.stringify(t.calls.map((c) => c.m)));
		ck("1 服务器名叫 termcp", inst?.spec?.name === "termcp", JSON.stringify(inst?.spec?.name));
		ck("1 命令是官方那一条（npx -y @open-mcp-ai/termcp）", isOfficial(inst?.spec), JSON.stringify([inst?.spec?.command, inst?.spec?.args]));
		ck("1 子命令是 daemon stdio", inst?.spec?.args?.includes("daemon") && inst?.spec?.args?.includes("stdio"), JSON.stringify(inst?.spec?.args));
		ck("1 带上了端口", inst?.spec?.args?.includes(String(DEFAULT_PORT)), JSON.stringify(inst?.spec?.args));
		ck("1 装到 global", inst?.spec?.scope === "global", JSON.stringify(inst?.spec?.scope));
		ck("1 首次不 overwrite", inst?.spec?.overwrite === undefined, JSON.stringify(inst?.spec?.overwrite));
		ck("1 打上归属标记", String(inst?.spec?.description).includes(MARK), JSON.stringify(inst?.spec?.description));

		const st = await t.ask();
		ck("1 状态是 ok 且带工具数", st?.payload?.mcp === "ok" && st?.payload?.toolCount === 2, JSON.stringify(st?.payload));
		ck(
			"1 状态只带视图用得上的字段",
			JSON.stringify(Object.keys(st?.payload ?? {}).sort()) === JSON.stringify(["enabled", "mcp", "mcpNote", "port", "prefix", "toolCount"]),
			JSON.stringify(st?.payload),
		);
		off();
	});
}

// ── 2. 注入：官方命令是唯一答案，PATH / 缓存都不影响 ───────────────────────
{
	await withEnv(async ({ planted, cacheDir }) => {
		const t = makeHost();
		const off = plugin.activate(t.host);
		await sleep(150);
		const inst = t.calls.find((c) => c.m === "install");

		ck("2 PATH 上有个 termcp 也不采用", !JSON.stringify(inst?.spec).includes(planted), JSON.stringify(inst?.spec));
		ck("2 不碰 ~/.termcp/versions 缓存", !JSON.stringify(inst?.spec).includes("versions"), JSON.stringify(inst?.spec));
		ck("2 配置里没有任何绝对路径", !/["\s]\/[^"]/.test(JSON.stringify(inst?.spec)), JSON.stringify(inst?.spec));
		ck("2 命令仍是官方 npx 形式", isOfficial(inst?.spec), JSON.stringify([inst?.spec?.command, inst?.spec?.args]));
		ck("2 配置里不含版本号（不会被钉死）", !/v\d+\.\d+/.test(JSON.stringify(inst?.spec)), JSON.stringify(inst?.spec));

		// 预热必须走官方命令，而不是 PATH 上那个
		const warm = t.calls.find((c) => c.m === "bash");
		ck("2 预热走的也是官方命令", String(warm?.cmd).startsWith(`${CMD_STR} `), String(warm?.cmd));
		ck("2 预热用的是 -version（不是起服务器）", String(warm?.cmd).endsWith("-version"), String(warm?.cmd));
		ck("2 预热先于 install（宿主握手只有 8s）", t.calls.findIndex((c) => c.m === "bash") < t.calls.findIndex((c) => c.m === "install"), JSON.stringify(t.calls.map((c) => c.m)));
		ck("2 预热超时给得够长（冷启动要下 12MB）", warm?.opts?.timeoutMs === WARMUP_TIMEOUT_MS, JSON.stringify(warm?.opts));
		void cacheDir;
		off();
	});
}

// ── 3. 注入：已经配好且一致 → 什么都不做 ──────────────────────────────────
{
	await withEnv(async () => {
		const want = { name: "termcp", command: CMD[0], args: [...CMD.slice(1), "daemon", "stdio", "--port", String(DEFAULT_PORT), "--idle-timeout", "10m"] };
		const t = makeHost({
			mcpState: { installed: true, server: { ...want, scope: "global", description: `termcp ${MARK}` }, tools: [{ name: "session_start" }] },
		});
		const off = plugin.activate(t.host);
		await sleep(150);

		ck("3 参数一致就不 install（install 会重启服务器、杀掉终端）", !t.calls.some((c) => c.m === "install"), JSON.stringify(t.calls.map((c) => c.m)));
		ck("3 连预热都不做（没有任何子进程）", !t.calls.some((c) => c.m === "bash"), JSON.stringify(t.calls.map((c) => c.m)));
		const st = await t.ask();
		ck("3 状态如实反映现状", st?.payload?.mcp === "ok" && st?.payload?.toolCount === 1, JSON.stringify(st?.payload));
		off();
	});
}

// ── 4. 注入：我们自己的条目参数变了 → 刷新 ────────────────────────────────
{
	await withEnv(async () => {
		const t = makeHost({
			settings: { port: 21000 },
			mcpState: {
				installed: true,
				server: { name: "termcp", command: CMD[0], args: [...CMD.slice(1), "daemon", "stdio", "--port", "18765", "--idle-timeout", "10m"], scope: "global", description: `termcp ${MARK}` },
				tools: [],
			},
		});
		const off = plugin.activate(t.host);
		await sleep(150);
		const inst = t.calls.find((c) => c.m === "install");
		ck("4 参数变了就刷新", Boolean(inst), JSON.stringify(t.calls.map((c) => c.m)));
		ck("4 带上新端口", inst?.spec?.args?.includes("21000"), JSON.stringify(inst?.spec?.args));
		ck("4 刷新时 overwrite（那是我们自己的条目）", inst?.spec?.overwrite === true, JSON.stringify(inst?.spec?.overwrite));
		off();
	});
}

// ── 5. 注入：用户手写的配置绝不覆盖 ───────────────────────────────────────
{
	await withEnv(async () => {
		const t = makeHost({
			mcpState: {
				installed: true,
				// 没有归属标记 = 用户手写的
				server: { name: "termcp", command: "/usr/local/bin/termcp", args: ["daemon", "stdio", "--port", "19999", "--data-dir", "/custom"], scope: "global" },
				tools: [{ name: "session_start" }],
			},
		});
		const off = plugin.activate(t.host);
		await sleep(150);
		ck("5 不覆盖手写配置", !t.calls.some((c) => c.m === "install"), JSON.stringify(t.calls.map((c) => c.m)));
		ck("5 也不预热（不是我们的条目就不折腾）", !t.calls.some((c) => c.m === "bash"), JSON.stringify(t.calls.map((c) => c.m)));
		const st = await t.ask();
		ck("5 状态如实反映用户的服务器", st?.payload?.mcp === "ok" && st?.payload?.toolCount === 1, JSON.stringify(st?.payload));
		off();
	});
}

// ── 6. 注入：install 失败只是没有工具，窗口照常 ───────────────────────────
{
	await withEnv(async () => {
		const t = makeHost({ installResult: { ok: false, error: "spawn npx ENOENT" } });
		const off = plugin.activate(t.host);
		await sleep(150);
		ck("6 失败记进日志", t.logs.some(([l, m]) => l === "warn" && m.includes("ENOENT")), JSON.stringify(t.logs));
		ck("6 窗口照样挂上", t.mounted().length === 1, JSON.stringify(t.mounted()));
		const st = await t.ask();
		ck("6 状态报 failed 并带上原因", st?.payload?.mcp === "failed" && st.payload.mcpNote.includes("ENOENT"), JSON.stringify(st?.payload));
		off();
	});
}

// ── 7. 注入：老宿主没有 host.mcp → 说不清就不做 ───────────────────────────
{
	const t = makeHost();
	delete t.host.mcp;
	const off = plugin.activate(t.host);
	await sleep(150);
	ck("7 不抛异常", true);
	ck("7 窗口仍然可用", t.mounted().length === 1, JSON.stringify(t.mounted()));
	ck("7 日志说明缺什么（不是一句 TypeError）", t.logs.some(([l, m]) => l === "warn" && m.includes("host.mcp")), JSON.stringify(t.logs));
	off();
}

// ── 8. 窗口：反代挂上，设置改了跟着走 ─────────────────────────────────────
{
	await withEnv(async () => {
		const t = makeHost();
		const off = plugin.activate(t.host);
		// mount 在 sync 之后（要等它查完开关状态），所以给一拍。
		await sleep(120);
		ck("8 激活即挂反代", t.mounted().length === 1 && t.mounted()[0] === DEFAULT_PREFIX, JSON.stringify(t.mounted()));

		const st = await t.ask();
		ck("8 状态带 port/prefix 给视图拼地址", st?.payload?.port === DEFAULT_PORT && st?.payload?.prefix === DEFAULT_PREFIX, JSON.stringify(st?.payload));

		t.setSettings({ port: 22000, prefix: "/tc2" });
		await sleep(200);
		ck("8 改了设置挂到新前缀", t.mounted().includes("/tc2"), JSON.stringify(t.mounted()));
		ck("8 老前缀释放", !t.mounted().includes(DEFAULT_PREFIX), JSON.stringify(t.mounted()));
		off();
		ck("8 反激活撤掉反代", t.mounted().length === 0, JSON.stringify(t.mounted()));
	});
}

// ── 9. 窗口：前缀被别的插件占着 → 下次问状态补挂 ──────────────────────────
{
	await withEnv(async () => {
		const t = makeHost({ foreignPrefix: DEFAULT_PREFIX });
		const off = plugin.activate(t.host);
		await sleep(100);
		ck("9 被占用时挂不上", t.mounted().length === 0, JSON.stringify(t.mounted()));

		const st = await t.ask();
		// 真实宿主里失败与成功返回的都是函数，插件无从分辨 —— 所以它**不该**宣称
		// 反代挂没挂上。曾经这里是 `proxyMounted: Boolean(offProxy)`，而那个值恒为
		// true：视图永远看不到「未挂载」，提示分支是死代码。
		ck("9 不谎报挂载状态（宿主分辨不出，字段已删）", !("proxyMounted" in (st?.payload ?? {})), JSON.stringify(st?.payload));

		// 别的插件让位（宿主下一轮扫描会拆掉它）
		t.foreignReleases(DEFAULT_PREFIX);
		await sleep(50);
		await t.ask();
		ck("9 再问一次状态就补挂上了", t.mounted().includes(DEFAULT_PREFIX), JSON.stringify(t.mounted()));
		off();
	});
}

// ── 10. 窗口：重挂是幂等的，不会堆重复路由 ────────────────────────────────
{
	await withEnv(async () => {
		const t = makeHost();
		const off = plugin.activate(t.host);
		await sleep(120);
		ck("10 先挂上", t.mounted().length === 1, JSON.stringify(t.mounted()));

		// 视图每次打开、每次点重载、每次改设置都会问一次状态 —— 每问一次就重挂一次。
		await t.ask();
		await t.ask();
		await t.ask();
		ck("10 反复问状态不堆重复路由（同 owner 幂等）", t.mounted().length === 1, JSON.stringify(t.mounted()));
		// 宿主每注册一次就 push 一条副作用；不先撤旧的再挂就会每问一次状态漏一条，
		// 插件跑久了栈无限长。重挂可以，但必须先撤。
		ck("10 反复重挂不漏副作用（先撤旧的再挂）", t.liveEffects() === 1, `liveEffects=${t.liveEffects()}`);

		t.setSettings({ prefix: "/tc2" });
		await sleep(200);
		ck("10 换前缀后只剩新的那条", JSON.stringify(t.mounted()) === JSON.stringify(["/tc2"]), JSON.stringify(t.mounted()));
		off();
	});
}

// ── 11. 反激活不留尾巴 ────────────────────────────────────────────────────
{
	await withEnv(async () => {
		const t = makeHost();
		const off = plugin.activate(t.host);
		await sleep(100);
		off();
		ck("11 反激活撤掉反代", t.mounted().length === 0, JSON.stringify(t.mounted()));
		ck("11 反激活后副作用栈清空（没有漏注册）", t.liveEffects() === 0, `liveEffects=${t.liveEffects()}`);
		// 反激活后不该再响应任何东西
		await t.ask();
		ck("11 反激活后不再挂回来", t.mounted().length === 0, JSON.stringify(t.mounted()));
		ck("11 不碰宿主的 MCP 条目（没有 remove/uninstall 调用）", !t.calls.some((c) => /remove|uninstall/.test(c.m)), JSON.stringify(t.calls.map((c) => c.m)));
	});
}

// ── 12. 窗口开关：关 = 停用条目 + 拆反代；开 = 恢复 ──────────────────────
{
	await withEnv(async () => {
		const t = makeHost({ installResult: { ok: true, tools: [{ name: "session_start" }] } });
		const off = plugin.activate(t.host);
		await sleep(150);
		ck("12 默认装上并启用", t.mcp()?.enabled !== false && t.mounted().length === 1, JSON.stringify([t.mcp()?.enabled, t.mounted()]));

		// 窗口里关
		const r = await t.fromView({ type: "switch", on: false });
		await sleep(250);
		ck("12 关掉：条目停用（enabled:false）", t.mcp()?.enabled === false, JSON.stringify(t.mcp()));
		ck("12 关掉：拆反代", t.mounted().length === 0, JSON.stringify(t.mounted()));
		ck("12 关掉：回执 enabled:false", r?.payload?.enabled === false && r?.payload?.mcp === "off", JSON.stringify(r?.payload));

		// 关着时反复问状态，不该反复 install
		const before = t.calls.filter((c) => c.m === "install").length;
		await t.ask();
		await t.ask();
		ck("12 关着时反复问状态不再 install", t.calls.filter((c) => c.m === "install").length === before, JSON.stringify(t.calls.map((c) => c.m)));

		// 窗口里再打开
		const r2 = await t.fromView({ type: "switch", on: true });
		await sleep(250);
		ck("12 打开：条目恢复启用", t.mcp()?.enabled !== false, JSON.stringify(t.mcp()));
		ck("12 打开：反代挂回来", t.mounted().length === 1, JSON.stringify(t.mounted()));
		ck("12 打开：回执 enabled:true", r2?.payload?.enabled === true && r2?.payload?.mcp === "ok", JSON.stringify(r2?.payload));
		off();
	});
}

// ── 13. 用户的预期：MCP 面板里停用 → 插件不能默默装回来 ──────────────────
{
	await withEnv(async () => {
		const t = makeHost({ installResult: { ok: true, tools: [{ name: "session_start" }] } });
		const off = plugin.activate(t.host);
		await sleep(150);

		// 模拟用户在 MCP 面板点了停用（外部改条目，插件不知道）
		t.setEntryEnabled(false);
		await sleep(50);
		const before = t.calls.filter((c) => c.m === "install").length;
		// 触发一次 sync（保存设置 / 刷新窗口都会）
		t.setSettings({ port: 21000 });
		await sleep(300);
		ck("13 面板停用后不被装回来", t.calls.filter((c) => c.m === "install").length === before, JSON.stringify(t.calls.map((c) => c.m)));
		ck("13 条目仍是停用", t.mcp()?.enabled === false, JSON.stringify(t.mcp()));
		ck("13 状态报 off", (await t.ask())?.payload?.mcp === "off", JSON.stringify((await t.ask())?.payload));

		// 但窗口开关仍能把它打开（用户明确要求）
		await t.fromView({ type: "switch", on: true });
		await sleep(250);
		ck("13 窗口仍能主动打开", t.mcp()?.enabled !== false, JSON.stringify(t.mcp()));
		off();
	});
}

// ── 14. 关着时外部删掉条目 → 不复活（重载后也不复活）─────────────────────
{
	await withEnv(async () => {
		const t = makeHost({ installResult: { ok: true, tools: [{ name: "session_start" }] } });
		const off = plugin.activate(t.host);
		await sleep(150);

		await t.fromView({ type: "switch", on: false });
		await sleep(250);
		ck("14 先关掉", t.mcp()?.enabled === false, JSON.stringify(t.mcp()));
		ck("14 意愿落盘（重载不丢）", t.storage().wanted === false, JSON.stringify(t.storage()));

		// 用户去 MCP 面板点了垃圾桶
		t.deleteMcp();
		const before = t.calls.filter((c) => c.m === "install").length;
		t.setSettings({ port: 21000 });
		await sleep(300);
		ck("14 关着时删了不复活", t.calls.filter((c) => c.m === "install").length === before, JSON.stringify(t.calls.map((c) => c.m)));
		ck("14 仍然没有条目", t.mcp() === null, JSON.stringify(t.mcp()));

		// 模拟插件重载（反激活再激活，同一个 storage）—— 不能因为「条目不存在」
		// 就当首次安装复活它。这是用户说的「卸载就是删了」。
		off();
		const t2 = makeHost();
		t2.host.storage.get = (k, f) => t.host.storage.get(k, f);
		t2.host.storage.set = (k, v) => t.host.storage.set(k, v);
		t2.host.storage.delete = (k) => t.host.storage.delete(k);
		const off2 = plugin.activate(t2.host);
		await sleep(250);
		ck("14 重载后也不复活（意愿是落盘的）", !t2.calls.some((c) => c.m === "install"), JSON.stringify(t2.calls.map((c) => c.m)));
		ck("14 重载后仍无条目", t2.mcp() === null, JSON.stringify(t2.mcp()));
		ck("14 重载后反代也不挂（关着）", t2.mounted().length === 0, JSON.stringify(t2.mounted()));

		// 窗口打开才重装
		await t2.fromView({ type: "switch", on: true });
		await sleep(300);
		ck("14 窗口打开才重装", t2.mcp() !== null && t2.mcp()?.enabled !== false, JSON.stringify(t2.mcp()));
		off2();
	});
}

// ── 15. 回归：改端口不能把刚关掉的开关弄回来（实测踩过） ────────────────
{
	await withEnv(async () => {
		const t = makeHost({ installResult: { ok: true, tools: [{ name: "session_start" }] } });
		const off = plugin.activate(t.host);
		await sleep(150);

		await t.fromView({ type: "switch", on: false });
		await sleep(250);
		t.setSettings({ port: 21000, prefix: "/termcp" });
		await sleep(300);
		ck("15 改端口后仍是关的", (await t.ask())?.payload?.enabled === false, JSON.stringify((await t.ask())?.payload));
		ck("15 反代仍是拆的", t.mounted().length === 0, JSON.stringify(t.mounted()));
		ck("15 条目仍是停用", t.mcp()?.enabled === false, JSON.stringify(t.mcp()));
		off();
	});
}

// ── 16. 没 host.storage / 没 host.mcp 的老宿主不能炸 ─────────────────────
{
	const t = makeHost();
	delete t.host.storage;
	const off = plugin.activate(t.host);
	await sleep(150);
	ck("16 没有 storage 也照常启动", t.mounted().length === 1, JSON.stringify(t.mounted()));
	await t.fromView({ type: "switch", on: false });
	await sleep(200);
	ck("16 没有 storage 时扳开关不抛异常", true);
	off();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
