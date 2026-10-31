/**
 * ============================================================================
 * Persistent Storage — viewer side
 * ============================================================================
 * Off by default. When on, a freshly opened export is copied to the device
 * (see js/storage.js for the OPFS/IndexedDB layer) and offered again on the
 * next visit under "Saved on this device". Turning it off stops new copies
 * but never deletes existing ones — that is always an explicit, confirmed
 * action.
 *
 * This module doesn't know how to open a chat. The session hands it
 * `openFile` and `closeChat` through initPersistentStorage(), which keeps
 * the dependency pointing one way (session → persistence).
 * ============================================================================
 */
import * as storage from "../storage.js?v=1.8.25";
import { t } from "../i18n.js?v=1.8.25";
import { $, escapeAttribute, escapeHtml } from "../shared/dom.js?v=1.8.25";
import { formatBytes } from "../shared/media-types.js?v=1.8.25";
import { readStored, removeStored, writeStored } from "../shared/safe-storage.js?v=1.8.25";
import { STORAGE_KEYS, state } from "./state.js?v=1.8.25";
import { askConfirm, isMobileLayout, setSidebarState, showToast } from "./ui.js?v=1.8.25";
import { saveSettings, syncSettingsControls } from "./settings-store.js?v=1.8.25";
import { filterSidebarChats } from "./sidebar-search.js?v=1.8.25";
import { captureScrollPosition } from "./render.js?v=1.8.25";

/**
 * Callbacks supplied by session.js:
 *   openFile(file, { displayName, fileLabel, importId })  opens a stored copy
 *   closeChat()                                           closes the open chat
 */
const hooks = { openFile: null, closeChat: null };
let positionSaveTimer = 0;

function matchingLastPosition(id) {
    try {
        const saved = JSON.parse(readStored(STORAGE_KEYS.lastPosition) || "null");
        return saved?.id === id ? saved.position : null;
    } catch {
        return null;
    }
}

function flushActiveScrollPosition() {
    positionSaveTimer = 0;
    const id = state.activeImportId;
    const position = state.activeScrollPosition;
    if (!id || !position) return;
    writeStored(STORAGE_KEYS.lastPosition, JSON.stringify({ id, position }));
    const record = state.storedImports.find((item) => item.id === id);
    if (record) {
        record.scrollPosition = position;
        storage.putImport(record).catch(() => {});
    }
}

/** Saves a small message anchor, never the parsed conversation contents. */
export function saveActiveScrollPosition(position) {
    if (!state.activeImportId || !position) return;
    state.activeScrollPosition = position;
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(flushActiveScrollPosition, 250);
}

if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushActiveScrollPosition);
}

export function isPersistentStorageEnabled() {
    return state.storageSupported && Boolean(state.settings.persistentStorage);
}

// ── Boot ────────────────────────────────────────────────────────────────────

export async function initPersistentStorage({ openFile, closeChat }) {
    hooks.openFile = openFile;
    hooks.closeChat = closeChat;

    state.storageSupported = storage.isSupported();
    refreshStorageSettingsUI();
    if (!state.storageSupported) return;

    // Nobody who never kept a chat should pay for a storage lookup at boot.
    const everUsed = readStored(STORAGE_KEYS.persistUsed) === "1";
    if (!state.settings.persistentStorage && !everUsed) return;

    await loadStoredImports();

    if (!state.settings.persistentStorage) return;
    const lastId = readStored(STORAGE_KEYS.lastImport);
    const record = lastId ? state.storedImports.find((item) => item.id === lastId) : null;
    if (!record) return;

    await openStoredImport(record, matchingLastPosition(record.id) || record.scrollPosition || null);
    // A stored chat that can't produce messages shouldn't greet the user with
    // the same error on every launch. The import itself stays until they
    // delete it — only the automatic reopen is dropped.
    if (state.activeImportId !== record.id || state.messageOnlyCount === 0) {
        removeStored(STORAGE_KEYS.lastImport);
    }
}

export async function loadStoredImports() {
    let records = null;
    try {
        // Other viewers may keep their own kinds here one day; this sidebar only
        // knows how to open WhatsApp exports.
        records = (await storage.reconcileImports()).filter((record) => record.kind === "whatsapp");
    } catch (error) {
        // Storage misbehaved — show nothing this session, but forget nothing:
        // the records and files are still there for the next launch.
        console.warn("Persistent storage could not be read:", error);
        showToast(t("No se pudieron leer los chats guardados ahora mismo. Siguen en este dispositivo."), "warn");
    }
    state.storedImports = records || [];
    state.storedImportsLoaded = true;
    if (records && !records.length) {
        removeStored(STORAGE_KEYS.persistUsed);
        removeStored(STORAGE_KEYS.lastImport);
    }
    renderStoredImports();
    refreshStorageSettingsUI();
}

// ── Settings toggle ─────────────────────────────────────────────────────────

export function handlePersistentStorageToggle() {
    if (!state.storageSupported) {
        state.settings.persistentStorage = false;
        saveSettings();
        syncSettingsControls();
        refreshStorageSettingsUI();
        showToast(t("Tu navegador no admite el almacenamiento persistente"), "warn");
        return;
    }
    refreshStorageSettingsUI();
    if (state.settings.persistentStorage) {
        if (!state.storedImportsLoaded) loadStoredImports();
        showToast(t("Las nuevas importaciones se guardarán en este dispositivo"), "info");
        return;
    }
    if (state.persistJob) {
        // The user just said "don't keep chats" — that includes the one being
        // written right now. The cancel path removes the partial file and
        // reports back.
        cancelPersistCopy("toggle");
        return;
    }
    showToast(
        state.storedImports.length
            ? t("Desactivado. Los chats guardados seguirán en este dispositivo hasta que los elimines.")
            : t("Almacenamiento persistente desactivado"),
        "info"
    );
}

/** The "Persistent Storage" block in the Settings drawer. */
export function refreshStorageSettingsUI() {
    const checkbox = $("setting-persistent-storage");
    const unsupported = $("storage-unsupported");
    const manage = $("storage-manage");
    if (checkbox) checkbox.disabled = !state.storageSupported;
    if (unsupported) unsupported.hidden = state.storageSupported;
    if (!manage) return;

    const records = state.storedImports;
    manage.hidden = !state.storageSupported || records.length === 0;
    if (manage.hidden) return;

    const total = records.reduce((sum, record) => sum + (record.size || 0), 0);
    const summary = $("storage-summary");
    if (summary) {
        summary.textContent = records.length === 1
            ? t("{count} chat guardado · {size} en este dispositivo", { count: records.length, size: formatBytes(total) || "0 B" })
            : t("{count} chats guardados · {size} en este dispositivo", { count: records.length, size: formatBytes(total) || "0 B" });
    }
    const offNote = $("storage-off-note");
    if (offNote) offNote.hidden = Boolean(state.settings.persistentStorage);

    const list = $("storage-list");
    if (list) {
        list.innerHTML = records.map((record) => {
            const title = storedImportTitle(record);
            return `
                <div class="storage-item${record.id === state.activeImportId ? " active" : ""}">
                    <div class="storage-item-info">
                        <strong>${escapeHtml(title)}</strong>
                        <span>${escapeHtml(storedImportMeta(record))}</span>
                    </div>
                    <button type="button" class="stored-delete" data-stored-delete="${escapeAttribute(record.id)}" title="${escapeAttribute(t("Eliminar de este dispositivo"))}" aria-label="${escapeAttribute(t("Eliminar {name}", { name: title }))}"><i class="ph ph-trash"></i></button>
                </div>`;
        }).join("");
    }
}

// ── Sidebar list ────────────────────────────────────────────────────────────

/** The "Saved on this device" list(s) in the sidebar. */
export function renderStoredImports() {
    const records = state.storedImports;
    document.querySelectorAll("[data-stored-list]").forEach((list) => {
        list.hidden = records.length === 0;
        if (!records.length) {
            list.innerHTML = "";
            return;
        }
        list.innerHTML = `<div class="stored-list-head"><i class="ph-fill ph-hard-drives"></i> ${t("Guardados en este dispositivo")}</div>` +
            records.map((record) => {
                const title = storedImportTitle(record);
                return `
                    <div class="stored-item${record.id === state.activeImportId ? " active" : ""}">
                        <button type="button" class="chat-item" data-stored-open="${escapeAttribute(record.id)}">
                            <div class="chat-item-avatar" aria-hidden="true">${escapeHtml(title.charAt(0).toUpperCase())}</div>
                            <div class="chat-item-info">
                                <h4>${escapeHtml(title)}</h4>
                                <span>${escapeHtml(storedImportMeta(record))}</span>
                            </div>
                        </button>
                        <button type="button" class="stored-delete" data-stored-delete="${escapeAttribute(record.id)}" title="${escapeAttribute(t("Eliminar de este dispositivo"))}" aria-label="${escapeAttribute(t("Eliminar {name}", { name: title }))}"><i class="ph ph-trash"></i></button>
                    </div>`;
            }).join("");
    });
    filterSidebarChats($("sidebar-chat-search")?.value || "");
}

function storedImportTitle(record) {
    return record.chatTitle || record.fileName || t("Chat");
}

function storedImportMeta(record) {
    const parts = [];
    if (record.messageCount) parts.push(t("{count} mensajes", { count: record.messageCount.toLocaleString() }));
    parts.push(formatBytes(record.size) || "0 B");
    parts.push(/\.zip$/i.test(record.storedName || "") ? "ZIP" : "TXT");
    return parts.join(" · ");
}

/** Delegated click handler for both stored lists (sidebar and settings). */
export function handleStoredListClick(event) {
    const openButton = event.target.closest("[data-stored-open]");
    if (openButton) {
        const record = state.storedImports.find((item) => item.id === openButton.dataset.storedOpen);
        if (record) openStoredImport(record);
        return;
    }
    const deleteButton = event.target.closest("[data-stored-delete]");
    if (deleteButton) {
        deleteStoredImport(deleteButton.dataset.storedDelete);
    }
}

// ── Opening ─────────────────────────────────────────────────────────────────

async function openStoredImport(record, savedPosition = null) {
    if (state.isLoading) return;
    if (record.id && record.id === state.activeImportId) {
        if (isMobileLayout()) setSidebarState(false);
        return;
    }

    let file;
    try {
        file = await storage.getImportFile(record);
    } catch (error) {
        if (storage.isUnrecoverable(error)) {
            // Missing or truncated: the record points at nothing usable, so
            // drop it rather than offering a chat that can't open.
            await storage.deleteImport(record).catch(() => {});
            dropStoredImport(record.id);
            showToast(t("\"{name}\" faltaba o estaba dañado y se eliminó de este dispositivo", { name: storedImportTitle(record) }), "error");
        } else {
            // Anything else is the storage layer having a moment. The data is
            // intact; don't touch it.
            console.warn("Stored chat could not be opened:", error);
            showToast(t("No se pudo abrir \"{name}\" ahora mismo ({error}). Sigue guardado en este dispositivo.", {
                name: storedImportTitle(record),
                error: error.message || error.name
            }), "error");
        }
        return;
    }

    const nameInput = $("display-name");
    if (nameInput && !nameInput.value.trim()) nameInput.value = record.displayName || "";

    await hooks.openFile(file, {
        displayName: record.displayName || "",
        fileLabel: record.fileName,
        importId: record.id,
        scrollPosition: savedPosition || matchingLastPosition(record.id) || record.scrollPosition || null
    });
}

/** Called once a stored chat is on screen: bumps recency, refreshes metadata. */
export function markStoredImportOpened(id) {
    state.activeImportId = id;
    writeStored(STORAGE_KEYS.lastImport, id);

    const record = state.storedImports.find((item) => item.id === id);
    if (record) {
        record.lastOpenedAt = Date.now();
        record.chatTitle = state.chatTitle;
        record.messageCount = state.messageOnlyCount;
        record.mediaCount = state.mediaCount;
        record.displayName = state.myName;
        record.scrollPosition = state.activeScrollPosition || record.scrollPosition || captureScrollPosition() || { atBottom: true, scrollTop: 0 };
        storage.putImport(record).catch(() => {});
        writeStored(STORAGE_KEYS.lastPosition, JSON.stringify({ id, position: record.scrollPosition }));
        state.storedImports = storage.sortByRecency(state.storedImports);
    }
    renderStoredImports();
    refreshStorageSettingsUI();
}

/** Forgets a record in memory and in localStorage pointers (not on disk). */
function dropStoredImport(id) {
    state.storedImports = state.storedImports.filter((item) => item.id !== id);
    if (state.activeImportId === id) {
        state.activeImportId = "";
        state.activeScrollPosition = null;
    }
    if (readStored(STORAGE_KEYS.lastImport) === id) removeStored(STORAGE_KEYS.lastImport);
    if (matchingLastPosition(id)) removeStored(STORAGE_KEYS.lastPosition);
    if (!state.storedImports.length) removeStored(STORAGE_KEYS.persistUsed);
    renderStoredImports();
    refreshStorageSettingsUI();
}

// ── Copying ─────────────────────────────────────────────────────────────────

/**
 * Copies the export that just opened to the device. Runs after the chat is on
 * screen, so a multi-gigabyte copy never delays reading it. `gen` is the load
 * generation the copy belongs to: if another chat opens meanwhile the copy still
 * completes, it just doesn't become the active import.
 */
export async function persistCurrentImport(file, gen) {
    if (!state.storageSupported) return;
    if (state.persistJob) {
        showToast(t("Otro chat todavía se está guardando; vuelve a importar este cuando termine"), "warn");
        return;
    }

    // Reserve the slot before anything asynchronous: the permission prompt
    // below can sit open for as long as the user likes, and a second import in
    // that window must not start a second copy.
    const reservation = {
        cancelled: false,
        reason: "",
        cancel(reason = "user") { this.cancelled = true; this.reason = reason; }
    };
    state.persistJob = reservation;

    // Describe the chat now, while `state` still belongs to this file — by the
    // time the awaits below settle the user may have opened another one.
    const snapshot = {
        chatTitle: state.chatTitle,
        messageCount: state.messageOnlyCount,
        mediaCount: state.mediaCount,
        displayName: state.myName
    };

    try {
        if (!state.storedImportsLoaded) await loadStoredImports();

        const duplicate = storage.findDuplicate(state.storedImports, file);
        if (duplicate) {
            if (state.loadGeneration === gen) markStoredImportOpened(duplicate.id);
            showToast(t("Esta exportación ya está guardada en este dispositivo"), "info");
            return;
        }

        // Persistence first: until it is granted Firefox reports a small
        // best-effort quota that would wrongly reject large exports.
        await storage.requestPersistence();

        const needed = storage.requiredSpace(file.size);
        const estimate = await storage.estimateStorage();
        if (estimate && estimate.quota > 0 && estimate.available < needed) {
            showToast(t("No hay espacio suficiente para guardar este chat. Necesita {needed} y solo hay {available} disponibles.", {
                needed: formatBytes(needed),
                available: formatBytes(estimate.available) || "0 B"
            }), "error");
            return;
        }

        if (reservation.cancelled) {
            showToast(persistCancelMessage(reservation.reason), "info");
            return;
        }

        const id = storage.generateId();
        const job = storage.copyFileToStorage(file, id, { onProgress: updatePersistProgress });
        job.reason = "";
        state.persistJob = job;
        showPersistCard(file.size);

        let storedName;
        try {
            storedName = await job.promise;
        } catch (error) {
            hidePersistCard();
            showToast(...persistFailureToast(error, job.reason));
            return;
        }

        const now = Date.now();
        const record = {
            id,
            kind: "whatsapp",
            schemaVersion: 1,
            fileName: file.name,
            size: file.size,
            lastModified: file.lastModified,
            storedName,
            ...snapshot,
            importedAt: now,
            lastOpenedAt: now
        };

        try {
            await storage.putImport(record);
        } catch (error) {
            // No record means no import — don't leave the copy behind.
            await storage.removeStoredFile(storedName);
            hidePersistCard();
            showToast(t("No se pudo guardar este chat: {error}", { error: error.message }), "error");
            return;
        }

        writeStored(STORAGE_KEYS.persistUsed, "1");
        state.storedImports = storage.sortByRecency([...state.storedImports, record]);
        hidePersistCard();
        if (state.loadGeneration === gen) {
            markStoredImportOpened(id);
        } else {
            renderStoredImports();
            refreshStorageSettingsUI();
        }
        showToast(t("Guardado \"{name}\" en este dispositivo", { name: storedImportTitle(record) }));
    } catch (error) {
        // Nothing above should throw, but a surprise must not become an
        // unhandled rejection with a stuck progress card.
        console.warn("Persisting the import failed:", error);
        hidePersistCard();
        showToast(t("No se pudo guardar este chat: {error}", { error: error.message || error }), "error");
    } finally {
        state.persistJob = null;
    }
}

/** [message, tone] for a failed copy, by the error the storage layer raised. */
function persistFailureToast(error, cancelReason) {
    if (error.name === "AbortError") {
        return [persistCancelMessage(cancelReason), "info"];
    }
    if (error.name === "QuotaExceededError") {
        return [t("El navegador se quedó sin espacio antes de poder guardar el chat"), "error"];
    }
    if (error.name === "NotSupportedError" || error.name === "TypeError") {
        return [t("Tu navegador no admite guardar chats en el dispositivo"), "error"];
    }
    if (error.name === "UnknownError" || error.name === "InvalidStateError") {
        // Safari reports exactly this in Private Browsing, where the
        // file system exists but refuses to open.
        return [t("El almacenamiento persistente no está disponible en este modo de navegación (por ejemplo, la navegación privada). El chat está abierto, pero no se guardó."), "error"];
    }
    return [t("No se pudo guardar este chat: {error}", { error: error.message }), "error"];
}

function persistCancelMessage(reason) {
    return reason === "toggle"
        ? t("Almacenamiento persistente desactivado: se canceló el guardado en curso y el chat no se conservó")
        : t("Guardado cancelado: este chat no se conservó");
}

export function cancelPersistCopy(reason = "user") {
    if (!state.persistJob) return;
    if ("reason" in state.persistJob) state.persistJob.reason = reason;
    state.persistJob.cancel(reason);
    const progress = $("persist-card-progress");
    if (progress) progress.textContent = t("Cancelando…");
    const cancel = $("persist-card-cancel");
    if (cancel) cancel.disabled = true;
}

// ── Progress card ───────────────────────────────────────────────────────────

function showPersistCard(total) {
    const card = $("persist-card");
    if (!card) return;
    const cancel = $("persist-card-cancel");
    if (cancel) cancel.disabled = false;
    updatePersistProgress(0, total);
    card.hidden = false;
    // A small file can finish copying before this frame runs; don't reveal a
    // card for a job that has already been cleared.
    requestAnimationFrame(() => {
        if (state.persistJob) card.classList.add("show");
    });
}

function updatePersistProgress(copied, total) {
    const progress = $("persist-card-progress");
    const bar = $("persist-card-bar");
    if (progress) progress.textContent = `${formatBytes(copied) || "0 B"} / ${formatBytes(total) || "0 B"}`;
    if (bar) bar.style.width = `${total ? Math.min(100, (copied / total) * 100) : 0}%`;
}

function hidePersistCard() {
    const card = $("persist-card");
    if (!card) return;
    card.classList.remove("show");
    window.setTimeout(() => {
        if (!card.classList.contains("show")) card.hidden = true;
    }, 300);
}

// ── Deleting ────────────────────────────────────────────────────────────────

async function deleteStoredImport(id) {
    const record = state.storedImports.find((item) => item.id === id);
    if (!record) return;

    const title = storedImportTitle(record);
    const openNote = state.activeImportId === id ? t(" Ahora mismo está abierto y se cerrará.") : "";
    const confirmed = await askConfirm({
        title: t("¿Eliminar el chat guardado?"),
        body: t("\"{name}\" ({size}) se eliminará de este dispositivo.{note} Tu archivo de exportación original no se verá afectado.", {
            name: title,
            size: formatBytes(record.size) || "0 B",
            note: openNote
        }),
        confirmLabel: t("Eliminar")
    });
    if (!confirmed) return;

    try {
        await storage.deleteImport(record);
    } catch (error) {
        showToast(t("No se pudo eliminar este chat: {error}", { error: error.message }), "error");
        return;
    }
    const wasOpen = state.activeImportId === id;
    dropStoredImport(id);
    if (wasOpen) hooks.closeChat();
    showToast(t("Eliminado \"{name}\" de este dispositivo", { name: title }));
}

export async function deleteAllStoredImports() {
    if (!state.storedImports.length) return;
    const count = state.storedImports.length;
    const total = state.storedImports.reduce((sum, record) => sum + (record.size || 0), 0);
    const confirmed = await askConfirm({
        title: t("¿Eliminar todos los chats guardados?"),
        body: count === 1
            ? t("{count} chat guardado ({size}) se eliminará de este dispositivo{open}. Tus archivos de exportación originales no se verán afectados.", {
                count,
                size: formatBytes(total) || "0 B",
                open: state.activeImportId ? t(", y el chat abierto se cerrará") : ""
            })
            : t("{count} chats guardados ({size}) se eliminarán de este dispositivo{open}. Tus archivos de exportación originales no se verán afectados.", {
                count,
                size: formatBytes(total) || "0 B",
                open: state.activeImportId ? t(", y el chat abierto se cerrará") : ""
            }),
        confirmLabel: t("Eliminar todos")
    });
    if (!confirmed) return;

    try {
        await storage.deleteImportsByKind("whatsapp");
    } catch (error) {
        showToast(t("No se pudieron eliminar los chats guardados: {error}", { error: error.message }), "error");
        await loadStoredImports();
        return;
    }
    const wasOpen = Boolean(state.activeImportId);
    state.storedImports = [];
    state.activeImportId = "";
    state.activeScrollPosition = null;
    removeStored(STORAGE_KEYS.lastImport);
    removeStored(STORAGE_KEYS.lastPosition);
    removeStored(STORAGE_KEYS.persistUsed);
    renderStoredImports();
    refreshStorageSettingsUI();
    if (wasOpen) hooks.closeChat();
    showToast(t("Todos los chats guardados se eliminaron de este dispositivo"));
}
