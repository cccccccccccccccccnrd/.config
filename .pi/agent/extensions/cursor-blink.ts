import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

const BLINKING_BLOCK_CURSOR = "\x1b[1 q";
const DEFAULT_CURSOR = "\x1b[0 q";
const FAKE_CURSOR_START = `${CURSOR_MARKER}\x1b[7m`;

let cursorStyleChanged = false;

class BlinkingCursorEditor extends CustomEditor {
	render(width: number): string[] {
		return super.render(width).map((line) => {
			if (!this.focused) return line;

			// Pi draws a static inverse-video cursor. Keep its position marker,
			// but remove the inverse style so the terminal's blinking cursor is visible.
			return line.replace(FAKE_CURSOR_START, CURSOR_MARKER);
		});
	}
}

function setCursorStyle(sequence: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(sequence);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		setCursorStyle(BLINKING_BLOCK_CURSOR);
		cursorStyleChanged = true;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			tui.setShowHardwareCursor(true);
			return new BlinkingCursorEditor(tui, theme, keybindings);
		});
	});

	pi.on("session_shutdown", () => {
		if (!cursorStyleChanged) return;
		setCursorStyle(DEFAULT_CURSOR);
		cursorStyleChanged = false;
	});
}
