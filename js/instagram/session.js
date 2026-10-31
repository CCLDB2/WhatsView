/**
 * ============================================================================
 * Instagram session
 * ============================================================================
 * Opens the export ZIP, finds its conversations, and loads the chosen one
 * onto the screen. Both steps are guarded by generation counters so a
 * second pick mid-way can't interleave with the first.
 * ============================================================================
 */
import { exportChatAsHTML } from "../export.js?v=1.8.25";
import { showSponsorPrompt } from "../support.js?v=1.8.25";
import { $, q, replayClass, escapeAttribute, escapeHtml } from "../shared/dom.js?v=1.8.25";
import { exceedsCompatLimit, fileTooLargeMessage } from "../shared/compat.js?v=1.8.25";
import { clearMediaStore } from "../shared/media-urls.js?v=1.8.25";
import { t, getLocale } from "../i18n.js?v=1.8.25";
import { fixMojibake } from "./mojibake.js?v=1.8.25";
import { igState } from "./state.js?v=1.8.25";
import { cleanupZip, lazyMedia } from "./media.js?v=1.8.25";
import { buildMediaStore, findThreads, folderLabel, initialsFor, parseMessageFile, parseMessages, sortMessageFiles, sortMessagesChronologically } from "./parser.js?v=1.8.25";
import { collectExportMessages, renderChatList, scrollToBottom } from "./render.js?v=1.8.25";
import { showThreadSelector } from "./threads.js?v=1.8.25";
import { persistInstagramImport, markInstagramImportOpened } from "./persistence.js?v=1.8.25";
import { getInstagramSenders } from "./filter.js?v=1.8.25";
import { initialThreadSelection } from "./threads-model.js?v=1.8.25";
import {
    closeMenu,
    generateStats,
    isMobileLayout,
    setLoading,
    setSidebarState,
    showEmptyThreadState,
    showErrorState,
    showToast,
    yieldToPaint
} from "./ui.js?v=1.8.25";

const ZIP_JS_URL = "https://cdn.jsdelivr.net/npm/@zip.js/zip.js/+esm";
let zipApiPromise = null;

/** Loads the ZIP library on demand so its CDN cannot block the viewer boot. */
function loadZipApi() {
    if (!zipApiPromise) {
        zipApiPromise = import(ZIP_JS_URL)
            .then((api) => {
                api.configure({ useDecompressionStream: typeof DecompressionStream !== "undefined" });
                return api;
            })
            .catch((error) => {
                zipApiPromise = null;
                throw error;
            });
    }
    return zipApiPromise;
}

/** "Load DMs" button: validates the picked file, then scans the ZIP. */
export async function initViewer({ file: fileOverride = null, record = null } = {}) {
    if (igState.isLoading) return;
    const file = fileOverride || $("ig-file-input")?.files?.[0] || igState.selectedFile;
    if (!file) { showToast(t("Selecciona un ZIP de exportación de Instagram"), "warn"); return; }
    if (!file.name.toLowerCase().endsWith(".zip")) { showToast(t("Selecciona un archivo .zip"), "warn"); return; }

    if (exceedsCompatLimit(file)) {
        showToast(fileTooLargeMessage(file), "error");
        return;
    }

    const gen = ++igState.loadGeneration;
    const isStaleZip = () => igState.loadGeneration !== gen;

    cleanupZip();
    igState.currentFile = file;
    igState.activeImportId = record?.id || "";
    igState.restoreImportId = record?.id || "";
    igState.restoreThreadFolder = record?.threadFolder || "";
    if (record?.ownerName && $("ig-my-name") && !$("ig-my-name").value.trim()) $("ig-my-name").value = record.ownerName;

    setLoading(true, t("Abriendo el ZIP"), t("Leyendo tu exportación de Instagram..."));
    try {
        await yieldToPaint();
        if (isStaleZip()) return;
        const { BlobReader, ZipReader } = await loadZipApi();
        if (isStaleZip()) return;
        const reader = new ZipReader(new BlobReader(file));
        const entries = await reader.getEntries();
        if (isStaleZip()) {
            reader.close().catch(() => {});
            return;
        }
        igState.zipEntries = entries;
        igState.zipReader = reader;

        setLoading(true, t("Escaneando conversaciones"), t("Buscando carpetas de mensajes..."));
        await yieldToPaint();
        if (isStaleZip()) return;

        const threads = findThreads(entries);
        if (!threads.length) throw new Error(t("No se encontraron carpetas de mensajes de Instagram. Asegúrate de elegir el formato JSON al pedir la exportación."));

        igState.threads = threads;
        setLoading(false);

        const selectedThread = initialThreadSelection(threads, record?.threadFolder || "");
        if (selectedThread) {
            await loadThread(selectedThread);
            return;
        }
        showThreadSelector(threads, loadThread);
    } catch (err) {
        if (isStaleZip()) return;
        console.error(err);
        showErrorState("Couldn't load this file", err.message || "Make sure it's a valid Instagram JSON export ZIP.");
        setLoading(false);
    }
}

/** Returns every per-thread field of `igState` to its default. */
function resetThreadState() {
    igState.messages = [];
    igState.filteredMessages = [];
    igState.selectedSenders = [];
    igState.messageOnlyCount = 0;
    igState.colorMap = {};
    igState.senderStats = {};
    igState.emojiStats = {};
    igState.hourlyStats = Array(24).fill(0);
    igState.mediaCount = 0;
    igState.mediaMissingCount = 0;
    igState.searchResults = [];
    igState.searchPointer = -1;
    igState.searchQuery = "";
    clearTimeout(igState.searchTimer);
    igState.searchTimer = null;
    igState.activeMediaId = "";
    $("ig-sender-filter-list")?.replaceChildren();
    $("ig-sender-filter-container")?.setAttribute("hidden", "");
    clearMediaStore(igState);
    lazyMedia.disconnect();
    if ($("ig-message-list")) $("ig-message-list").innerHTML = "";
}

/**
 * Parses one conversation folder and puts it on screen.
 *
 * Picking a second conversation before the first finished parsing appended
 * both into igState.messages, interleaving two threads in one view. Every
 * await below re-checks the generation token and bails if a newer load has
 * started.
 */
export async function loadThread(thread) {
    const gen = ++igState.threadGeneration;
    const isStale = () => igState.threadGeneration !== gen;

    setLoading(true, t("Cargando la conversación"), t("Procesando mensajes..."));
    try {
        await yieldToPaint();
        if (isStale()) return;
        const { TextWriter } = await loadZipApi();
        if (isStale()) return;
        resetThreadState();

        const sortedFiles = sortMessageFiles(thread.files);

        let allRaw = [];
        let threadTitle = folderLabel(thread.folder);
        let participants = [];

        for (let i = 0; i < sortedFiles.length; i++) {
            setLoading(true, t("Cargando la conversación"), t("Procesando el archivo {current} de {total}...", { current: i + 1, total: sortedFiles.length }));
            await yieldToPaint();
            if (isStale()) return;
            const text = await sortedFiles[i].getData(new TextWriter("utf-8"));
            if (isStale()) return;
            const data = parseMessageFile(text);
            if (!data) continue;
            if (typeof data.title === "string" && data.title) threadTitle = fixMojibake(data.title);
            if (Array.isArray(data.participants) && data.participants.length && !participants.length) {
                participants = data.participants.map((p) => fixMojibake(String(p?.name || ""))).filter(Boolean);
            }
            if (Array.isArray(data.messages) && data.messages.length) allRaw.push(...data.messages);
        }

        // Oldest first
        allRaw = sortMessagesChronologically(allRaw);

        const nameInput = $("ig-my-name")?.value.trim();
        // Instagram lists the account owner LAST in `participants`, so falling back
        // to participants[0] labelled the other person's messages as yours and
        // flipped every bubble in the thread.
        igState.myName = nameInput || participants[participants.length - 1] || "";
        igState.chatTitle = threadTitle;

        // Build media store from all non-JSON files in the ZIP
        buildMediaStore(igState.zipEntries);

        const validRaw = allRaw.filter((m) => !m.is_unsent);
        allRaw = null; // release raw message array memory before parsing
        parseMessages(validRaw);
        generateStats();

        if (igState.messageOnlyCount === 0) {
            showEmptyThreadState(igState.threads.length > 1 ? () => showThreadSelector(igState.threads, loadThread) : null);
            showToast(t("No se encontraron mensajes en esta conversación"), "error");
            setLoading(false);
            return;
        }

        updateUI(threadTitle, participants);
        populateInstagramSenderFilter();
        renderChatList();
        requestAnimationFrame(scrollToBottom);
        showToast(t("Se cargaron {count} mensajes", { count: igState.messageOnlyCount.toLocaleString(getLocale()) }));
        if (isMobileLayout()) setSidebarState(false);
        if (igState.activeImportId) {
            try { await markInstagramImportOpened(thread); }
            catch (error) { console.warn("Saved thread metadata could not be updated:", error); }
        } else void persistInstagramImport(igState.currentFile, thread);
        showSponsorPrompt();
    } catch (err) {
        if (!isStale()) {
            console.error(err);
            showErrorState(t("No se pudo procesar este archivo"), err.message || t("Asegúrate de que sea un ZIP válido con una exportación JSON de Instagram."));
        }
    } finally {
        if (!isStale()) setLoading(false);
    }
}

function populateInstagramSenderFilter() {
    const list = $("ig-sender-filter-list");
    if (!list) return;
    list.innerHTML = getInstagramSenders(igState.messages).map((sender, index) => `
        <label class="sender-filter-item"><input type="checkbox" value="${escapeAttribute(sender)}" id="ig-sender-${index}"><span>${escapeHtml(sender)}</span></label>
    `).join("");
}

/** Puts the loaded thread's title and counts into the sidebar and header. */
function updateUI(title, participants) {
    $("ig-upload-panel")?.classList.add("hidden");
    $("ig-thread-panel")?.classList.add("hidden");
    $("ig-chat-list-panel")?.classList.remove("hidden");
    $("ig-empty-state")?.classList.add("hidden");
    $("ig-sender-filter-container")?.removeAttribute("hidden");

    // One-shot reveal: the message list is virtualised, so animate the container
    // rather than each message.
    replayClass([$("ig-viewport"), q(".chat-header .header-profile")], "chat-revealed");

    const withMedia = igState.mediaCount ? t(" • {count} archivos", { count: igState.mediaCount.toLocaleString(getLocale()) }) : "";
    const missing = igState.mediaMissingCount ? t(" • {count} faltantes", { count: igState.mediaMissingCount.toLocaleString(getLocale()) }) : "";
    const avatar = q(".chat-item-avatar", $("ig-chat-list-item"));
    if (avatar) avatar.textContent = initialsFor(title);
    if ($("ig-sidebar-title")) $("ig-sidebar-title").innerText = title;
    if ($("ig-header-name")) $("ig-header-name").innerText = title;
    if ($("ig-header-meta")) $("ig-header-meta").innerText = t("{count} mensajes{media}{missing}", {
        count: igState.messageOnlyCount.toLocaleString(getLocale()),
        media: withMedia,
        missing
    });
    if ($("ig-sidebar-sub")) $("ig-sidebar-sub").innerText = igState.mediaMissingCount
        ? (igState.mediaMissingCount === 1
            ? t("{count} archivo adjunto faltante", { count: igState.mediaMissingCount })
            : t("{count} archivos adjuntos faltantes", { count: igState.mediaMissingCount }))
        : participants.join(", ") || t("Mensaje directo");

    ensureExportButton();
}

/** Adds the two HTML export choices to the header menu. */
function ensureExportButton() {
    const menu = $("ig-header-menu");
    if (!menu || $("ig-export-chat-btn")) return;

    const addButton = (id, label, icon, includeAttachments) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "menu-item";
        btn.id = id;
        btn.setAttribute("data-export-btn", "");
        btn.innerHTML = `<i class="ph ${icon}"></i> ${label}`;
        btn.addEventListener("click", async () => {
            closeMenu();
            btn.disabled = true;
            try {
                if (includeAttachments) showToast(t("Preparando el chat y los archivos adjuntos…"));
                const result = await exportChatAsHTML({
                    theme: "instagram",
                    colorScheme: document.body.classList.contains("light-theme") ? "light" : "dark",
                    includeAttachments,
                    mediaStore: igState.mediaStore,
                    title: igState.chatTitle || t("Mensajes directos de Instagram"),
                    messageCount: igState.messageOnlyCount,
                    messages: collectExportMessages()
                });
                showToast(includeAttachments
                    ? (result.attachmentCount === 1
                        ? t("Chat exportado con {count} archivo adjunto", { count: result.attachmentCount })
                        : t("Chat exportado con {count} archivos adjuntos", { count: result.attachmentCount }))
                    : t("Chat exportado como HTML"));
            } catch (err) {
                console.error("[ChatLume] Export failed:", err);
                showToast(t("No se pudo exportar"), "error");
            } finally {
                btn.disabled = false;
            }
        });
        menu.appendChild(btn);
    };

    addButton("ig-export-chat-btn", t("Exportar sin archivos adjuntos (.html)"), "ph-file-text", false);
    addButton("ig-export-chat-media-btn", t("Exportar con archivos adjuntos (.zip)"), "ph-file-zip", true);
}
