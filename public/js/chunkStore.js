/**
 * CloudDrop - IndexedDB 分块存储
 * 接收大文件时把分块写入 IndexedDB 而非驻留内存，避免手机 OOM。
 * 不支持 IndexedDB 的环境（如隐私模式异常）自动回退到内存数组。
 *
 * 注意：本库是同源共享的，多个标签页会看到同一份数据。因此任何清理都
 * 必须是「按 fileId 精确删」或「只回收过期残留」，绝不能整库 clear——
 * 否则开新标签页/重连会把别的标签页正在接收的分块一起抹掉。
 */

const DB_NAME = 'clouddrop-chunks';
const DB_VERSION = 1;
const STORE = 'chunks';

/**
 * 分块保留时长：超过即视为上次会话中断留下的残留，可被启动清理回收。
 * 取 6 小时是为了高于单文件上限 10GB 走中继（约 1MB/s）的最长耗时，
 * 保证不会误删任何仍在进行的传输（活跃分块的时间戳总是最新的）。
 */
const CHUNK_TTL_MS = 6 * 60 * 60 * 1000;

let dbPromise = null;
let prunePromise = null; // 每次页面加载只做一次残留回收

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE); // key: `${fileId}:${paddedIndex}`
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    } catch (e) {
      reject(e);
    }
  });
  return dbPromise;
}

/** 固定宽度索引，保证字符串排序与数字顺序一致 */
function chunkKey(fileId, index) {
  return `${fileId}:${String(index).padStart(10, '0')}`;
}

/** 取出分块数据，兼容升级前直接存 Uint8Array 的旧格式 */
function unwrap(value) {
  return value && value.d instanceof Uint8Array ? value.d : value;
}

export const chunkStore = {
  /** 检测 IndexedDB 是否可用 */
  async isAvailable() {
    try {
      await openDb();
      return true;
    } catch (e) {
      console.warn('[ChunkStore] IndexedDB unavailable, falling back to memory:', e.message);
      return false;
    }
  },

  /** 写入一个分块（附带时间戳，供过期回收判断） */
  async putChunk(fileId, index, data) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ d: data, t: Date.now() }, chunkKey(fileId, index));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('chunk put failed'));
      } catch (e) {
        reject(e);
      }
    });
  },

  /** 按序读取全部已存分块（单事务，range getAll） */
  async getAllChunks(fileId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const range = IDBKeyRange.bound(`${fileId}:`, `${fileId}:\uffff`);
        const req = tx.objectStore(STORE).getAll(range);
        req.onsuccess = () => resolve((req.result || []).map(unwrap));
        req.onerror = () => reject(req.error || new Error('chunk getAll failed'));
      } catch (e) {
        reject(e);
      }
    });
  },

  /** 删除某文件的全部分块（完成/取消/失败后清理，fire-and-forget 安全） */
  async deleteFile(fileId) {
    try {
      const db = await openDb();
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          const range = IDBKeyRange.bound(`${fileId}:`, `${fileId}:\uffff`);
          tx.objectStore(STORE).delete(range);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve(); // 清理失败不影响主流程
        } catch (e) {
          resolve();
        }
      });
    } catch (e) {
      // 忽略：数据库不可用
    }
  },

  /**
   * 回收过期残留分块（上次会话被中断、再也没人来收的）。
   * 只删时间戳早于 CHUNK_TTL_MS 的条目，因此不会碰到任何活跃传输；
   * 无时间戳的旧格式条目按残留处理。每次页面加载只实际执行一次。
   */
  async pruneStale() {
    if (prunePromise) return prunePromise;

    prunePromise = (async () => {
      try {
        const db = await openDb();
        const cutoff = Date.now() - CHUNK_TTL_MS;

        await new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).openCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor) return;
              const value = cursor.value;
              if (!value || typeof value.t !== 'number' || value.t < cutoff) {
                cursor.delete();
              }
              cursor.continue();
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          } catch (e) {
            resolve();
          }
        });
      } catch (e) {
        // 忽略：数据库不可用
      }
    })();

    return prunePromise;
  }
};
