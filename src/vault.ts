/**
 * Vault：加密便笺工作台的领域核心。
 *
 * 安全边界：
 * - 明文便笺内容与用户口令只存在于内存，绝不写入 IndexedDB / localStorage。
 * - 每条便笺使用独立随机 IV + AES-GCM 加密，AAD 绑定便笺 id。
 * - 数据密钥随机生成，由“口令经 PBKDF2 派生的 KEK”封装后存储。
 * - 改口令只重新封装同一个数据密钥（写 meta 一条记录），不重写便笺。
 * - 任何存储失败先于持久化发生或随事务回滚，旧数据保持不变。
 * - 修订号（rev）乐观锁：后写的旧 rev 被拒绝，调用方提示重新载入。
 */

import { BroadcastVaultBus, VaultBus, VaultEventListener } from "./bus.js";
import {
  IV_LENGTH,
  PBKDF2_ITERATIONS,
  SALT_LENGTH,
  decryptBytes,
  deriveKeyFromPassword,
  encryptBytes,
  generateDataKey,
  noteAad,
  randomBytes,
  randomId,
  unwrapDataKey,
  wrapDataKey
} from "./crypto.js";
import {
  IndexedDBNotesGateway,
  NOTE_LIMIT,
  NotesGateway
} from "./db.js";
import {
  StoredNote,
  WrappedKeyMeta,
  decodeMeta,
  decodeNote,
  encodeMeta,
  encodeNote
} from "./encoding.js";
import {
  CapacityError,
  InvalidPasswordError,
  NoVaultError,
  RevisionConflictError,
  StorageError
} from "./errors.js";

/** 解密后的便笺（仅内存态）。 */
export interface Note {
  id: string;
  content: string;
  rev: number;
  updatedAt: number;
}

/** 列表项不解密正文，只用于渲染。 */
export interface NoteListItem {
  id: string;
  rev: number;
  updatedAt: number;
}

export interface VaultOptions {
  gateway?: NotesGateway;
  bus?: VaultBus;
}

export class Vault {
  private dataKey: CryptoKey | null = null;
  private locked = true;
  private readonly gateway: NotesGateway;
  private readonly bus: VaultBus;

  constructor(opts: VaultOptions = {}) {
    this.gateway = opts.gateway ?? new IndexedDBNotesGateway();
    this.bus = opts.bus ?? new BroadcastVaultBus();
  }

  /** 是否已创建（存在密钥封装记录）。 */
  async exists(): Promise<boolean> {
    return (await this.gateway.getMeta()) !== undefined;
  }

  isLocked(): boolean {
    return this.locked;
  }

  /**
   * 首次创建：生成随机数据密钥 + 随机盐，用口令派生 KEK 封装后落盘。
   * 若已有记录则拒绝，避免覆盖既有数据。
   */
  async setup(password: string): Promise<void> {
    assertPassword(password);
    if (await this.exists()) {
      throw new StorageError("已存在数据，不能重复创建");
    }
    const salt = randomBytes(SALT_LENGTH);
    const dataKey = await generateDataKey();
    const kek = await deriveKeyFromPassword(password, salt);
    const { wrapped, iv } = await wrapDataKey(kek, dataKey);
    // 先在内存完成全部加密，最后一次写入；失败则什么都没存
    const meta: WrappedKeyMeta = {
      v: 1,
      salt,
      wrappedKey: wrapped,
      keyIv: iv,
      iterations: PBKDF2_ITERATIONS,
      keyId: randomId(),
      createdAt: Date.now()
    };
    await this.gateway.putMeta(encodeMeta(meta));
    this.dataKey = dataKey;
    this.locked = false;
  }

  /** 用口令解封数据密钥；错误口令抛 InvalidPasswordError 且不改变任何数据。 */
  async unlock(password: string): Promise<void> {
    assertPassword(password);
    const raw = await this.gateway.getMeta();
    if (!raw) throw new NoVaultError();
    const meta = decodeMeta(raw);
    const kek = await deriveKeyFromPassword(password, meta.salt);
    // 错误口令在这里抛 InvalidPasswordError（GCM 认证失败）
    const dataKey = await unwrapDataKey(kek, meta.wrappedKey, meta.keyIv);
    this.dataKey = dataKey;
    this.locked = false;
  }

  /**
   * 锁定：立即撤去内存中的数据密钥与明文。
   * 同时通知其它标签页也锁定。
   */
  lock(): void {
    this.dataKey = null;
    this.locked = true;
    this.bus.post({ type: "locked" });
  }

  /**
   * 修改口令：只用新口令重新封装“同一个数据密钥”，便笺密文一概不动。
   * 流程全部先在内存完成，最后单次 putMeta；putMeta 失败时旧封装保留，
   * 内存密钥也不变，旧口令仍然可解锁。
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    assertPassword(newPassword);
    const active = this.requireUnlocked();
    const raw = await this.gateway.getMeta();
    if (!raw) throw new NoVaultError();
    const meta = decodeMeta(raw);

    // 1) 验证旧口令（派生 + 试解封），错误则中止，绝不触碰存储
    const oldKek = await deriveKeyFromPassword(oldPassword, meta.salt);
    await unwrapDataKey(oldKek, meta.wrappedKey, meta.keyIv); // 失败抛 InvalidPasswordError

    // 2) 新盐 + 新 KEK，重新封装“当前”数据密钥
    const salt = randomBytes(SALT_LENGTH);
    const newKek = await deriveKeyFromPassword(newPassword, salt);
    const { wrapped, iv } = await wrapDataKey(newKek, active);

    // 3) 最后一次原子写入；失败 -> 旧 meta 原样保留
    const nextMeta: WrappedKeyMeta = {
      ...meta,
      salt,
      wrappedKey: wrapped,
      keyIv: iv
    };
    await this.gateway.putMeta(encodeMeta(nextMeta));
  }

  /** 列表：仅读元信息，不解密正文。按更新时间倒序。 */
  async list(): Promise<NoteListItem[]> {
    this.requireUnlocked();
    const rows = await this.gateway.listNotes();
    return rows
      .map((raw) => {
        const n = decodeNote(raw);
        return { id: n.id, rev: n.rev, updatedAt: n.updatedAt };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async count(): Promise<number> {
    this.requireUnlocked();
    return this.gateway.countNotes();
  }

  /** 读取并解密单条便笺；密文被篡改抛 TamperError。 */
  async get(id: string): Promise<Note> {
    const key = this.requireUnlocked();
    const raw = await this.gateway.getNote(id);
    if (!raw) throw new StorageError("便笺不存在");
    const stored = decodeNote(raw);
    const plain = await decryptBytes(key, stored.ciphertext, stored.iv, noteAad(id));
    return {
      id: stored.id,
      content: new TextDecoder().decode(plain),
      rev: stored.rev,
      updatedAt: stored.updatedAt
    };
  }

  /** 新建便笺；超过 100 条抛 CapacityError（计数与写入在同一事务）。 */
  async create(content: string): Promise<Note> {
    const key = this.requireUnlocked();
    const id = randomId();
    const iv = randomBytes(IV_LENGTH);
    const now = Date.now();
    const ciphertext = await encryptBytes(
      key,
      new TextEncoder().encode(content),
      iv,
      noteAad(id)
    );
    const rev = 1;
    const stored: StoredNote = { id, ciphertext, iv, rev, updatedAt: now };
    const payload = encodeNote(stored);
    try {
      await this.gateway.insertNote(id, payload);
    } catch (e) {
      throw mapWriteError(e);
    }
    const note: Note = { id, content, rev, updatedAt: now };
    this.bus.post({ type: "note-upserted", id, rev });
    return note;
  }

  /**
   * 更新便笺（乐观锁）。
   * @param expectedRev 调用方持有的修订号；与存储当前值不同则拒绝写入。
   */
  async update(id: string, content: string, expectedRev: number): Promise<Note> {
    const key = this.requireUnlocked();
    const raw = await this.gateway.getNote(id);
    if (!raw) throw new StorageError("便笺不存在");
    const current = decodeNote(raw);
    if (current.rev !== expectedRev) {
      throw new RevisionConflictError(current.rev);
    }

    const iv = randomBytes(IV_LENGTH);
    const now = Date.now();
    const ciphertext = await encryptBytes(
      key,
      new TextEncoder().encode(content),
      iv,
      noteAad(id)
    );
    const rev = current.rev + 1;
    const stored: StoredNote = { id, ciphertext, iv, rev, updatedAt: now };
    // 同事务内“校验 rev + 写入”，后写者事务会被中止
    await this.gateway.replaceNoteIfRev(id, expectedRev, encodeNote(stored)).catch((e) => {
      throw mapWriteError(e);
    });
    const note: Note = { id, content, rev, updatedAt: now };
    this.bus.post({ type: "note-upserted", id, rev });
    return note;
  }

  /** 删除同样带修订号，防止删掉别人刚改过的版本。 */
  async delete(id: string, expectedRev: number): Promise<void> {
    this.requireUnlocked();
    await this.gateway.deleteNoteIfRev(id, expectedRev).catch((e) => {
      throw mapWriteError(e);
    });
    this.bus.post({ type: "note-deleted", id });
  }

  subscribe(fn: VaultEventListener): () => void {
    return this.bus.subscribe(fn);
  }

  async dispose(): Promise<void> {
    this.lock();
    this.bus.close();
    await this.gateway.close();
  }

  private requireUnlocked(): CryptoKey {
    if (this.locked || !this.dataKey) {
      throw new StorageError("工作台已锁定");
    }
    return this.dataKey;
  }
}

function assertPassword(password: string): void {
  if (typeof password !== "string" || password.length === 0) {
    throw new InvalidPasswordError();
  }
}

function mapWriteError(e: unknown): Error {
  if (e instanceof RevisionConflictError) return e;
  if (e instanceof Error && e.name === "RevisionConflictError") {
    const expected = (e as unknown as { expected?: number }).expected;
    return new RevisionConflictError(typeof expected === "number" ? expected : 0);
  }
  if (e instanceof Error && e.name === "CapacityError") {
    return new CapacityError(NOTE_LIMIT);
  }
  if (e instanceof Error) return e;
  return new StorageError("写入失败", e);
}
