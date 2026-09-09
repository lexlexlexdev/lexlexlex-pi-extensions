import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Custom sound files.
const COMPLETE_SOUND_FILE = "/Users/aveaxii/.pi/agent/sounds/ping-sound.mp3";
const ERROR_SOUND_FILE = "/Users/aveaxii/.pi/agent/sounds/error-ping.mp3";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		// Avoid noise in non-interactive modes.
		if (!ctx.hasUI) return;

		// Play a distinct sound when the turn ended in an error.
		const soundFile = turnFailed(event.messages) ? ERROR_SOUND_FILE : COMPLETE_SOUND_FILE;

		// Fire-and-forget so we don't delay the agent loop.
		void pi.exec("afplay", [soundFile]).catch(() => {
			// Fallback: terminal bell if afplay is unavailable.
			process.stdout.write("\x07");
		});
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
