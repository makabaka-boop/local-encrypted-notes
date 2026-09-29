/**
 * IndexedDB 持久化记录的二进制编解码。
 * 全部使用长度前缀（大端 u32）的自描述格式，只存密文，绝不存明文/口令。
 */

export interface WrappedKeyMeta {
  /** 格式版本。 */
  v: number;
  /** PBKDF2 盐。 */
  salt: Uint8Array;
  /** 被 KEK 封装的数据密钥密文。 */
  wrappedKey: Uint8Array;
  /** 封装所用 IV。 */
  keyIv: Uint8Array;
  /** PBKDF2 迭代次数（便于将来升级）。 */
  iterations: number;
  /** 数据密钥标识，便于调试。 */
  keyId: string;
  /** 创建时间（毫秒）。 */
  createdAt: number;
}

export interface StoredNote {
  id: string;
  /** 内容密文（含 GCM 标签）。 */
  ciphertext: Uint8Array;
  /** 本次写入独立随机 IV。 */
  iv: Uint8Array;
  /** 乐观锁修订号，从 1 开始，每次写入 +1。 */
  rev: number;
  updatedAt: number;
}

const META_VERSION = 1;

export function encodeMeta(meta: WrappedKeyMeta): Uint8Array {
  const enc = new TextEncoder();
  const keyIdBytes = enc.encode(meta.keyId);
  return concat([
    u32(meta.v),
    u32(meta.salt.length),
    meta.salt,
    u32(meta.keyIv.length),
    meta.keyIv,
    u32(meta.wrappedKey.length),
    meta.wrappedKey,
    u32(meta.iterations),
    u32(keyIdBytes.length),
    keyIdBytes,
    f64(meta.createdAt)
  ]);
}

export function decodeMeta(bytes: Uint8Array): WrappedKeyMeta {
  const r = new Reader(bytes);
  const v = r.u32();
  if (v !== META_VERSION) throw new Error(`不支持的数据版本: ${v}`);
  const salt = r.bytes();
  const keyIv = r.bytes();
  const wrappedKey = r.bytes();
  const iterations = r.u32();
  const keyId = new TextDecoder().decode(r.bytes());
  const createdAt = r.f64();
  r.done();
  return { v, salt, keyIv, wrappedKey, iterations, keyId, createdAt };
}

export function encodeNote(note: StoredNote): Uint8Array {
  const enc = new TextEncoder();
  const idBytes = enc.encode(note.id);
  return concat([
    u32(idBytes.length),
    idBytes,
    u32(note.iv.length),
    note.iv,
    u32(note.ciphertext.length),
    note.ciphertext,
    u32(note.rev),
    f64(note.updatedAt)
  ]);
}

export function decodeNote(bytes: Uint8Array): StoredNote {
  const r = new Reader(bytes);
  const id = new TextDecoder().decode(r.bytes());
  const iv = r.bytes();
  const ciphertext = r.bytes();
  const rev = r.u32();
  const updatedAt = r.f64();
  r.done();
  return { id, iv, ciphertext, rev, updatedAt };
}

// ---- 低层拼装工具 ----

class Reader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}

  u32(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 4).getUint32(0);
    this.off += 4;
    return v;
  }

  f64(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 8).getFloat64(0);
    this.off += 8;
    return v;
  }

  bytes(): Uint8Array {
    const len = this.u32();
    const v = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return v;
  }

  done(): void {
    if (this.off !== this.buf.length) throw new Error("记录字节存在多余数据");
  }
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}

function f64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
