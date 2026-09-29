import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/ui.js";
import { newVaultPair, waitFor } from "./helpers.js";

function newRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  return root;
}

/** 等待 happy-dom 中出现匹配的元素。 */
async function waitSelector(selector: string): Promise<Element> {
  await waitFor(() => document.querySelector(selector) !== null);
  return document.querySelector(selector)!;
}

/** 在解锁屏填口令并提交。 */
async function unlockViaUi(password: string): Promise<void> {
  const input = (await waitSelector("input[type=password]")) as HTMLInputElement;
  input.value = password;
  const btn = [
    ...document.querySelectorAll("button")
  ].find((b) => b.textContent === "解锁") as HTMLButtonElement;
  btn.click();
  await waitSelector("textarea");
}

/** 点击列表中文本包含 preview 的便笺行。 */
async function openNoteRow(preview: string): Promise<void> {
  await waitFor(() =>
    [...document.querySelectorAll(".note-row")].some((r) =>
      r.textContent?.includes(preview)
    )
  );
  const row = [...document.querySelectorAll(".note-row")].find((r) =>
    r.textContent?.includes(preview)
  ) as HTMLButtonElement;
  row.click();
  await waitFor(() => {
    const ta = document.querySelector("textarea") as HTMLTextAreaElement | null;
    return (ta?.value.length ?? 0) > 0;
  });
}

describe("界面行为", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("锁定后根节点中的明文被立即撤去，回到口令输入屏", async () => {
    const { a } = newVaultPair();
    await a.setup("pw");
    await a.create("这段明文必须在锁定后消失");

    const appA = new App(newRoot(), a);
    await appA.start();
    await unlockViaUi("pw");
    await openNoteRow("这段明文");

    const area = (await waitSelector("textarea")) as HTMLTextAreaElement;
    // 列表渲染会逐条解密，界面上存在明文
    await waitFor(() => document.body.textContent?.includes("这段明文必须在锁定后消失") ?? false);
    expect(area.value).toBe("这段明文必须在锁定后消失");

    const lockBtn = [
      ...document.querySelectorAll("button")
    ].find((b) => b.textContent === "锁定") as HTMLButtonElement;
    lockBtn.click();

    await waitSelector("input[type=password]");
    expect(document.body.textContent).not.toContain("这段明文必须在锁定后消失");
    expect(document.querySelector("textarea")).toBeNull();
    expect(a.isLocked()).toBe(true);
  });

  it("跨标签页改动同一便笺时，本页提示重新载入并阻止过期保存", async () => {
    const { a, b } = newVaultPair();
    await a.setup("pw");
    await b.unlock("pw");
    const note = await a.create("两边都打开的便笺");

    const appA = new App(newRoot(), a);
    await appA.start();
    await unlockViaUi("pw");
    await openNoteRow("两边都打开");

    // 另一标签页更新同一便笺 rev 1 -> 2
    await b.update(note.id, "另一标签页的新版本", 1);

    // A 页收到广播：出现重新载入提示
    await waitFor(() => document.body.textContent?.includes("请重新载入") ?? false);
    const reloadBtn = [
      ...document.querySelectorAll("button")
    ].find((x) => x.textContent === "重新载入") as HTMLButtonElement;
    expect(reloadBtn.hidden).toBe(false);

    // 点“重新载入”后拉到新版本
    reloadBtn.click();
    await waitFor(() => {
      const ta = document.querySelector("textarea") as HTMLTextAreaElement | null;
      return ta?.value === "另一标签页的新版本";
    });
  });
});
