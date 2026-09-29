/** 测试辅助：唯一数据库 / 总线通道、故障注入网关、等待异步事件。 */
import { BroadcastVaultBus } from "../src/bus.js";
import { IndexedDBNotesGateway, NotesGateway } from "../src/db.js";
import { Vault } from "../src/vault.js";

let counter = 0;

export interface VaultHandle {
  vault: Vault;
  name: string;
  /** 用同一底层 IndexedDB 再开一个独立会话（模拟刷新 / 另一标签页）。 */
  reopen(channelTag?: string): Vault;
}

function uniqueName(): string {
  counter += 1;
  return `test-${counter}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function makeHandle(name: string): VaultHandle {
  const open = (channel: string) =>
    new Vault({
      gateway: new IndexedDBNotesGateway(name),
      bus: new BroadcastVaultBus(channel)
    });
  const vault = open(`chan-${name}`);
  return {
    vault,
    name,
    reopen(channelTag?: string) {
      return open(channelTag ? `chan-${name}-${channelTag}` : `chan-${name}`);
    }
  };
}

/** 单个独立工作台。 */
export function newVault(): VaultHandle {
  return makeHandle(uniqueName());
}

/**
 * 两个会话共享同一底层数据库与同一广播通道，用于跨标签页测试。
 */
export function newVaultPair(): { a: Vault; b: Vault; name: string } {
  const name = uniqueName();
  const channel = `chan-${name}`;
  const a = new Vault({
    gateway: new IndexedDBNotesGateway(name),
    bus: new BroadcastVaultBus(channel)
  });
  const b = new Vault({
    gateway: new IndexedDBNotesGateway(name),
    bus: new BroadcastVaultBus(channel)
  });
  return { a, b, name };
}

/**
 * 故障注入网关：包装真实网关，可让指定方法在第 n 次调用时抛错，
 * 用于模拟“存储失败 / 配额失败”。
 */
export class FailingGateway implements NotesGateway {
  public failOn: Partial<Record<keyof NotesGateway, { times: number; error: Error }>> = {};
  private calls: Partial<Record<string, number>> = {};

  constructor(private readonly inner: NotesGateway) {}

  fail(method: keyof NotesGateway, times = 1, error?: Error): void {
    this.failOn[method] = {
      times,
      error:
        error ?? Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" })
    };
  }

  private maybeFail(method: keyof NotesGateway): void {
    const rule = this.failOn[method];
    if (!rule) return;
    const n = (this.calls[method] ?? 0) + 1;
    this.calls[method] = n;
    if (n <= rule.times) throw rule.error;
  }

  async getMeta() {
    this.maybeFail("getMeta");
    return this.inner.getMeta();
  }
  async putMeta(p: Uint8Array) {
    this.maybeFail("putMeta");
    return this.inner.putMeta(p);
  }
  async getNote(id: string) {
    this.maybeFail("getNote");
    return this.inner.getNote(id);
  }
  async listNotes() {
    this.maybeFail("listNotes");
    return this.inner.listNotes();
  }
  async countNotes() {
    this.maybeFail("countNotes");
    return this.inner.countNotes();
  }
  async insertNote(id: string, p: Uint8Array) {
    this.maybeFail("insertNote");
    return this.inner.insertNote(id, p);
  }
  async replaceNote(id: string, p: Uint8Array) {
    this.maybeFail("replaceNote");
    return this.inner.replaceNote(id, p);
  }
  async replaceNoteIfRev(id: string, rev: number, p: Uint8Array) {
    this.maybeFail("replaceNoteIfRev");
    return this.inner.replaceNoteIfRev(id, rev, p);
  }
  async deleteNoteIfRev(id: string, rev: number) {
    this.maybeFail("deleteNoteIfRev");
    return this.inner.deleteNoteIfRev(id, rev);
  }
  async deleteNote(id: string) {
    this.maybeFail("deleteNote");
    return this.inner.deleteNote(id);
  }
  async close() {
    return this.inner.close();
  }
}

/** 直接在底层改一条便笺的已编码字节（模拟密文被篡改）。 */
export async function tamperNoteBytes(
  gateway: IndexedDBNotesGateway,
  id: string,
  mutate: (bytes: Uint8Array) => void
): Promise<void> {
  const raw = await gateway.getNote(id);
  if (!raw) throw new Error("便笺不存在，无法篡改");
  const copy = new Uint8Array(raw);
  mutate(copy);
  await gateway.replaceNote(id, copy);
}

/** 轮询等待断言成立（用于跨标签页广播的异步到达）。 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}
