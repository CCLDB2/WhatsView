/**
 * ============================================================================
 * Virtualised message list
 * ============================================================================
 * Only a sliding window of `state.filteredMessages` is in the DOM at once
 * (`state.renderRange = { start, end }`), so 100k-message chats scroll
 * smoothly. Scrolling to either edge slides the window by one batch and
 * restores the scroll position against an anchor element so nothing jumps.
 * ============================================================================
 */
import { $ } from "./dom.js?v=1.8.26";

/** The window that shows the newest messages. */
export function tailRange(total, maxRendered) {
    return { start: Math.max(0, total - maxRendered), end: total };
}

/** A virtual window's lower edge is not the end of a conversation. */
export function isAtConversationEnd(viewport, state, tolerance = 4) {
    if (!viewport || state.renderRange.end < state.filteredMessages.length) return false;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < tolerance;
}

/** Rejects stale saved "bottom" flags that came from an older virtual window. */
export function isSavedPositionAtConversationEnd(position, messages, maxRendered) {
    if (!position?.atBottom) return false;
    if (!position.messageId) return true;
    const anchorIndex = messages.findIndex((item) => item.id === position.messageId);
    return anchorIndex < 0 || anchorIndex >= Math.max(0, messages.length - maxRendered);
}

/** Keeps the range inside the list and no wider than `maxRendered`. */
export function clampRenderRange(state, maxRendered) {
    const total = state.filteredMessages.length;
    let start = Math.max(0, Math.min(state.renderRange.start, total));
    let end = Math.max(start, Math.min(state.renderRange.end, total));

    if (end - start > maxRendered) {
        start = Math.max(0, end - maxRendered);
    }

    state.renderRange = { start, end };
}

/**
 * First row that is at least partly visible, with its offset from the top.
 *
 * The row itself is kept alongside its id: `document.getElementById` is how a
 * restored anchor is normally found, but an element that lost its id (or a
 * render that has not finished) can still be followed through the reference.
 * The viewport metrics are part of the snapshot so a failed restore can
 * correct the scroll position without asking the DOM again.
 */
export function getScrollAnchor(viewport) {
    const viewportRect = viewport.getBoundingClientRect();
    const candidates = viewport.querySelectorAll(".message-list > .msg-row, .message-list > .system-msg");

    for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom >= viewportRect.top) {
            return {
                id: element.id,
                element,
                offset: rect.top - viewportRect.top,
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight
            };
        }
    }

    return null;
}

/**
 * Scrolls so the anchor row sits where it was before the re-render.
 *
 * Safe to call when nothing moved (a sub-pixel drift is ignored) and safe to
 * call after the browser already applied its own scroll anchoring: only the
 * remaining offset is corrected, never the whole distance.
 */
export function restoreScrollAnchor(viewport, anchor) {
    if (!anchor) return false;
    // Prefer the element we measured: it is the exact row even if a render
    // changed ids, and it avoids a lookup in the common case.
    const byReference = anchor.element?.isConnected ? anchor.element : null;
    const byId = !byReference && anchor.id && typeof document !== "undefined" ? $(anchor.id) : null;
    const element = byReference || byId;
    if (!element) return false;

    const viewportRect = viewport.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const delta = rect.top - viewportRect.top - anchor.offset;
    if (Math.abs(delta) >= 0.5) viewport.scrollTop += delta;
    return true;
}

/**
 * Keeps an anchor row at `targetOffset` until the layout stops moving.
 *
 * A restored anchor is applied in the first frame, but media above it may
 * still be settling: a photo that has not decoded yet refines its box a frame
 * or two later, and that growth pushes the anchored row down by the same
 * amount. Correcting once left a measured 14px drift; re-correcting the
 * *remaining* delta every frame converges instead. The loop stops as soon as
 * the row is in place, the element leaves the DOM, or the frame budget runs
 * out, so it cannot fight the reader's own scrolling for long.
 *
 * @param {HTMLElement} viewport
 * @param {() => HTMLElement|null} getElement  Resolved each frame: a render
 *   may replace the node the anchor was found in.
 * @param {number} targetOffset  Row top relative to the viewport top.
 * @param {number} [frames]      Maximum correction frames.
 */
export function settleAnchorOffset(viewport, getElement, targetOffset, frames = 6) {
    const target = Number(targetOffset) || 0;
    const correct = (remaining) => {
        const element = getElement();
        if (!element) return;
        const delta = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - target;
        if (Math.abs(delta) < 0.5) return;
        viewport.scrollTop += delta;
        if (remaining > 1) requestAnimationFrame(() => correct(remaining - 1));
    };
    requestAnimationFrame(() => correct(frames));
}

/**
 * Where `scrollTop` belongs when the anchored row did not survive the render.
 *
 * Paging backwards inserts rows *above* the reader, so the extra height is
 * exactly how far the content moved down. Paging forwards appends rows below,
 * where the distance from the bottom — not the distance from the top — is what
 * the reader is holding on to. Falling back to `0` or to the bottom edge (as
 * this used to) threw the reader into a different part of the chat.
 */
export function fallbackScrollTop(anchor, direction, viewport) {
    if (!anchor) return viewport.scrollTop;

    if (direction === "back") {
        const growth = viewport.scrollHeight - anchor.scrollHeight;
        return Math.max(0, anchor.scrollTop + growth);
    }

    const distanceFromBottom = anchor.scrollHeight - anchor.scrollTop - anchor.clientHeight;
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight - distanceFromBottom);
}

/**
 * Slides the window when the viewport hits the top or bottom edge.
 *
 * The reader's position is the hard constraint here: the anchor row is
 * measured *before* the window moves, the render replaces the DOM, and the
 * same row is put back at the same pixel offset. Only if that row no longer
 * exists does the scroll position fall back to the distance the content moved
 * — never to the top or the bottom of the list, which would drop the reader
 * somewhere unrelated.
 *
 * @param {HTMLElement} viewport
 * @param {Object}      state                 Carries renderRange / filteredMessages.
 * @param {Object}      options
 * @param {number}      options.batchSize     Rows added per step.
 * @param {number}      options.maxRendered   Window size cap.
 * @param {Function}    options.render        Re-renders the list from `state.renderRange`.
 */
export function paginateOnScroll(viewport, state, { batchSize, maxRendered, render }) {
    const total = state.filteredMessages.length;

    let direction = "";
    if (viewport.scrollTop <= 0 && state.renderRange.start > 0) {
        direction = "back";
        state.renderRange.start = Math.max(0, state.renderRange.start - batchSize);
        state.renderRange.end = Math.min(total, state.renderRange.start + maxRendered);
    } else if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 20 && state.renderRange.end < total) {
        direction = "forward";
        state.renderRange.end = Math.min(total, state.renderRange.end + batchSize);
        state.renderRange.start = Math.max(0, state.renderRange.end - maxRendered);
    }

    if (!direction) return false;

    const anchor = getScrollAnchor(viewport);
    render();

    if (!restoreScrollAnchor(viewport, anchor)) {
        viewport.scrollTop = fallbackScrollTop(anchor, direction, viewport);
    }
    return true;
}

/** How far from the bottom (px) before the jump-to-latest pill appears. */
export const SCROLL_LATEST_THRESHOLD = 320;
const pendingLatestButtonFrames = new WeakSet();

/**
 * Shows the floating jump-to-latest pill once the conversation is scrolled
 * away from the newest message. The virtual window matters as much as the
 * pixel offset: sitting at the bottom of a mid-chat window is still far from
 * the latest message, so an unrendered tail also counts as "scrolled up".
 */
export function syncScrollLatestButton(button, viewport, state) {
    if (!button) return;

    if (!viewport || !state.filteredMessages.length) {
        button.hidden = true;
        button.classList.remove("show");
        return;
    }

    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const hasUnrenderedTail = state.renderRange.end < state.filteredMessages.length;
    const shouldShow = hasUnrenderedTail || distance > SCROLL_LATEST_THRESHOLD;

    if (shouldShow) {
        button.hidden = false;
        // Scroll events can arrive many times before a frame. Queue one reveal
        // and recheck state so a stale frame cannot resurrect the pill.
        if (!button.classList.contains("show") && !pendingLatestButtonFrames.has(button)) {
            pendingLatestButtonFrames.add(button);
            requestAnimationFrame(() => {
                pendingLatestButtonFrames.delete(button);
                const currentDistance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
                const stillAway = state.renderRange.end < state.filteredMessages.length || currentDistance > SCROLL_LATEST_THRESHOLD;
                if (!button.hidden && stillAway) button.classList.add("show");
            });
        }
        return;
    }

    button.classList.remove("show");
    window.setTimeout(() => {
        if (!button.classList.contains("show")) button.hidden = true;
    }, 200);
}
