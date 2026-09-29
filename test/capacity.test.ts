import { describe, expect, it } from "vitest";
import { BroadcastVaultBus } from "../src/bus.js";
import { CapacityError } from "../src/errors.js";
import { Vault } from "../src/vault.js";
import { FailingGateway, newVault, newVaultPair } from "./helpers.js";

describe("容量限制（最多 100 条）", () => {
  it("可创建恰好 100 条，第 101 条抛 CapacityError 且不留残数据", async () => {
    const h = newVault();
    await h.vault.setup("pw");

    for (let i = 0; i < 100; i++) {
      await h.vault.create(`n${i}`);
    }
    expect(await h.vault.count()).toBe(100);

    await expect(h.vault.create("overflow")).rejects.toBeInstanceOf(CapacityError);
    expect(await h.vault.count()).toBe(100);

    // 失败后仍可正常更新 / 删除
    const list = await h.vault.list();
    const first = list[list.length - 1];
    const note = await h.vault.get(first.id);
    await h.vault.update(first.id, note.content + " 改", note.rev);
    expect(await h.vault.count()).toBe(100);

    await h.vault.delete(first.id, note.rev + 1);
    expect(await h.vault.count()).toBe(99);

    // 腾出位置后又能新建
    await h.vault.create("new after delete");
    expect(await h.vault.count()).toBe(100);
  });

  it("配额错误（写入中途存储失败）同样不产生半截记录", async () => {
    const h = newVault();
    await h.vault.setup("pw");
    for (let i = 0; i < 5; i++) await h.vault.create(`x${i}`);

    const failing = new FailingGateway(
      (h.vault as unknown as { gateway: import("../src/db.js").NotesGateway }).gateway
    );
    failing.fail("insertNote", 1, Object.assign(new Error("磁盘配额已满"), {
      name: "QuotaExceededError"
    }));
    const broken = new Vault({
      gateway: failing,
      bus: new BroadcastVaultBus(`chan-quota-${h.name}`)
    });
    await broken.unlock("pw");
    await expect(broken.create("should not land")).rejects.toThrow();

    expect(await h.vault.count()).toBe(5);
  });

  it("两个标签页并发写满：原子计数使总数绝不超过 100", async () => {
    const { a, b } = newVaultPair();
    await a.setup("pw");
    await b.unlock("pw");

    // 双方各自从空开始交替大量创建；失败是预期，只校验最终总数 <= 100
    const results: PromiseSettledResult<unknown>[] = [];
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 70; i++) {
      jobs.push(a.create(`a${i}`));
      jobs.push(b.create(`b${i}`));
    }
    const settled = await Promise.allSettled(jobs);
    results.push(...settled);

    const countA = await a.count();
    const countB = await b.count();
    expect(countA).toBe(countB);
    expect(countA).toBeLessThanOrEqual(100);
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.length).toBeGreaterThan(0);
  });
});
