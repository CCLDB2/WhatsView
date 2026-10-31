/** Coordinates Instagram's date picker with the virtual message list. */
import { $ } from "../shared/dom.js?v=1.8.25";
import { pushOverlayState, popOverlayState } from "../shared/history.js?v=1.8.25";
import { findMessageForDate } from "./date-jump-model.js?v=1.8.25";
import { localDateBounds } from "./format.js?v=1.8.25";
import { igState } from "./state.js?v=1.8.25";
import { jumpToMessage } from "./search.js?v=1.8.25";
import { showToast } from "./ui.js?v=1.8.25";
import { t } from "../i18n.js?v=1.8.25";

export { findMessageForDate, findMessageIdForDate } from "./date-jump-model.js?v=1.8.25";

export function openDateSheet() {
    if (!igState.messageOnlyCount) { showToast(t("Carga una conversación primero"), "warn"); return; }
    const sheet = $("ig-date-sheet");
    const input = $("ig-date-sheet-input");
    if (!sheet || !input) return;
    input.value = "";
    sheet.hidden = false;
    requestAnimationFrame(() => {
        sheet.classList.add("open");
        input.focus({ preventScroll: true });
    });
    pushOverlayState("ig-date-sheet");
}

export function closeDateSheet({ fromHistory = false } = {}) {
    const sheet = $("ig-date-sheet");
    if (!sheet || sheet.hidden) return;
    sheet.classList.remove("open");
    window.setTimeout(() => {
        if (!sheet.classList.contains("open")) sheet.hidden = true;
    }, 180);
    if (!fromHistory) popOverlayState();
}

export function applyDateJump() {
    const input = $("ig-date-sheet-input");
    if (!input?.value) return;
    const bounds = localDateBounds(input.value);
    const match = bounds ? findMessageForDate(igState.filteredMessages, bounds.start, bounds.end) : null;
    if (!match) {
        $("ig-date-sheet-error")?.removeAttribute("hidden");
        return;
    }
    $("ig-date-sheet-error")?.setAttribute("hidden", "");
    closeDateSheet();
    jumpToMessage(match.id);
    if (!match.exact) showToast(t("No hay mensajes en esa fecha. Se saltó al mensaje anterior más cercano."), "info");
}
