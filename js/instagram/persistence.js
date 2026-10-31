/** Opt-in local ZIP storage, isolated from WhatsApp records and preferences. */
import * as storage from "../storage.js?v=1.8.24";
import { $, escapeAttribute, escapeHtml } from "../shared/dom.js?v=1.8.24";
import { readStored, removeStored, writeStored } from "../shared/safe-storage.js?v=1.8.24";
import { igState } from "./state.js?v=1.8.24";
import { writeInstagramSettings } from "./settings.js?v=1.8.24";
import { importsOfKind } from "../shared/import-records.js?v=1.8.24";
import { showToast } from "./ui.js?v=1.8.24";
import { t, getLocale } from "../i18n.js?v=1.8.24";

const USED_KEY = "chatlume-instagram-persist-used";
const LAST_KEY = "chatlume-instagram-last-import";
const hooks = { openImport: null };
let copyJob = null;
let copyingFile = null;
let pendingThread = null;

export async function initInstagramPersistence({ openImport }) {
    hooks.openImport = openImport;
    igState.storageSupported = storage.isSupported();
    const checkbox = $("ig-setting-persistent-storage");
    if (checkbox) {
        checkbox.checked = igState.settings.persistentStorage;
        checkbox.disabled = !igState.storageSupported;
    }
    $("ig-storage-unsupported")?.toggleAttribute("hidden", igState.storageSupported);

    if (!igState.storageSupported || (!igState.settings.persistentStorage && readStored(USED_KEY) !== "1")) return;
    try {
        igState.storedImports = importsOfKind(await storage.reconcileImports(), "instagram");
    } catch (error) {
        console.warn("Instagram stored imports could not be read:", error);
        showToast(t("Los chats de Instagram guardados no se pudieron leer ahora mismo"), "warn");
        return;
    }
    renderInstagramStoredImports();
    if (!igState.settings.persistentStorage) return;

    const lastId = readStored(LAST_KEY);
    const record = igState.storedImports.find((item) => item.id === lastId);
    if (record) await openInstagramStoredImport(record);
}

export function renderInstagramStoredImports() {
    const list = $("ig-storage-list");
    if (!list) return;
    list.innerHTML = igState.storedImports.length
        ? igState.storedImports.map((record) => {
            const title = record.chatTitle || record.fileName || t("Exportación de Instagram");
            const meta = t("{count} mensajes · {size}", {
                count: (record.messageCount || 0).toLocaleString(getLocale()),
                size: formatBytes(record.size)
            });
            return `<div class="storage-item">
                <div class="storage-item-info"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></div>
                <button type="button" class="chat-item" data-ig-stored-open="${escapeAttribute(record.id)}">${escapeHtml(t("Abrir"))}</button>
                <button type="button" class="stored-delete" data-ig-stored-delete="${escapeAttribute(record.id)}" aria-label="${escapeAttribute(t("Eliminar {name}", { name: title }))}"><i class="ph ph-trash"></i></button>
            </div>`;
        }).join("")
        : `<p class="storage-note">${escapeHtml(t("Las exportaciones de Instagram guardadas aparecerán aquí."))}</p>`;
    const manage = $("ig-storage-manage");
    if (manage) manage.hidden = !igState.storedImports.length;
}

export async function persistInstagramImport(file, thread) {
    if (!igState.settings.persistentStorage || !igState.storageSupported || !file) return;
    const threadDetails = {
        thread,
        chatTitle: igState.chatTitle,
        messageCount: igState.messageOnlyCount,
        ownerName: igState.myName
    };
    const duplicate = storage.findDuplicate(igState.storedImports, file);
    if (duplicate) {
        await updateStoredThread(duplicate, thread);
        return;
    }
    if (copyJob) {
        if (copyingFile === file) pendingThread = threadDetails;
        else showToast(t("Todavía se está guardando otra exportación. Inténtalo de nuevo cuando termine."), "warn");
        return;
    }

    try {
        await storage.requestPersistence();
        const estimate = await storage.estimateStorage();
        if (estimate && estimate.available < storage.requiredSpace(file.size)) {
            showToast(t("No hay espacio suficiente en el dispositivo para guardar esta exportación"), "warn");
            return;
        }
        const id = storage.generateId();
        setStorageStatus(t("Guardando esta exportación en tu dispositivo…"));
        copyingFile = file;
        copyJob = storage.copyFileToStorage(file, id, {
            onProgress(copied, total) { setStorageStatus(t("Guardando… {percent}%", { percent: Math.floor((copied / Math.max(1, total)) * 100) })); }
        });
        const storedName = await copyJob.promise;
        const savedDetails = pendingThread || threadDetails;
        const record = {
            id,
            kind: "instagram",
            fileName: file.name,
            storedName,
            size: file.size,
            lastModified: file.lastModified,
            chatTitle: savedDetails.chatTitle || "",
            messageCount: savedDetails.messageCount,
            ownerName: savedDetails.ownerName,
            threadFolder: savedDetails.thread?.folder || "",
            createdAt: Date.now(),
            lastOpenedAt: Date.now()
        };
        await storage.putImport(record);
        igState.storedImports = storage.sortByRecency([...igState.storedImports, record]);
        igState.activeImportId = id;
        writeStored(USED_KEY, "1");
        writeStored(LAST_KEY, id);
        renderInstagramStoredImports();
        showToast(t("Exportación de Instagram guardada en este dispositivo"));
    } catch (error) {
        if (error?.name !== "AbortError") {
            console.warn("Instagram export could not be saved:", error);
            showToast(t("No se pudo guardar esta exportación de Instagram"), "warn");
        }
    } finally {
        copyJob = null;
        copyingFile = null;
        pendingThread = null;
        setStorageStatus("");
    }
}

async function updateStoredThread(record, thread) {
    const updated = { ...record, chatTitle: igState.chatTitle, messageCount: igState.messageOnlyCount, threadFolder: thread?.folder || "", ownerName: igState.myName, lastOpenedAt: Date.now() };
    await storage.putImport(updated);
    igState.storedImports = storage.sortByRecency(igState.storedImports.map((item) => item.id === record.id ? updated : item));
    igState.activeImportId = record.id;
    writeStored(LAST_KEY, record.id);
    renderInstagramStoredImports();
}

export async function markInstagramImportOpened(thread) {
    const record = igState.storedImports.find((item) => item.id === igState.activeImportId);
    if (!record) return;
    await updateStoredThread(record, thread);
}

async function openInstagramStoredImport(record) {
    try {
        const file = await storage.getImportFile(record);
        igState.restoreImportId = record.id;
        igState.restoreThreadFolder = record.threadFolder || "";
        await hooks.openImport?.(file, record);
    } catch (error) {
        if (storage.isUnrecoverable(error)) {
            await deleteInstagramImport(record.id);
            showToast(t("Esa exportación guardada ya no está disponible"), "warn");
        } else {
            showToast(t("No se pudo abrir esta exportación de Instagram guardada"), "error");
        }
    }
}

export async function handleInstagramStorageClick(event) {
    const open = event.target.closest("[data-ig-stored-open]");
    if (open) {
        const record = igState.storedImports.find((item) => item.id === open.dataset.igStoredOpen);
        if (record) await openInstagramStoredImport(record);
        return;
    }
    const remove = event.target.closest("[data-ig-stored-delete]");
    if (remove) await deleteInstagramImport(remove.dataset.igStoredDelete);
}

export async function deleteInstagramImport(id) {
    const record = igState.storedImports.find((item) => item.id === id);
    if (!record) return;
    if (!window.confirm(t("¿Eliminar la exportación guardada “{name}” de este dispositivo?", { name: record.chatTitle || record.fileName }))) return;
    await storage.deleteImport(record);
    igState.storedImports = igState.storedImports.filter((item) => item.id !== id);
    if (readStored(LAST_KEY) === id) removeStored(LAST_KEY);
    if (igState.activeImportId === id) igState.activeImportId = "";
    if (!igState.storedImports.length) removeStored(USED_KEY);
    renderInstagramStoredImports();
}

export async function deleteAllInstagramImports() {
    if (!igState.storedImports.length) return;
    if (!window.confirm(igState.storedImports.length === 1
        ? t("¿Eliminar la exportación de Instagram guardada de este dispositivo?")
        : t("¿Eliminar las {count} exportaciones de Instagram guardadas de este dispositivo?", { count: igState.storedImports.length }))) return;
    try {
        await storage.deleteImportsByKind("instagram");
    } catch (error) {
        console.warn("Saved Instagram exports could not be deleted:", error);
        showToast(t("No se pudieron eliminar las exportaciones de Instagram guardadas"), "error");
        return;
    }
    igState.storedImports = [];
    igState.activeImportId = "";
    removeStored(LAST_KEY);
    removeStored(USED_KEY);
    renderInstagramStoredImports();
    showToast(t("Exportaciones de Instagram guardadas eliminadas"));
}

export function handleInstagramStorageSetting(event) {
    igState.settings = writeInstagramSettings({ ...igState.settings, persistentStorage: event.target.checked });
    if (event.target.checked) {
        writeStored(USED_KEY, "1");
        showToast(t("Las nuevas exportaciones de Instagram se pueden guardar en este dispositivo"));
    } else {
        cancelInstagramCopy();
        showToast(t("El almacenamiento está desactivado. Las exportaciones guardadas siguen hasta que las elimines."));
    }
}

export function cancelInstagramCopy() {
    copyJob?.cancel();
}

function setStorageStatus(message) {
    const el = $("ig-storage-status");
    if (el) el.textContent = message;
    const cancel = $("ig-storage-cancel");
    if (cancel) cancel.hidden = !message;
}

function formatBytes(bytes = 0) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
