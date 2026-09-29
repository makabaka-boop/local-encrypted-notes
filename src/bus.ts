/**
 * 跨标签页事件总线。
 *
 * 基于 BroadcastChannel：一个标签页写入 / 锁定后通知其它标签页，
 * 收到便笺变更的标签页若正打开该便笺则提示“已在别处修改，请重新载入”。
 */

export type VaultEvent =
  | { type: "note-upserted"; id: string; rev: number }
  | { type: "note-deleted"; id: string }
  | { type: "locked" };

export type VaultEventListener = (e: VaultEvent) => void;

export interface VaultBus {
  post(e: VaultEvent): void;
  subscribe(fn: VaultEventListener): () => void;
  close(): void;
}

export class BroadcastVaultBus implements VaultBus {
  private readonly channel: BroadcastChannel | undefined;
  private readonly listeners = new Set<VaultEventListener>();

  constructor(channelName = "secure-notes-workbench") {
    const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (BC) {
      this.channel = new BC(channelName);
      this.channel.onmessage = (ev: MessageEvent<VaultEvent>) => {
        for (const fn of this.listeners) fn(ev.data);
      };
    }
    // 没有 BroadcastChannel 的环境（老浏览器 / 部分测试）退化为仅本实例静默
  }

  post(e: VaultEvent): void {
    this.channel?.postMessage(e);
  }

  subscribe(fn: VaultEventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.listeners.clear();
    this.channel?.close();
  }
}
