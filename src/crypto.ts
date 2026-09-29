/**
 * Web Crypto / 随机数适配层。
 *
 * 浏览器使用 window.crypto；Node 18+ 的测试环境使用 globalThis.crypto
 * （由 test/setup.ts 保证存在）。
 */

import { InvalidPasswordError, TamperError } from "./errors.js";

export function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error("当前环境不支持 Web Crypto API");
  }
  return c;
}

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  getCrypto().getRandomValues(buf);
  return buf;
}

/** 生成新的数据密钥：AES-GCM 256，可被封装（extractable）。 */
export function generateDataKey(): Promise<CryptoKey> {
  return getCrypto().subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable：首次创建后由口令密钥封装
    ["encrypt", "decrypt"]
  );
}

/** 由用户口令经 PBKDF2 派生 AES-GCM 256 的 KEK（不可导出）。 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const c = getCrypto();
  const baseKey = await c.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return c.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false, // KEK 不可导出
    ["wrapKey", "unwrapKey"]
  );
}

/** 用 KEK 封装数据密钥，返回密文字节与随机 IV。 */
export async function wrapDataKey(
  kek: CryptoKey,
  dataKey: CryptoKey
): Promise<{ wrapped: Uint8Array; iv: Uint8Array }> {
  const iv = randomBytes(IV_LENGTH);
  const wrapped = await getCrypto().subtle.wrapKey("raw", dataKey, kek, {
    name: "AES-GCM",
    iv: iv as BufferSource
  });
  return { wrapped: new Uint8Array(wrapped), iv };
}

/** 用 KEK 解封数据密钥。口令错误 / 封装被篡改时 GCM 校验失败。 */
export async function unwrapDataKey(
  kek: CryptoKey,
  wrapped: Uint8Array,
  iv: Uint8Array
): Promise<CryptoKey> {
  try {
    return await getCrypto().subtle.unwrapKey(
      "raw",
      wrapped as BufferSource,
      kek,
      { name: "AES-GCM", iv: iv as BufferSource },
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );
  } catch {
    // GCM 认证失败（错误口令）或结构损坏一律视为口令错误
    throw new InvalidPasswordError();
  }
}

/** 便笺密文的附加认证数据：把密文绑定到便笺 id，防止整条调换。 */
export function noteAad(id: string): Uint8Array {
  return new TextEncoder().encode(`note:${id}`);
}

/** AES-GCM 加密：返回密文（含 GCM 认证标签）与独立随机 IV。 */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const out = await getCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource
    },
    key,
    plaintext as BufferSource
  );
  return new Uint8Array(out);
}

/** AES-GCM 解密；认证失败（篡改）抛 TamperError。 */
export async function decryptBytes(
  key: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  try {
    const out = await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: aad as BufferSource
      },
      key,
      ciphertext as BufferSource
    );
    return new Uint8Array(out);
  } catch {
    throw new TamperError();
  }
}

export const PBKDF2_ITERATIONS = 250_000;
export const IV_LENGTH = 12;
export const SALT_LENGTH = 16;
export const KEY_ID_LENGTH = 16;

/** 随机十六进制标识（便笺 id、数据密钥 id）。 */
export function randomId(bytes = KEY_ID_LENGTH): string {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
