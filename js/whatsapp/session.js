/**
 * ============================================================================
 * Chat session
 * ============================================================================
 * The load pipeline, end to end: take a File (freshly picked or a stored
 * copy), open it (ZIP or plain text), parse it, put the chat on screen and
 * hand it to persistent storage. Also the reverse — closing a chat back to
 * the empty viewer.
 * ============================================================================
 */
import { BlobReader, ZipReader } from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js/+esm";
import { t, getLanguage } from "../i18n.js?v=1.8.27";
import { exportChatAsHTML } from "../export.js?v=1.8.27";
import { showSponsorPrompt } from "../support.js?v=1.8.27";
import { $, nextFrame, wait } from "../shared/dom.js?v=1.8.27";
import { exceedsCompatLimit, fileTooLargeMessage } from "../shared/compat.js?v=1.8.27";
import { baseName } from "../shared/media-types.js?v=1.8.27";
import { ISSUES_URL, state } from "./state.js?v=1.8.27";
import { buildMediaStore, cleanupMediaStore, closeMediaModal, lazyMedia } from "./media.js?v=1.8.27";
import { parseChatData, parseChatDataFromEntry } from "./parser.js?v=1.8.27";
import { populateSenderFilter, resetSenderFilterUI } from "./filter.js?v=1.8.27";
import {
    isPersistentStorageEnabled,
    markStoredImportOpened,
    persistCurrentImport,
    renderStoredImports,
    saveActiveScrollPosition
} from "./persistence.js?v=1.8.27";
import { captureScrollPosition, collectExportMessages, renderChatList, restoreScrollPosition, scrollToBottom } from "./render.js?v=1.8.27";
import { setSearchEmptyState, toggleSearch, updateSearchCounter } from "./search.js?v=1.8.27";
import { generateStats } from "./stats.js?v=1.8.27";
import { loadFavorites } from "./favorites.js?v=1.8.27";
import { isServerStorageEnabled, rememberServerChat, uploadChatToServer } from "./server-storage.js?v=1.8.27";
import {
    closeMenu,
    isMobileLayout,
    playChatRevealOnce,
    restoreEmptyState,
    setLoadingState,
    setSidebarState,
    setUploadPanelVisible,
    showEmptyState,
    showToast,
    updateLoadingCopy
} from "./ui.js?v=1.8.27";

const HOW_TO_EXPORT_CTA = `<a class="empty-cta" href="how-to-export.html"><i class="ph ph-question"></i> ${t("Cómo exportar chats de WhatsApp")}</a>`;

/** "Load Chat" button: validates the form, then opens the picked file. */
export async function initViewer() {
    if (state.isLoading) return;

    const fileInput = $("file-input");
    const nameInput = $("display-name");
    const file = fileInput?.files?.[0] || state.selectedFile;
    const displayName = nameInput?.value.trim();

    if (!file) {
        showToast(t("Selecciona un archivo"), "warn");
        return;
    }
    if (!displayName) {
        showToast(t("Escribe tu nombre visible"), "warn");
        return;
    }

    await loadChatFile(file, {
        displayName,
        persist: !isServerStorageEnabled() && isPersistentStorageEnabled(),
        uploadToServer: isServerStorageEnabled()
    });
}

/**
 * Opens an export through the normal pipeline. `file` is either the File the
 * user just picked or the on-disk copy handed back by persistent storage — the
 * parser and media layer can't tell the difference.
 *
 * @param {File}   file
 * @param {Object} options
 * @param {string} options.displayName  The user's name in the chat.
 * @param {string} [options.fileLabel]  Original file name, when `file` is a stored copy.
 * @param {boolean} [options.persist]   Copy the export to persistent storage after it opens.
 * @param {string} [options.importId]   Stored import being reopened, if any.
 */
export async function loadChatFile(file, { displayName, fileLabel = "", persist = false, importId = "", remoteImportId = "", uploadToServer = false, scrollPosition = null, remoteManifest = null, onRemoteProgress = null } = {}) {
    if (state.isLoading) return;

    const remoteChatId = remoteManifest?.id || "";
    fileLabel ||= remoteManifest?.originalFileName || file?.name || t("Chat de WhatsApp");

    state.myName = displayName;
    state.activeImportId = "";
    state.activeScrollPosition = scrollPosition;

    const isZip = remoteChatId ? remoteManifest.archiveType === "zip" : Boolean(file?.name.toLowerCase().endsWith(".zip"));
    const initText = isZip ? t("Abriendo el ZIP y escaneando archivos...") : t("Leyendo el archivo de texto...");

    setLoadingState(true, t("Cargando {name}", { name: fileLabel }), initText);

    // Let the overlay paint before the heavy lifting starts.
    await nextFrame();
    await wait(60);

    cleanupMediaStore();
    resetChatState();
    resetSenderFilterUI();
    restoreEmptyState();

    if (isMobileLayout()) {
        setSidebarState(false);
    }

    const gen = ++state.loadGeneration;

    if (file && exceedsCompatLimit(file)) {
        setLoadingState(false);
        showToast(fileTooLargeMessage(file), "error");
        return;
    }

    try {
        let { rawText, chatEntry, attachments } = await loadChatExport(file, {
            remoteChatId,
            remoteManifest,
            onRemoteProgress
        });

        updateLoadingCopy(
            attachments.length
                ? t("Se encontraron {count} archivos adjuntos. Extrayendo el chat...", { count: attachments.length.toLocaleString() })
                : t("Extrayendo el chat...")
        );

        await wait(30);

        buildMediaStore(attachments);
        if (chatEntry) {
            await parseChatDataFromEntry(chatEntry, gen);
        } else {
            await parseChatData(rawText);
            rawText = null; // release large string after parsing
        }

        if (state.messageOnlyCount === 0) {
            showNothingParsedState();
            return;
        }

        let completedRemoteId = remoteImportId;
        let remoteSaveError = null;
        if (uploadToServer && file) {
            updateLoadingCopy(t("Guardando una copia privada en el servidor Dockploy…"));
            try {
                completedRemoteId = await uploadChatToServer(file, displayName, (percentage) => {
                    updateLoadingCopy(t("Guardando una copia privada en el servidor Dockploy… {percent}%", { percent: percentage }));
                });
            } catch (error) {
                remoteSaveError = error;
                console.warn("The chat opened but its server copy was not completed:", error);
            }
        }

        await loadFavorites({ importId, fileLabel, serverChatId: completedRemoteId });
        updateUIState(fileLabel);
        state.activeImportId = completedRemoteId ? `server:${completedRemoteId}` : "";
        if (completedRemoteId) rememberServerChat(completedRemoteId);
        renderChatList();
        if (importId) markStoredImportOpened(importId);
        if (!scrollPosition || !restoreScrollPosition(scrollPosition)) {
            requestAnimationFrame(() => {
                scrollToBottom();
                if (importId || completedRemoteId) saveActiveScrollPosition(captureScrollPosition());
            });
        }
        showToast(remoteSaveError
            ? t("Chat abierto, pero no se guardó ninguna copia en el servidor ({error})", { error: remoteSaveError.message })
            : t("Se cargaron {count} mensajes", { count: state.messageOnlyCount.toLocaleString() }));
        showSponsorPrompt();

        if (!importId && persist && file) {
            persistCurrentImport(file, gen);
        }
    } catch (error) {
        console.error(error);
        const shown = showEmptyState({
            icon: "ph-duotone ph-warning-circle",
            iconColor: "#f5a623",
            title: t("No se pudo procesar este archivo"),
            body: error.message || t("Asegúrate de que sea una exportación válida de WhatsApp en .txt o .zip."),
            actions: HOW_TO_EXPORT_CTA
        });
        if (!shown) {
            showToast(`Error: ${error.message}`, "error");
        }
    } finally {
        setLoadingState(false);
    }
}

/** The file opened but produced no messages: explain which kind of "no". */
function showNothingParsedState() {
    const { unrecognizedHeaders, unrecognizedSample } = state.parseDiagnostics;
    if (unrecognizedHeaders > 0) {
        // The file is full of timestamp-shaped lines we couldn't read:
        // a date/time format ChatLume doesn't know yet, not a wrong file.
        showEmptyState({
            icon: "ph-duotone ph-calendar-x",
            iconColor: "#f5a623",
            title: t("Formato de fecha no reconocido"),
            body: t("Parece una exportación de WhatsApp, pero sus horas usan un formato que ChatLume aún no puede leer ({count} líneas como \"{sample}\"). Informa de esta línea para que se pueda añadir el formato.", {
                count: unrecognizedHeaders.toLocaleString(),
                sample: unrecognizedSample
            }),
            actions: `<a class="empty-cta" href="${ISSUES_URL}" target="_blank" rel="noopener noreferrer"><i class="ph ph-bug"></i> ${t("Informar de este formato")}</a>`
        });
        showToast(t("Las horas de esta exportación usan un formato no compatible"), "error");
        return;
    }
    showEmptyState({
        icon: "ph-duotone ph-file-dashed",
        iconColor: "#f5a623",
        title: t("No se encontraron mensajes"),
        body: t("El archivo se abrió, pero nada en él parecía un mensaje de WhatsApp. Las exportaciones deben ser chats en texto plano, no copias de seguridad ni bases de datos."),
        actions: HOW_TO_EXPORT_CTA
    });
    showToast(t("No se pudo procesar ningún mensaje de esta exportación"), "error");
}

/**
 * Opens the export. For a ZIP, picks the largest .txt as the chat and lists
 * every other entry as an attachment (nothing is decompressed yet).
 */
async function loadChatExport(file, { remoteChatId = "", remoteManifest = null, onRemoteProgress = null } = {}) {
    if (remoteChatId && remoteManifest) {
        const attachments = (remoteManifest.attachments || []).map((attachment) => ({
            ...attachment,
            remoteUrl: `/api/chats/${encodeURIComponent(remoteChatId)}/media?path=${encodeURIComponent(attachment.path)}`
        }));
        const chatEntry = {
            uncompressedSize: remoteManifest.chatSize || 1,
            async getData(writableStream) {
                const response = await fetch(`/api/chats/${encodeURIComponent(remoteChatId)}/chat`, { cache: "no-store" });
                if (!response.ok) throw new Error(t("No se pudo leer el chat del servidor (HTTP {status})", { status: response.status }));
                const total = Number(response.headers.get("Content-Length")) || remoteManifest.chatSize || 0;
                const writer = writableStream.getWriter();
                let loaded = 0;
                try {
                    if (response.body?.getReader) {
                        const reader = response.body.getReader();
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            await writer.write(value);
                            loaded += value.byteLength;
                            onRemoteProgress?.(loaded, total);
                        }
                    } else {
                        const bytes = new TextEncoder().encode(await response.text());
                        await writer.write(bytes);
                        loaded = bytes.byteLength;
                        onRemoteProgress?.(loaded, total);
                    }
                    await writer.close();
                } catch (error) {
                    await writer.abort(error).catch(() => {});
                    throw error;
                }
            }
        };
        return { rawText: null, chatEntry, attachments };
    }

    if (!file) throw new Error(t("No se proporcionó ningún archivo local."));
    if (!file.name.toLowerCase().endsWith(".zip")) {
        return { rawText: await readFileAsText(file), chatEntry: null, attachments: [] };
    }

    const reader = new ZipReader(new BlobReader(file));
    state.zipReader = reader;
    const allEntries = await reader.getEntries();

    const entries = allEntries.filter((e) => !e.directory && !e.filename.startsWith("__MACOSX/"));
    const chatEntry = entries
        .filter((e) => e.filename.toLowerCase().endsWith(".txt"))
        .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];

    if (!chatEntry) {
        throw new Error(t("No se encontró ningún archivo .txt en el ZIP"));
    }

    const attachments = entries
        .filter((e) => e !== chatEntry)
        .map((e) => ({
            name: baseName(e.filename),
            path: e.filename,
            entry: e,
            size: e.uncompressedSize || 0
        }));

    return { rawText: null, chatEntry, attachments };
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(String(event.target?.result || ""));
        reader.onerror = () => reject(reader.error || new Error(t("No se pudo leer el archivo")));
        reader.readAsText(file, "utf-8");
    });
}

/** Returns every per-chat field of `state` to its default. */
export function resetChatState() {
    state.messages = [];
    state.filteredMessages = [];
    state.messageOnlyCount = 0;
    state.selectedSenders = [];
    state.colorMap = {};
    state.senderStats = Object.create(null);
    state.emojiStats = {};
    state.hourlyStats = Array(24).fill(0);
    state.mediaCount = 0;
    state.mediaMissingCount = 0;
    state.searchResults = [];
    state.searchPointer = -1;
    window.clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.favoriteIds = new Set();
    state.favoriteStoreKey = "";
    state.favoriteServerId = "";
    state.inferredDateOrder = "DMY";
    state.parseDiagnostics = { unrecognizedHeaders: 0, unrecognizedSample: "" };
    state.activeMediaId = "";
    lazyMedia.disconnect();
    updateSearchCounter();
    setSearchEmptyState(false);
    if ($("message-list")) $("message-list").innerHTML = "";
    if ($("emoji-grid")) $("emoji-grid").innerHTML = "";
}

/** Puts the loaded chat's name and counts into the sidebar and header. */
function updateUIState(filename) {
    setUploadPanelVisible(false);
    $("empty-state")?.classList.add("hidden");
    playChatRevealOnce();
    // A freshly picked file replaces whichever stored chat was highlighted.
    renderStoredImports();

    state.chatTitle = filename.replace(/(_chat\.txt|WhatsApp Chat with |\.\w+$)/gi, "").trim() || t("Historial de chats");
    const withMedia = state.mediaCount ? t(" • {count} archivos", { count: state.mediaCount.toLocaleString() }) : "";

    if ($("sidebar-title")) $("sidebar-title").innerText = state.chatTitle;
    if ($("header-name")) $("header-name").innerText = state.chatTitle;
    if ($("header-meta")) $("header-meta").innerText = t("{count} mensajes{media}", { count: state.messageOnlyCount.toLocaleString(), media: withMedia });
    if ($("sidebar-sub")) $("sidebar-sub").innerText = state.mediaMissingCount
        ? (state.mediaMissingCount === 1
            ? t("{count} archivo adjunto faltante", { count: state.mediaMissingCount })
            : t("{count} archivos adjuntos faltantes", { count: state.mediaMissingCount }))
        : t("Cargado correctamente");
    if ($("profile-display-name")) $("profile-display-name").innerText = state.myName || t("Tú");

    ensureExportButton();
    populateSenderFilter();
}

/** Adds the two HTML export choices to the header menu. */
function ensureExportButton() {
    const menu = $("header-menu");
    if (!menu || $("export-chat-btn")) return;

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
                const exportedMessages = collectExportMessages();
                const exportedCount = exportedMessages.filter((m) => m.type === "msg").length;
                const isFiltered = Boolean(state.selectedSenders && state.selectedSenders.length > 0);
                const filterSuffix = isFiltered
                    ? ` (${state.selectedSenders.length === 1 ? state.selectedSenders[0] : t("{count} participantes", { count: state.selectedSenders.length })})`
                    : "";
                if (includeAttachments) showToast(t("Preparando el chat y los archivos adjuntos…"));
                const result = await exportChatAsHTML({
                    theme: "whatsapp",
                    colorScheme: document.body.classList.contains("light-theme") ? "light" : "dark",
                    includeAttachments,
                    mediaStore: state.mediaStore,
                    title: `${state.chatTitle || t("Chat de WhatsApp")}${filterSuffix}`,
                    messageCount: exportedCount,
                    messages: exportedMessages,
                    // Baked into the file: whoever opens it has no selector.
                    language: getLanguage()
                });
                showToast(includeAttachments
                    ? (result.attachmentCount === 1
                        ? t("Chat exportado con {count} archivo adjunto", { count: result.attachmentCount })
                        : t("Chat exportado con {count} archivos adjuntos", { count: result.attachmentCount }))
                    : t("Chat exportado como HTML"));
            } catch (err) {
                console.error("[ChatLume] Export failed:", err);
                showToast(t("La exportación falló"), "error");
            } finally {
                btn.disabled = false;
            }
        });
        menu.appendChild(btn);
    };

    addButton("export-chat-btn", t("Exportar sin archivos adjuntos (.html)"), "ph-file-text", false);
    addButton("export-chat-media-btn", t("Exportar con archivos adjuntos (.zip)"), "ph-file-zip", true);
}

/**
 * Puts the viewer back to its just-opened state. Used when the stored copy
 * behind the open chat is deleted — its media can no longer be read, so
 * keeping the conversation on screen would only half work.
 */
export function closeActiveChat() {
    state.loadGeneration += 1;
    if (state.isSearchOpen) toggleSearch();
    closeMediaModal();
    cleanupMediaStore();
    resetChatState();
    resetSenderFilterUI();
    state.activeImportId = "";
    state.activeScrollPosition = null;
    state.chatTitle = t("Historial de chats");
    restoreEmptyState();
    $("empty-state")?.classList.remove("hidden");
    if ($("header-name")) $("header-name").innerText = t("Bienvenido");
    if ($("header-meta")) $("header-meta").innerText = "ChatLume";
    if ($("sidebar-title")) $("sidebar-title").innerText = t("Historial de chats");
    if ($("sidebar-sub")) $("sidebar-sub").innerText = t("Activo ahora");
    // updateUIState() re-creates this on the next load.
    $("export-chat-btn")?.remove();
    generateStats();
    setUploadPanelVisible(true);
}
