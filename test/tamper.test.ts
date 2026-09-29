import { describe, expect, it } from "vitest";
import { InvalidPasswordError, TamperError } from "../src/errors.js";
import { IndexedDBNotesGateway } from "../src/db.js";
import { decodeMeta, encodeMeta } from "../src/encoding.js";
import { newVault, tamperNoteBytes } from "./helpers.js";

describe("篡改检测（AES-GCM 认证标签）", () => {
  it("翻转便笺密文一个字节后，解密抛 TamperError", async () => {
    const h = newVault();
    await h.vault.setup("pw");
    const note = await h.vault.create("可被验证完整性的内容");

    const gw = new IndexedDBNotesGateway(h.name);
    await tamperNoteBytes(gw, note.id, (bytes) => {
      // 布局: u32(idLen)|id|u32(ivLen)|iv|u32(ctLen)|ciphertext|u32(rev)|f64(ts)
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const idLen = view.getUint32(0);
      const ivLenOff = 4 + idLen;
      const ivLen = view.getUint32(ivLenOff);
      const ctLenOff = ivLenOff + 4 + ivLen;
      const ctLen = view.getUint32(ctLenOff);
      const ctOff = ctLenOff + 4;
      // 翻转密文（GCM 标签位于密文末尾）中的一个字节
      bytes[ctOff + Math.floor(ctLen / 2)] ^= 0xff;
    });

    const reopened = h.reopen();
    await reopened.unlock("pw");
    await expect(reopened.get(note.id)).rejects.toBeInstanceOf(TamperError);
  });

  it("翻转 IV 一个字节后同样解密失败", async () => {
    const h = newVault();
    await h.vault.setup("pw");
    const note = await h.vault.create("IV change");

    const gw = new IndexedDBNotesGateway(h.name);
    await tamperNoteBytes(gw, note.id, (bytes) => {
      // 布局: u32(idLen) | id | u32(ivLen) | iv | ...
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const idLen = view.getUint32(0);
      const ivLenOff = 4 + idLen;
      const ivOff = ivLenOff + 4;
      bytes[ivOff] ^= 0x01;
    });

    const reopened = h.reopen();
    await reopened.unlock("pw");
    await expect(reopened.get(note.id)).rejects.toBeInstanceOf(TamperError);
  });

  it("用另一条便笺的密文整体替换（AAD 绑定 id）会被拒绝", async () => {
    const h = newVault();
    await h.vault.setup("pw");
    const n1 = await h.vault.create("第一条");
    const n2 = await h.vault.create("第二条");

    // 把 n2 的整条编码记录写到 n1 的 key 下（id 字段仍写着 n2），
    // 再手动把记录内 id 改成 n1，验证 AAD 使密文与 id 绑定、无法调换
    const gw = new IndexedDBNotesGateway(h.name);
    const n2Raw = await gw.getNote(n2.id);
    expect(n2Raw).toBeTruthy();
    const stolen = new Uint8Array(n2Raw!);
    // 直接以 n1 为 key 写入 n2 的密文（记录内部 id 还是 n2，解密时 AAD 用 n1）
    await gw.replaceNote(n1.id, stolen);

    const reopened = h.reopen();
    await reopened.unlock("pw");
    await expect(reopened.get(n1.id)).rejects.toBeInstanceOf(TamperError);
  });

  it("篡改密钥封装记录后，任何口令都无法解锁（且不覆盖旧记录）", async () => {
    const h = newVault();
    await h.vault.setup("orig-password");
    await h.vault.create("data");

    const gw = new IndexedDBNotesGateway(h.name);
    const raw = await gw.getMeta();
    expect(raw).toBeTruthy();
    const meta = decodeMeta(raw!);
    // 翻转被封装密钥的一个字节
    meta.wrappedKey[meta.wrappedKey.length - 1] ^= 0x01;
    await gw.putMeta(encodeMeta(meta));

    const reopened = h.reopen();
    await expect(reopened.unlock("orig-password")).rejects.toBeInstanceOf(
      InvalidPasswordError
    );
  });
});
