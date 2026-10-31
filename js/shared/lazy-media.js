/**
 * ============================================================================
 * Lazy media hydration
 * ============================================================================
 * Rendered media elements start with `data-lazy-media="<id>"` and no `src`.
 * An IntersectionObserver on the scroll viewport swaps the blob URL in when
 * the element comes within 800px of view, so a chat with thousands of photos
 * only decodes the ones near the reader.
 *
 *   const lazyMedia = createLazyMediaLoader({ rootId, getMedia, ensureUrl, onDetached });
 *   lazyMedia.hydrate();     // after every render
 *   lazyMedia.disconnect();  // before re-rendering or resetting
 *
 * A photo has no intrinsic size until it decodes, so its row changes height
 * the moment the bytes arrive. When that row sits above the reader, everything
 * below it — including the message they are reading — slides by the same
 * amount. Chrome and Firefox compensate on their own (scroll anchoring);
 * Safari has no scroll anchoring, which is why the chat jumped on iPhones.
 *
 * The fix measures the element before its `src` is set and, on every later
 * layout pass until it settles, moves `scrollTop` by exactly the height that
 * changed above the reading line. Measuring one element's own growth is
 * immune to the ordering problems of a whole-list anchor: several photos
 * finishing in the same frame each compensate for their own box, so the
 * corrections add up instead of fighting.
 * ============================================================================
 */
import { $ } from "./dom.js?v=1.8.25";

/** Browsers with native scroll anchoring need no help and must not get any. */
const HAS_SCROLL_ANCHORING = typeof document !== "undefined"
    && document.documentElement
    && "overflowAnchor" in document.documentElement.style;

/**
 * How far to move `scrollTop` after an element changed height.
 *
 * `previous` and `current` are the element's boxes before and after the
 * change; `readingLine` is the top of the scroll viewport in the same
 * coordinates. A box that grows downwards from a top edge above the reading
 * line pushes everything under it down by the same amount, so the reader would
 * see the conversation move unless the viewport follows. A box entirely below
 * the line can grow all it likes without moving what is being read.
 *
 * @returns {number} Pixels to add to `scrollTop` (may be negative).
 */
export function compensatingScrollShift(previous, current, readingLine) {
    const delta = current.height - previous.height;
    if (!delta) return 0;
    if (previous.top >= readingLine) return 0;
    return delta;
}

/**
 * Inline `style="aspect-ratio: …"` for a media box whose real ratio is known.
 *
 * Only already-decoded attachments have a ratio (see `rememberMediaRatio`),
 * so a re-render reserves the exact box the photo will take instead of the
 * generic placeholder. Without this every re-render collapses the photo rows
 * for a frame and springs them back, moving the conversation.
 *
 * @param {Object|undefined} media  Media record, possibly with `ratio`.
 * @returns {string} An attribute fragment, or "" when the ratio is unknown.
 */
export function mediaRatioStyle(media) {
    const ratio = Number(media?.ratio);
    if (!isFinite(ratio) || ratio <= 0) return "";
    return ` style="aspect-ratio: ${ratio}"`;
}

/**
 * @param {Object}   options
 * @param {string}   options.rootId       Scroll container the observer watches.
 * @param {Function} options.getMedia     id → media record (or undefined).
 * @param {Function} options.ensureUrl    media → Promise<blob URL>.
 * @param {Function} [options.onDetached] Called with the media when the element
 *                                        left the DOM before its URL arrived,
 *                                        so the caller can release it again.
 */
export function createLazyMediaLoader({ rootId, getMedia, ensureUrl, onDetached }) {
    let observer = null;

    /**
     * Remembers a decoded photo's aspect ratio on its media record so the next
     * render can reserve the same box before the bytes arrive again.
     */
    function rememberMediaRatio(media, element) {
        if (media.ratio || !element.naturalWidth || !element.naturalHeight) return;
        media.ratio = element.naturalWidth / element.naturalHeight;
    }

    /**
     * Starts watching one element's height.
     *
     * The returned function compares the element with where it was last seen
     * and, when that box starts above the reading line, scrolls by the height
     * it gained or lost. Growth belongs to the top edge of the box and pushes
     * everything below it down, so a box that begins below the line cannot
     * move the reader and is ignored.
     */
    function trackHeight(element) {
        const root = $(rootId);
        if (!root || HAS_SCROLL_ANCHORING) return () => {};

        let last = element.getBoundingClientRect();

        return function compensate() {
            if (!element.isConnected) return;
            const rect = element.getBoundingClientRect();
            const shift = compensatingScrollShift(last, rect, root.getBoundingClientRect().top);
            last = rect;
            if (shift) root.scrollTop += shift;
        };
    }

    /**
     * Runs `compensate` for the frame in which the bytes land and the next one,
     * where a bitmap or font metric may still settle the final size.
     */
    function settle(compensate) {
        compensate();
        requestAnimationFrame(() => {
            compensate();
            requestAnimationFrame(compensate);
        });
    }

    async function loadElement(element) {
        const mediaId = element.dataset.lazyMedia || element.dataset.mediaId;
        const media = getMedia(mediaId);
        if (!media) return;

        element.removeAttribute("data-lazy-media");

        const markLoaded = () => {
            element.classList.add("loaded");
            media.hasLoaded = true;
            rememberMediaRatio(media, element);
        };

        let source = "";
        try {
            source = await ensureUrl(media);
        } catch (error) {
            console.error(error);
            return;
        }
        // The render window may have moved on while the entry was decoding.
        if (!element.isConnected) {
            onDetached?.(media);
            return;
        }

        // Measure before the `src` that changes the box, then keep the reader
        // in place through every layout pass the load causes.
        const compensate = trackHeight(element);

        if (element.tagName === "VIDEO") {
            element.addEventListener("loadeddata", () => {
                // Drop the play-icon placeholder that sits before the <video>.
                element.previousElementSibling?.remove();
                markLoaded();
                settle(compensate);
            }, { once: true });
            element.src = source;
            element.load();
        } else if (element.tagName === "AUDIO") {
            element.addEventListener("loadedmetadata", () => {
                markLoaded();
                showVoiceNoteDuration(element);
            }, { once: true });
            element.src = source;
            element.load();
        } else {
            element.onload = () => {
                markLoaded();
                settle(compensate);
            };
            element.src = source;
            if (element.complete) {
                markLoaded();
                settle(compensate);
            }
        }
    }

    /** Fills the "–:––" label on a voice-note card once the duration is known. */
    function showVoiceNoteDuration(audio) {
        const duration = audio.duration;
        if (!duration || !isFinite(duration)) return;
        const durationEl = document.querySelector(`.voice-duration[data-media-id="${audio.dataset.mediaId}"]`);
        if (!durationEl) return;
        const minutes = Math.floor(duration / 60);
        const seconds = String(Math.floor(duration % 60)).padStart(2, "0");
        durationEl.textContent = `${minutes}:${seconds}`;
    }

    /** Observes every not-yet-loaded media element under the root. */
    function hydrate() {
        const root = $(rootId);
        if (!root) return;

        if (!("IntersectionObserver" in window)) {
            root.querySelectorAll("[data-lazy-media]").forEach(loadElement);
            return;
        }

        if (!observer) {
            observer = new IntersectionObserver((entries, activeObserver) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    loadElement(entry.target);
                    activeObserver.unobserve(entry.target);
                });
            }, {
                root,
                rootMargin: "800px 0px"
            });
        }

        root.querySelectorAll("[data-lazy-media]").forEach((element) => {
            observer.observe(element);
        });
    }

    function disconnect() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    return { hydrate, disconnect, loadElement };
}
