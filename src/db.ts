/**
 * IndexedDB 网关：负责数据库打开与原始读写。
 * 所有方法不做加密，只处理 { meta, notes } 两个对象仓库。
 *
 * notes 仓库存放每条便笺的密文记录（encodeNote 后的字节），主键为便笺 id；
 * meta 仓库只有一条 id="vault" 的密钥封装记录。
 */

import { StorageError } from "./errors.js";
import { decodeNote } from "./encoding.js";

export const DB_NAME = "secure-notes-workbench";
export const DB_VERSION = 1;
export const STORE_NOTES = "notes";
export const STORE_META = "meta";
export const META_KEY = "vault";
export const NOTE_LIMIT = 100;

function idbFactory(): IDBFactory {
  const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new StorageError("当前环境不支持 IndexedDB");
  return f;
}

export function openDatabase(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = idbFactory().open(name, DB_VERSION);
    } catch (e) {
      reject(new StorageError("无法打开 IndexedDB", e));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        db.createObjectStore(STORE_NOTES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError("打开 IndexedDB 失败", req.error ?? undefined));
    req.onblocked = () => reject(new StorageError("数据库被其它标签页占用，无法升级"));
  });
}

function asPromise<T>(req: IDBRequest<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(wrapErr(label, req.error));
  });
}

function txDone(tx: IDBTransaction, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(wrapErr(label, tx.error));
    tx.onabort = () => reject(wrapErr(label, tx.error));
  });
}

function wrapErr(label: string, e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const name = (e as DOMException | null)?.name;
  if (name === "QuotaExceededError" || name === "ConstraintError") {
    // 保留原始 DOMException 名，调用方据此区分容量 / 配额 / 约束
    return Object.assign(new StorageError(`${label}: ${name}`, e), { name }) as StorageError;
  }
  return new StorageError(`${label} 失败`, e);
}

export interface NotesGateway {
  getMeta(): Promise<Uint8Array | undefined>;
  putMeta(payload: Uint8Array): Promise<void>;
  getNote(id: string): Promise<Uint8Array | undefined>;
  listNotes(): Promise<Uint8Array[]>;
  countNotes(): Promise<number>;
  /** 插入新便笺；条数达上限或 key 已存在则事务中止（name=CapacityError/ConstraintError）。 */
  insertNote(id: string, payload: Uint8Array): Promise<void>;
  replaceNote(id: string, payload: Uint8Array): Promise<void>;
  /**
   * 条件覆盖：在同一个读写事务内读取当前记录，仅当修订号等于 expectedRev
   * 时写入，否则中止事务并抛 RevisionConflictError（name 保留）。
   * 这样两个标签页的并发更新不可能交叉覆盖。
   */
  replaceNoteIfRev(id: string, expectedRev: number, payload: Uint8Array): Promise<void>;
  /** 条件删除：修订号不符则中止。 */
  deleteNoteIfRev(id: string, expectedRev: number): Promise<void>;
  deleteNote(id: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * 默认 IndexedDB 网关。
 * insertNote 在同一读写事务内先 count 再 add，保证“计数 + 写入”原子：
 * 两个标签页不可能同时把第 101 条写进去。
 */
export class IndexedDBNotesGateway implements NotesGateway {
  private dbPromise: Promise<IDBDatabase>;

  constructor(dbName: string = DB_NAME) {
    this.dbPromise = openDatabase(dbName);
  }

  private db(): Promise<IDBDatabase> {
    return this.dbPromise;
  }

  async getMeta(): Promise<Uint8Array | undefined> {
    const db = await this.db();
    const v = await asPromise(
      db.transaction(STORE_META, "readonly").objectStore(STORE_META).get(META_KEY),
      "读取密钥记录"
    );
    return normalize(v);
  }

  async putMeta(payload: Uint8Array): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put(payload, META_KEY);
    await txDone(tx, "保存密钥记录");
  }

  async getNote(id: string): Promise<Uint8Array | undefined> {
    const db = await this.db();
    const v = await asPromise(
      db.transaction(STORE_NOTES, "readonly").objectStore(STORE_NOTES).get(id),
      "读取便笺"
    );
    return normalize(v);
  }

  async listNotes(): Promise<Uint8Array[]> {
    const db = await this.db();
    const tx = db.transaction(STORE_NOTES, "readonly");
    const rows = await asPromise(tx.objectStore(STORE_NOTES).getAll(), "列出便笺");
    await txDone(tx, "列出便笺");
    return rows.map((r) => normalize(r)).filter((r): r is Uint8Array => !!r);
  }

  async countNotes(): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(STORE_NOTES, "readonly");
    const n = await asPromise(tx.objectStore(STORE_NOTES).count(), "计数便笺");
    await txDone(tx, "计数便笺");
    return n;
  }

  async insertNote(id: string, payload: Uint8Array): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_NOTES, "readwrite");
    const store = tx.objectStore(STORE_NOTES);
    const count = await asPromise(store.count(), "计数便笺");
    if (count >= NOTE_LIMIT) {
      tx.abort();
      throw Object.assign(new StorageError(`便笺数量已达上限（${NOTE_LIMIT} 条）`), {
        name: "CapacityError"
      });
    }
    const addReq = store.add(payload, id);
    try {
      await asPromise(addReq, "新增便笺");
    } catch (e) {
      tx.abort();
      // key 冲突（理论上 id 随机不会发生）按约束错误处理
      throw Object.assign(new StorageError("新增便笺失败", e), { name: "ConstraintError" });
    }
    await txDone(tx, "新增便笺");
  }

  async replaceNote(id: string, payload: Uint8Array): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_NOTES, "readwrite");
    tx.objectStore(STORE_NOTES).put(payload, id);
    await txDone(tx, "保存便笺");
  }

  async replaceNoteIfRev(id: string, expectedRev: number, payload: Uint8Array): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_NOTES, "readwrite");
    const store = tx.objectStore(STORE_NOTES);
    const existing = await asPromise(store.get(id), "读取便笺");
    const raw = normalize(existing);
    if (!raw) {
      tx.abort();
      throw new StorageError("便笺不存在");
    }
    const current = decodeNote(raw);
    if (current.rev !== expectedRev) {
      tx.abort();
      throw Object.assign(new StorageError(`修订号冲突：当前为 ${current.rev}`), {
        name: "RevisionConflictError",
        expected: current.rev
      });
    }
    store.put(payload, id);
    await txDone(tx, "保存便笺");
  }

  async deleteNoteIfRev(id: string, expectedRev: number): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_NOTES, "readwrite");
    const store = tx.objectStore(STORE_NOTES);
    const existing = await asPromise(store.get(id), "读取便笺");
    const raw = normalize(existing);
    if (!raw) {
      tx.abort();
      throw new StorageError("便笺不存在");
    }
    const current = decodeNote(raw);
    if (current.rev !== expectedRev) {
      tx.abort();
      throw Object.assign(new StorageError(`修订号冲突：当前为 ${current.rev}`), {
        name: "RevisionConflictError",
        expected: current.rev
      });
    }
    store.delete(id);
    await txDone(tx, "删除便笺");
  }

  async deleteNote(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_NOTES, "readwrite");
    tx.objectStore(STORE_NOTES).delete(id);
    await txDone(tx, "删除便笺");
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
  }
}

function normalize(v: unknown): Uint8Array | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new StorageError("IndexedDB 返回了非二进制记录");
}
