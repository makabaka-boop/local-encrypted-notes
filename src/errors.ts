/** 口令错误（PBKDF2 派生密钥无法解封数据密钥）。 */
export class InvalidPasswordError extends Error {
  constructor() {
    super("口令错误，无法解锁");
    this.name = "InvalidPasswordError";
  }
}

/** 尚未创建（IndexedDB 中没有密钥封装记录）。 */
export class NoVaultError extends Error {
  constructor() {
    super("尚未创建");
    this.name = "NoVaultError";
  }
}

/** 便笺密文被篡改或解密失败。 */
export class TamperError extends Error {
  constructor() {
    super("数据已损坏或被篡改");
    this.name = "TamperError";
  }
}

/** 乐观并发冲突：记录修订号与本地不一致。 */
export class RevisionConflictError extends Error {
  constructor(
    /** 服务端（IndexedDB）当前修订号。 */
    readonly expected: number
  ) {
    super(`便笺已在别处修改（当前修订号 ${expected}），请重新载入`);
    this.name = "RevisionConflictError";
  }
}

/** 容量上限（100 条）。 */
export class CapacityError extends Error {
  constructor(readonly limit: number) {
    super(`便笺数量已达上限（${limit} 条）`);
    this.name = "CapacityError";
  }
}

/** 存储层（IndexedDB）失败。 */
export class StorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StorageError";
  }
}
