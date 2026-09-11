import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";

// Custom sound files.
const COMPLETE_SOUND_FILE = "/Users/aveaxii/.pi/agent/sounds/ping-sound.mp3";
const ERROR_SOUND_FILE = "/Users/aveaxii/.pi/agent/sounds/error-ping.mp3";

// Mute state persists here so it survives pi restarts. Override with the
// PI_MUTE_STATE_FILE env var (used by tests / custom setups).
const MUTE_STATE_FILE =
	process.env.PI_MUTE_STATE_FILE ??
	"/Users/aveaxii/.pi/agent/extensions/lexlexlex-sound-on-complete/mute-state.json";

// Seconds per duration unit, for /mute <n><unit>.
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

interface MuteState {
	muted: boolean;
	/** Epoch ms when the mute ends; null means forever (until /unmute). */
	until: number | null;
}

export default function (pi: ExtensionAPI) {
	// Module-level mute state, loaded once at startup.
	let muteState: MuteState = readMuteState();

	function isMuted(): boolean {
		if (!muteState.muted) return false;
		// A timed mute that has run out turns itself off.
		if (muteState.until !== null && Date.now() >= muteState.until) {
			muteState = { muted: false, until: null };
			writeMuteState(muteState);
			return false;
		}
		return true;
	}

	function setMuted(state: MuteState): void {
		muteState = state;
		writeMuteState(state);
	}

	pi.on("agent_end", async (event, ctx) => {
		// Avoid noise in non-interactive modes.
		if (!ctx.hasUI) return;
		// Do not play any sound while muted.
		if (isMuted()) return;

		// Play a distinct sound when the turn ended in an error.
		const soundFile = turnFailed(event.messages) ? ERROR_SOUND_FILE : COMPLETE_SOUND_FILE;

		// Fire-and-forget so we don't delay the agent loop.
		void pi.exec("afplay", [soundFile]).catch(() => {
			// Fallback: terminal bell if afplay is unavailable.
			process.stdout.write("\x07");
		});
	});

	pi.registerCommand("mute", {
		description: "Mute the completion sound. Usage: /mute [15m|5h|1d|forever|status]",
		getArgumentCompletions: (prefix: string) => {
			const presets = ["status", "forever", "15m", "30m", "1h", "5h", "24h"];
			const items = presets
				.filter((preset) => preset.startsWith(prefix))
				.map((preset) => ({ value: preset, label: preset }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "status") {
				reportStatus(ctx.ui, muteState);
				return;
			}

			// No argument (or "forever") mutes until /unmute is run.
			if (arg === "" || arg === "forever") {
				setMuted({ muted: true, until: null });
				ctx.ui.notify("Completion sound muted. Run /unmute to turn it back on.", "info");
				return;
			}

			const durationMs = parseDurationMs(arg);
			if (durationMs === null) {
				ctx.ui.notify(
					`Invalid duration "${args.trim()}". Use a number plus a unit, e.g. /mute 15m, /mute 5h or /mute 1d.`,
					"error",
				);
				return;
			}

			const until = Date.now() + durationMs;
			setMuted({ muted: true, until });
			ctx.ui.notify(
				`Completion sound muted for ${formatDuration(durationMs)} (until ${formatClock(until)}).`,
				"info",
			);
		},
	});

	pi.registerCommand("unmute", {
		description: "Turn the completion sound back on immediately",
		handler: async (_args, ctx) => {
			if (!muteState.muted) {
				ctx.ui.notify("The completion sound is not muted.", "info");
				return;
			}
			setMuted({ muted: false, until: null });
			ctx.ui.notify("Completion sound is on again.", "info");
		},
	});
}

/**
 * A failed run ends with a final assistant message whose stopReason is "error"
 * (the model/provider error, e.g. a 503) and an errorMessage describing it.
 */
function turnFailed(messages: { role: string; stopReason?: string; errorMessage?: string }[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		// stopReason "aborted" is a user cancel, not an error - keep the completion sound.
		return message.stopReason === "error" && !!message.errorMessage;
	}
	return false;
}

/** Parse "15m", "5h", "90s" or "2d" into milliseconds; null when invalid. */
function parseDurationMs(input: string): number | null {
	const match = /^(\d+)\s*([smhd])$/i.exec(input);
	if (!match) return null;
	const amount = Number(match[1]);
	if (amount <= 0) return null;
	return amount * UNIT_SECONDS[match[2].toLowerCase()] * 1000;
}

/** Format a millisecond span compactly, e.g. "1h 5m". */
function formatDuration(ms: number): string {
	const totalMinutes = Math.ceil(ms / 60000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return `${minutes}m`;
	return `${Math.ceil(ms / 1000)}s`;
}

/** Format an epoch-ms time as local "HH:MM". */
function formatClock(epochMs: number): string {
	return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Show the current mute state as a notification. */
function reportStatus(
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void },
	state: MuteState,
): void {
	if (!state.muted) {
		ui.notify(
			"The completion sound is on. Mute it with /mute 15m, /mute 5h or /mute forever.",
			"info",
		);
		return;
	}
	if (state.until === null) {
		ui.notify("The completion sound is muted. Run /unmute to turn it back on.", "info");
		return;
	}
	const remaining = Math.max(0, state.until - Date.now());
	ui.notify(
		`The completion sound is muted. Remaining: ${formatDuration(remaining)} (until ${formatClock(state.until)}).`,
		"info",
	);
}

function readMuteState(): MuteState {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(MUTE_STATE_FILE, "utf8"));
		if (raw && typeof raw === "object" && typeof (raw as MuteState).muted === "boolean") {
			const parsed = raw as Partial<MuteState>;
			return { muted: parsed.muted!, until: typeof parsed.until === "number" ? parsed.until : null };
		}
	} catch {
		// No state file yet - the sound is on.
	}
	return { muted: false, until: null };
}

function writeMuteState(state: MuteState): void {
	try {
		fs.writeFileSync(MUTE_STATE_FILE, JSON.stringify(state));
	} catch {
		// Persistence is best-effort; the mute still applies for this session.
	}
}
