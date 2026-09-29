/**
 * Vitest 环境：安装 Node 内置 Web Crypto、fake-indexeddb。
 * happy-dom 提供 DOM；BroadcastChannel 在 Node 18+ 已全局存在。
 */
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true
  });
} else if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true
  });
}
