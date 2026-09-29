import { describe, expect, it } from "vitest";
import { RevisionConflictError } from "../src/errors.js";
import { newVaultPair, waitFor } from "./helpers.js";

describe("跨标签页乐观并发（修订号）", () => {
  it("两个标签页依次更新同一便笺：后写的旧 rev 被拒绝，先写不被覆盖", async () => {
    const { a, b } = newVaultPair();
    await a.setup("pw");
    await b.unlock("pw");

    const note = await a.create("原始内容"); // rev=1

    // 两边各自读到 rev=1
    const inA = await a.get(note.id);
    const inB = await b.get(note.id);
    expect(inA.rev).toBe(1);
    expect(inB.rev).toBe(1);

    // A 先写：1 -> 2
    await a.update(note.id, "A 的修改", inA.rev);

    // B 仍持旧 rev=1 写：必须被阻止
    await expect(b.update(note.id, "B 的覆盖", inB.rev)).rejects.toBeInstanceOf(
      RevisionConflictError
    );

    // 存储里是 A 的版本（rev=2），B 没有覆盖
    const fresh = await a.get(note.id);
    expect(fresh.content).toBe("A 的修改");
    expect(fresh.rev).toBe(2);

    // B 重新载入后拿到新 rev，可正常再改
    const reloadedB = await b.get(note.id);
    await b.update(note.id, "B 基于最新版的修改", reloadedB.rev);
    const last = await a.get(note.id);
    expect(last.content).toBe("B 基于最新版的修改");
    expect(last.rev).toBe(3);
  });

  it("删除也受修订号保护：基于旧 rev 的删除被拒绝", async () => {
    const { a, b } = newVaultPair();
    await a.setup("pw");
    await b.unlock("pw");
    const note = await a.create("x");

    const inA = await a.get(note.id);
    const inB = await b.get(note.id);
    await a.update(note.id, "changed", inA.rev); // rev=2

    await expect(b.delete(note.id, inB.rev)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await a.count()).toBe(1);
  });

  it("一个标签页的修改会通过广播通知另一个标签页", async () => {
    const { a, b } = newVaultPair();
    await a.setup("pw");
    await b.unlock("pw");
    const note = await a.create("hello");

    const events: unknown[] = [];
    b.subscribe((e) => events.push(e));

    const updated = await a.update(note.id, "hello v2", 1);

    await waitFor(() =>
      events.some(
        (e) => (e as { type?: string }).type === "note-upserted" &&
          (e as { rev?: number }).rev === 2
      )
    );
    const upsert = events
      .filter(
        (e) =>
          (e as { type?: string }).type === "note-upserted" &&
          (e as { id?: string; rev?: number }).id === note.id
      )
      .at(-1) as { id: string; rev: number };
    expect(upsert.id).toBe(note.id);
    expect(upsert.rev).toBe(updated.rev);
    expect(updated.rev).toBe(2);

    // 删除通知
    const seenDelete = Promise.resolve(
      waitFor(() => events.some((e) => (e as { type?: string }).type === "note-deleted"))
    );
    await a.delete(note.id, updated.rev);
    await seenDelete;
  });

  it("一个标签页锁定后广播 locked，另一标签页可据此立即撤去明文", async () => {
    const { a, b } = newVaultPair();
    await a.setup("pw");
    await b.unlock("pw");
    await a.create("secret");

    const events: unknown[] = [];
    b.subscribe((e) => events.push(e));

    a.lock();
    await waitFor(() => events.some((e) => (e as { type?: string }).type === "locked"));
  });
});
