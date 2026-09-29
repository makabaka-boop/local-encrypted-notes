import { describe, expect, it } from "vitest";
import { InvalidPasswordError, NoVaultError } from "../src/errors.js";
import { newVault } from "./helpers.js";

describe("解锁流程", () => {
  it("未创建时解锁抛 NoVaultError", async () => {
    const h = newVault();
    expect(await h.vault.exists()).toBe(false);
    await expect(h.vault.unlock("whatever")).rejects.toBeInstanceOf(NoVaultError);
  });

  it("首次 setup 后可用同一口令解锁并读出明文", async () => {
    const h = newVault();
    await h.vault.setup("correct horse battery staple");
    const created = await h.vault.create("秘密内容：明日 10 点");

    // 用全新 Vault（同一数据库）模拟重新打开页面
    const reopened = h.reopen();
    await reopened.unlock("correct horse battery staple");
    const got = await reopened.get(created.id);
    expect(got.content).toBe("秘密内容：明日 10 点");
    expect(got.rev).toBe(1);
  });

  it("错误口令抛 InvalidPasswordError 且旧数据完好，可再次用正确口令解锁", async () => {
    const h = newVault();
    await h.vault.setup("s3cret-passphrase");
    const note = await h.vault.create("alpha");

    const reopened = h.reopen();
    await expect(reopened.unlock("wrong-passphrase")).rejects.toBeInstanceOf(
      InvalidPasswordError
    );
    // 旧数据未被改变：正确口令照常解锁
    await reopened.unlock("s3cret-passphrase");
    const got = await reopened.get(note.id);
    expect(got.content).toBe("alpha");
  });

  it("锁定后不能再读写，解锁后恢复", async () => {
    const h = newVault();
    await h.vault.setup("pw");
    const note = await h.vault.create("locked?");
    h.vault.lock();
    expect(h.vault.isLocked()).toBe(true);
    await expect(h.vault.get(note.id)).rejects.toThrow(/锁定/);
    await expect(h.vault.create("x")).rejects.toThrow(/锁定/);

    await h.vault.unlock("pw");
    expect((await h.vault.get(note.id)).content).toBe("locked?");
  });

  it("明文与口令不会出现在持久化字节中", async () => {
    const h = newVault();
    const secret = "这是一句不会落盘的明文XYZ";
    await h.vault.setup("口令短语ABC");
    const note = await h.vault.create(secret);

    const reopened = h.reopen();
    const metaBytes = await (reopened as unknown as { gateway: { getMeta(): Promise<Uint8Array> } })
      .gateway.getMeta();
    const noteBytes = await (reopened as unknown as { gateway: { getNote(id: string): Promise<Uint8Array> } })
      .gateway.getNote(note.id);

    const enc = new TextEncoder();
    expect(metaBytes).toBeTruthy();
    expect(noteBytes).toBeTruthy();
    expect(includesBytes(metaBytes!, enc.encode(secret))).toBe(false);
    expect(includesBytes(noteBytes!, enc.encode(secret))).toBe(false);
    expect(includesBytes(metaBytes!, enc.encode("口令短语ABC"))).toBe(false);
    expect(includesBytes(noteBytes!, enc.encode("口令短语ABC"))).toBe(false);
  });
});

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
