import { describe, expect, it } from "vitest";
import { BroadcastVaultBus } from "../src/bus.js";
import { InvalidPasswordError } from "../src/errors.js";
import { Vault } from "../src/vault.js";
import { FailingGateway, newVault } from "./helpers.js";

describe("修改口令", () => {
  it("成功改密后：新口令可解锁、旧口令失效、便笺无需重写即可读", async () => {
    const h = newVault();
    await h.vault.setup("old-pw");
    const n1 = await h.vault.create("内容一");
    const n2 = await h.vault.create("内容二");

    // 记录改密前的密文字节，之后应完全不变
    const before1 = await getRawNote(h, n1.id);
    const before2 = await getRawNote(h, n2.id);

    await h.vault.changePassword("old-pw", "new-pw");

    const after1 = await getRawNote(h, n1.id);
    const after2 = await getRawNote(h, n2.id);
    expect(equalBytes(after1!, before1!)).toBe(true);
    expect(equalBytes(after2!, before2!)).toBe(true);

    const reopened = h.reopen();
    await expect(reopened.unlock("old-pw")).rejects.toBeInstanceOf(InvalidPasswordError);
    await reopened.unlock("new-pw");
    expect((await reopened.get(n1.id)).content).toBe("内容一");
    expect((await reopened.get(n2.id)).content).toBe("内容二");
  });

  it("旧口令错误时中止，不写存储，新口令不生效", async () => {
    const h = newVault();
    await h.vault.setup("real-old");
    const note = await h.vault.create("stay");

    await expect(h.vault.changePassword("not-the-old", "new-pw")).rejects.toBeInstanceOf(
      InvalidPasswordError
    );

    const reopened = h.reopen();
    await expect(reopened.unlock("new-pw")).rejects.toBeInstanceOf(InvalidPasswordError);
    await reopened.unlock("real-old");
    expect((await reopened.get(note.id)).content).toBe("stay");
  });

  it("改密写入（putMeta）失败时中断：旧口令仍可解锁，便笺不变", async () => {
    const h = newVault();
    await h.vault.setup("old-pw");
    const note = await h.vault.create("persist-me");

    const failing = new FailingGateway(extractGateway(h));
    failing.fail("putMeta", 1, Object.assign(new Error("模拟配额不足 / 事务中止"), {
      name: "QuotaExceededError"
    }));
    const broken = new Vault({
      gateway: failing,
      bus: new BroadcastVaultBus(`chan-fail-${h.name}`)
    });
    await broken.unlock("old-pw");

    await expect(broken.changePassword("old-pw", "wanted-new")).rejects.toThrow();

    // 旧封装完好：全新会话仍只能用旧口令解锁
    const reopened = h.reopen();
    await expect(reopened.unlock("wanted-new")).rejects.toBeInstanceOf(InvalidPasswordError);
    await reopened.unlock("old-pw");
    expect((await reopened.get(note.id)).content).toBe("persist-me");
  });

  it("改密是重封装而非重新加密：100 条便笺场景下其密文全部字节不变", async () => {
    const h = newVault();
    await h.vault.setup("pw");
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push((await h.vault.create(`note ${i}`)).id);
    }
    const befores = await Promise.all(ids.map((id) => getRawNote(h, id)));

    await h.vault.changePassword("pw", "pw-rotated");

    const afters = await Promise.all(ids.map((id) => getRawNote(h, id)));
    afters.forEach((after, i) => expect(equalBytes(after!, befores[i]!)).toBe(true));
  });
});

// ---- 私有字段访问辅助 ----
function extractGateway(h: ReturnType<typeof newVault>) {
  return (h.vault as unknown as { gateway: import("../src/db.js").NotesGateway }).gateway;
}

async function getRawNote(h: ReturnType<typeof newVault>, id: string): Promise<Uint8Array | undefined> {
  const gw = (h.vault as unknown as { gateway: import("../src/db.js").NotesGateway }).gateway;
  return gw.getNote(id);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
