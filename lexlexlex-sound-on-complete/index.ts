import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Custom completion sound file.
const MAC_SOUND_FILE = "/Users/aveaxii/.pi/agent/sounds/ping-sound.mp3";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		// Avoid noise in non-interactive modes.
		if (!ctx.hasUI) return;

		// macOS: play a gentle system sound.
		// Fire-and-forget so we don't delay the agent loop.
		void pi.exec("afplay", [MAC_SOUND_FILE]).catch(() => {
			// Fallback: terminal bell if afplay is unavailable.
			process.stdout.write("\x07");
		});
	});
}
