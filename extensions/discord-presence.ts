import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import DiscordRPC from "discord-rpc";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLIENT_ID = process.env.PI_DISCORD_CLIENT_ID ?? "1378773754103988274";
const LARGE_IMAGE_KEY = process.env.PI_DISCORD_LARGE_IMAGE_KEY;
const SMALL_IDLE_IMAGE_KEY = process.env.PI_DISCORD_SMALL_IDLE_IMAGE_KEY;
const SMALL_WORKING_IMAGE_KEY = process.env.PI_DISCORD_SMALL_WORKING_IMAGE_KEY;
const GLOBAL_STATE_FILE = join(homedir(), ".pi", "agent", "discord-presence-state.json");
const RECONNECT_DELAY_MS = 15_000;
const PRESENCE_UPDATE_DEBOUNCE_MS = 750;
const DISCORD_TEXT_LIMIT = 128;

type PresenceStatus = "idle" | "working" | "tool" | "offline";

type PresenceState = {
	status: PresenceStatus;
	details: string;
	state: string;
	toolName?: string;
	model?: string;
	startedAt: number;
};

type DiscordRpcClient = DiscordRPC.Client & {
	clearActivity?: () => Promise<void> | void;
	destroy?: () => void;
};

const truncateDiscordText = (value: string): string => {
	if (value.length <= DISCORD_TEXT_LIMIT) return value;
	return `${value.slice(0, DISCORD_TEXT_LIMIT - 1)}…`;
};

const normalizeProjectName = (cwd: string): string => {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? "pi session";
};

const readGlobalEnabled = (): boolean => {
	try {
		const raw = readFileSync(GLOBAL_STATE_FILE, "utf8");
		const parsed = JSON.parse(raw) as { enabled?: unknown };
		return parsed.enabled !== false;
	} catch {
		return true;
	}
};

const writeGlobalEnabled = (enabled: boolean) => {
	mkdirSync(dirname(GLOBAL_STATE_FILE), { recursive: true });
	writeFileSync(GLOBAL_STATE_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`);
};

export default function discordPresence(pi: ExtensionAPI) {
	let rpc: DiscordRpcClient | undefined;
	let connected = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let updateTimer: NodeJS.Timeout | undefined;
	let stateWatcher: FSWatcher | undefined;
	let shuttingDown = false;
	let enabled = readGlobalEnabled();

	let presence: PresenceState = {
		status: "offline",
		details: "pi coding agent",
		state: "starting discord rich presence",
		startedAt: Date.now(),
	};

	const clearReconnectTimer = () => {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	};

	const clearUpdateTimer = () => {
		if (updateTimer) clearTimeout(updateTimer);
		updateTimer = undefined;
	};

	const scheduleReconnect = () => {
		if (shuttingDown || reconnectTimer || !enabled) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void connect();
		}, RECONNECT_DELAY_MS);
	};

	const buildActivity = (): DiscordRPC.Presence => {
		const modelSuffix = presence.model ? ` · ${presence.model}` : "";
		const state = presence.toolName
			? `${presence.state} · ${presence.toolName}${modelSuffix}`
			: `${presence.state}${modelSuffix}`;
		const smallImageKey = presence.status === "idle" ? SMALL_IDLE_IMAGE_KEY : SMALL_WORKING_IMAGE_KEY;

		return {
			details: truncateDiscordText(presence.details),
			state: truncateDiscordText(state),
			startTimestamp: new Date(presence.startedAt),
			largeImageKey: LARGE_IMAGE_KEY,
			largeImageText: LARGE_IMAGE_KEY ? "pi coding agent" : undefined,
			smallImageKey,
			smallImageText: smallImageKey ? (presence.status === "idle" ? "idle" : "working") : undefined,
			instance: false,
		};
	};

	const flushPresence = async () => {
		clearUpdateTimer();
		if (!connected || !rpc || !enabled || shuttingDown) return;

		try {
			await rpc.setActivity(buildActivity());
		} catch {
			connected = false;
			scheduleReconnect();
		}
	};

	const schedulePresenceUpdate = () => {
		if (updateTimer) return;
		updateTimer = setTimeout(() => void flushPresence(), PRESENCE_UPDATE_DEBOUNCE_MS);
	};

	const updatePresence = (patch: Partial<PresenceState>) => {
		presence = { ...presence, ...patch };
		schedulePresenceUpdate();
	};

	async function connect() {
		if (shuttingDown || connected || !enabled) return;

		try {
			rpc = new DiscordRPC.Client({ transport: "ipc" }) as DiscordRpcClient;
			rpc.on("ready", () => {
				connected = true;
				void flushPresence();
			});
			rpc.on("disconnected", () => {
				connected = false;
				scheduleReconnect();
			});
			rpc.on("error", () => {
				connected = false;
				scheduleReconnect();
			});

			await rpc.login({ clientId: CLIENT_ID });
		} catch {
			connected = false;
			rpc = undefined;
			scheduleReconnect();
		}
	}

	const clearDiscordPresence = async () => {
		clearUpdateTimer();
		clearReconnectTimer();
		connected = false;

		try {
			await rpc?.clearActivity?.();
		} catch {
			// Discord may already be closed; ignore cleanup errors.
		}

		try {
			rpc?.destroy?.();
		} catch {
			// Ignore cleanup errors.
		}

		rpc = undefined;
	};

	const applyGlobalEnabled = async (nextEnabled: boolean, cwd: string) => {
		if (enabled === nextEnabled) return;
		enabled = nextEnabled;

		if (!enabled) {
			await clearDiscordPresence();
			return;
		}

		updatePresence({
			status: "idle",
			details: `pi · ${normalizeProjectName(cwd)}`,
			state: "idle",
			toolName: undefined,
			startedAt: Date.now(),
		});
		await connect();
	};

	const watchGlobalState = (cwd: string) => {
		if (stateWatcher) return;

		mkdirSync(dirname(GLOBAL_STATE_FILE), { recursive: true });
		if (!existsSync(GLOBAL_STATE_FILE)) writeGlobalEnabled(enabled);
		stateWatcher = watch(GLOBAL_STATE_FILE, { persistent: false }, () => {
			void applyGlobalEnabled(readGlobalEnabled(), cwd);
		});
	};

	pi.registerCommand("discord-presence", {
		description: "toggle or refresh Discord Rich Presence for all pi sessions. Usage: /discord-presence [on|off|status|refresh]",
		handler: async (args, ctx) => {
			enabled = readGlobalEnabled();
			const rawAction = args.trim().toLowerCase();
			const action = rawAction || (enabled ? "off" : "on");

			if (action === "off") {
				writeGlobalEnabled(false);
				await applyGlobalEnabled(false, ctx.cwd);
				ctx.ui.notify("discord rich presence disabled globally.", "info");
				return;
			}

			if (action === "on") {
				writeGlobalEnabled(true);
				await applyGlobalEnabled(true, ctx.cwd);
				ctx.ui.notify("discord rich presence enabled globally.", "info");
				return;
			}

			if (action === "refresh") {
				await flushPresence();
				ctx.ui.notify("discord rich presence refreshed.", "info");
				return;
			}

			if (action !== "status") {
				ctx.ui.notify("usage: /discord-presence [on|off|status|refresh]", "warning");
				return;
			}

			ctx.ui.notify(
				`discord presence: ${enabled ? "enabled globally" : "disabled globally"}, ${connected ? "connected" : "not connected"}`,
				connected ? "info" : "warning",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		watchGlobalState(ctx.cwd);
		enabled = readGlobalEnabled();
		updatePresence({
			status: "idle",
			details: `pi · ${normalizeProjectName(ctx.cwd)}`,
			state: "idle",
			startedAt: Date.now(),
		});
		if (enabled) void connect();
	});

	pi.on("model_select", async (event) => {
		updatePresence({ model: `${event.model.provider}/${event.model.id}` });
	});

	pi.on("agent_start", async (_event, ctx) => {
		updatePresence({
			status: "working",
			details: `pi · ${normalizeProjectName(ctx.cwd)}`,
			state: "thinking",
			toolName: undefined,
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_start", async (event) => {
		updatePresence({
			status: "tool",
			state: "using tool",
			toolName: event.toolName,
		});
	});

	pi.on("tool_execution_end", async () => {
		updatePresence({
			status: "working",
			state: "thinking",
			toolName: undefined,
		});
	});

	pi.on("agent_end", async () => {
		updatePresence({
			status: "idle",
			state: "idle",
			toolName: undefined,
		});
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		stateWatcher?.close();
		stateWatcher = undefined;
		await clearDiscordPresence();
	});
}
