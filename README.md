# 加密便笺工作台（Secure Notes Workbench）

一个**只在浏览器本地保存数据**的 TypeScript 便笺工作台。所有便笺在写入
IndexedDB 之前用 AES-GCM 加密，明文与口令**绝不持久化**。

## 安全模型

```
用户口令 ──PBKDF2(SHA-256, 250000 次, 随机盐)──▶ KEK（AES-GCM 256，不可导出）
                                                      │ wrapKey / unwrapKey
随机生成的数据密钥 DEK（AES-GCM 256）◀─────────────────┘
        │ 每条便笺独立随机 IV（12 字节）+ AES-GCM，AAD 绑定便笺 id
        ▼
   密文（含认证标签）──▶ IndexedDB（notes 仓库）
封装后的 DEK + 盐 + IV ──▶ IndexedDB（meta 仓库，仅一条记录）
```

- **首次创建**：生成随机数据密钥，用口令经 PBKDF2 派生的 KEK 封装后保存。
- **便笺加密**：每条便笺使用独立随机 IV 与 AES-GCM（256 位）加密，
  AAD 为 `note:<id>`，密文被整体调换或翻转任何字节都会被认证标签拒绝。
- **改口令**：只重新封装**同一个数据密钥**（写一条 meta 记录），
  **不批量重写任何便笺密文**。
- **失败安全**：错误口令、存储失败 / 配额失败都发生在持久化之前或随
  IndexedDB 事务回滚，**旧数据不会被改变**。
- **乐观并发**：每条记录带修订号 `rev`。两个标签页同时修改同一便笺时，
  后写者在同一个读写事务内校验 `rev` 失败、事务中止，并通过
  BroadcastChannel 收到提示「已在别处修改，请重新载入」。
- **容量上限 100 条**：计数与插入在同一事务内原子完成，并发下总数绝不超限。
- **锁定**：立即清除内存中的数据密钥并整体替换 DOM 根节点，明文即刻撤去；
  同时广播 `locked`，其它标签页回到锁定屏。
- 持久层只存放密文、盐、IV、修订号与时间戳；明文与口令不写入
  IndexedDB 或 localStorage（有测试扫描原始字节验证）。

## 目录结构

```
src/
  crypto.ts    Web Crypto：PBKDF2、AES-GCM、密钥封装、随机数
  encoding.ts  IndexedDB 记录的二进制编解码
  db.ts        IndexedDB 网关（原子容量检查、条件写入 replaceNoteIfRev）
  bus.ts       BroadcastChannel 跨标签页事件
  vault.ts     领域核心：创建 / 解锁 / 改密 / CRUD / 修订号 / 锁定
  ui.ts        无框架 DOM 界面
test/          Vitest + happy-dom + fake-indexeddb，共 22 个用例
```

## 快速开始（本地 Node）

需要 Node.js 20+。

```bash
npm ci
npm test          # 运行全部测试
npm run typecheck # 仅类型检查
npm run build     # 类型检查 + 生产构建到 dist/
npm run dev       # 本地开发服务器 http://localhost:8080
```

## 固定验收（Docker Compose）

仓库提供可运行的 Docker Compose 与一次性 `verify` 测试服务，验收依次执行：

```bash
docker compose config --quiet
docker compose build
docker compose run --rm verify
```

`verify` 在容器内依次执行 `tsc --noEmit` → `vitest run` → `vite build`，
全部通过后退出码为 0。

手动体验界面：

```bash
docker compose up web
# 打开 http://localhost:8080
```

> 浏览器需支持 Web Crypto、IndexedDB 与 BroadcastChannel
> （Chrome / Edge / Firefox / Safari 的现代版本均可）。

## 测试覆盖

| 场景 | 文件 |
| --- | --- |
| 解锁：未创建、正确/错误口令、错误口令不破坏数据、锁定后拒绝读写、明文不落盘 | `test/unlock.test.ts` |
| 篡改：翻转密文 / IV、整条密文调换（AAD）、篡改密钥封装 | `test/tamper.test.ts` |
| 改口令：重封装不改便笺、旧口令错误中止、putMeta 中断后旧口令仍有效 | `test/change-password.test.ts` |
| 容量：恰好 100 条、第 101 条失败、配额失败无残数据、双标签并发不超限 | `test/capacity.test.ts` |
| 跨标签页：修订号阻止后写覆盖、删除冲突、广播通知、锁定广播 | `test/conflict.test.ts` |
| 界面：锁定立即撤去明文、冲突提示重新载入 | `test/ui.test.ts` |

## 安全说明与边界

- 本项目是前端加密的教学/工作台实现：它能防止「能读到浏览器数据库文件的人」
  直接看到明文，但**口令无法找回**，且浏览器端 JS 供应链（XSS、恶意扩展、
  被篡改的脚本）不在威胁模型内。生产环境请自行加入 CSP、SRI 等加固。
- 明文在解锁期间存在于内存与当前 DOM 中；点击「锁定」或收到其它标签页的
  锁定广播后立即清除。刷新页面会回到锁定状态（内存密钥不持久化）。
- PBKDF2 迭代次数固定为 250000，记录在 meta 中，便于将来升级。
