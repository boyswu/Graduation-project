// Only garment references are stored here. Camera and generated frames stay in memory.
export const WARDROBE_LIMIT = 20;
const BYTE_LIMIT = 32 * 1024 * 1024;

export function readSetting(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

export function writeSetting(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function readPreferences() {
  let saved;
  try { saved = JSON.parse(readSetting("vton-studio-preferences", "{}")); } catch { saved = {}; }
  return {
    saveUploads: saved?.saveUploads !== false,
    rememberSelection: saved?.rememberSelection !== false,
    cameraId: typeof saved?.cameraId === "string" ? saved.cameraId : "",
    favorites: Array.isArray(saved?.favorites) ? saved.favorites.filter(id => typeof id === "string").slice(0, 100) : [],
  };
}

export class WardrobeStore {
  open() {
    if (this.connection) return this.connection;
    this.connection = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error("浏览器未开放本机衣柜存储")); return; }
      let settled = false;
      const timer = setTimeout(() => { settled = true; reject(new Error("本机衣柜存储暂不可用")); }, 2500);
      let request;
      try { request = indexedDB.open("yijian-wardrobe", 1); }
      catch (error) { clearTimeout(timer); reject(error); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("garments")) request.result.createObjectStore("garments", { keyPath: "id" });
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const database = request.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => { database.close(); this.connection = null; };
        resolve(database);
      };
      request.onerror = () => { clearTimeout(timer); reject(new Error("无法打开本机衣柜，请检查浏览器存储权限")); };
    }).catch(error => { this.connection = null; throw error; });
    return this.connection;
  }

  async list() {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("garments", "readonly");
      const request = tx.objectStore("garments").getAll();
      tx.oncomplete = () => resolve(request.result.filter(row => /^uploaded-[a-z0-9-]+$/.test(row.id) && row.blob instanceof Blob && typeof row.name === "string"));
      tx.onabort = tx.onerror = () => reject(new Error("读取本机衣柜失败"));
    });
  }

  async put(record) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("garments", "readwrite");
      const store = tx.objectStore("garments");
      let reason = "保存失败，可能是本机存储空间不足";
      const request = store.getAll();
      request.onsuccess = () => {
        const others = request.result.filter(item => item.id !== record.id);
        if (others.length >= WARDROBE_LIMIT) { reason = `本机衣柜最多保存 ${WARDROBE_LIMIT} 件，请先移除不需要的衣服`; tx.abort(); return; }
        if (others.reduce((sum, item) => sum + (item.blob?.size || 0), 0) + record.blob.size > BYTE_LIMIT) {
          reason = "本机衣柜已达到 32 MB，请先移除不需要的衣服"; tx.abort(); return;
        }
        store.put({ id: record.id, name: record.name.slice(0, 40), blob: record.blob, createdAt: record.createdAt });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error(reason));
    });
  }

  async remove(id) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("garments", "readwrite");
      tx.objectStore("garments").delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error("移除失败，请重试；原衣服仍保留"));
    });
  }
}
