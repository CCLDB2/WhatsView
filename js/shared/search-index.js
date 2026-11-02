/**
 * ============================================================================
 * Message search index
 * ============================================================================
 * What a message can be found by. One definition for both viewers: the two
 * copies had already drifted — WhatsApp ignored shared posts and reactions,
 * and neither could find a missing attachment by the label it displays
 * ("Multimedia omitido"), which is the only trace of it left in the UI.
 *
 * Chat content is indexed verbatim; nothing here translates the message. The
 * only interface string involved is the stand-in label shown *instead of* a
 * missing file's name, because that is what the reader sees.
 *
 * Matching itself lives in search-text.js: case, accents and whitespace runs
 * are folded, so "cancion" finds "canción".
 * ============================================================================
 */
import { t, getLanguage } from "../i18n.js?v=1.8.28";
import { foldSearchText } from "./search-text.js?v=1.8.28";

/** The label the renderer shows when a file is referenced but not exported. */
export function missingMediaLabel(name = "") {
    if (name === "Media omitted") return t("Multimedia omitido");
    return name || t("Archivo adjunto faltante");
}

/** True when the attachment has no name of its own left to show. */
function isAnonymousMissing(item) {
    return item?.status === "missing" && (!item.name || item.name === "Media omitted");
}

/**
 * Every string a message can be found by, unjoined.
 *
 * The rule is: index exactly what the row displays, never more. A message found
 * by text the reader cannot see is a dead end — the highlight lands on nothing
 * and the hit looks like a bug. So an unnamed missing attachment is indexed by
 * the stand-in label the card shows ("Multimedia omitido"), not by the raw
 * "Media omitted" token the export file happens to contain, while a missing
 * attachment that *does* have a filename keeps being findable by that name.
 *
 * Deliberately excluded: the media *kind* label ("Documento", "Imagen").
 * Searching "documento" returning every document would be chrome noise, not
 * a match on anything the message says.
 */
export function messageSearchFields(message) {
    if (!message) return [];
    const media = message.mediaItems || message.media || [];
    const mediaNames = media
        .map((item) => (isAnonymousMissing(item) ? missingMediaLabel(item.name) : item?.name))
        .filter(Boolean);
    const reactions = (message.reactions || [])
        .flatMap((reaction) => [reaction?.reaction, reaction?.actor])
        .filter(Boolean);

    return [
        message.sender,
        message.text,
        ...mediaNames,
        message.shareText,
        message.shareLink,
        ...reactions
    ].filter(Boolean).map(String);
}

/** The joined, folded text a message is matched against. */
export function searchableMessageText(message) {
    return foldSearchText(messageSearchFields(message).join(" "));
}

/**
 * Folded text per message, kept across keystrokes.
 *
 * Folding is the expensive half of a search pass (normalisation allocates a
 * new string per message), and a 25k-message chat paid it again on every
 * debounced keystroke. Messages are frozen once parsed, so the cache only has
 * to guard against a chat being replaced by a new import: the language is part
 * of the key because a missing attachment's label is translated.
 */
const FOLDED = new WeakMap();
const FOLDED_LANGUAGE = new WeakMap();

function foldedMessageText(message, language) {
    if (!message || typeof message !== "object") return "";
    const cached = FOLDED.get(message);
    if (cached !== undefined && FOLDED_LANGUAGE.get(message) === language) return cached;
    const folded = foldSearchText(messageSearchFields(message).join(" "));
    FOLDED.set(message, folded);
    FOLDED_LANGUAGE.set(message, language);
    return folded;
}

/** Ids of the messages whose searchable text contains `query`. */
export function findMessageSearchResults(messages, query) {
    const needle = foldSearchText(query);
    if (!needle) return [];
    const language = getLanguage();
    return (messages || [])
        .filter((message) => message?.type === "msg" && foldedMessageText(message, language).includes(needle))
        .map((message) => message.id);
}

/** Next pointer for up/down navigation, wrapping at either end. */
export function nextSearchIndex(index, resultCount, direction) {
    if (!resultCount) return -1;
    const step = direction === "up" ? -1 : 1;
    return (index + step + resultCount) % resultCount;
}
