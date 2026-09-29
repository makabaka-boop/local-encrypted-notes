/**
 * 工作台界面（无框架，纯 DOM）。
 *
 * 明文只出现在解锁后的 DOM 与 textarea 中；lock() 会整体替换根节点，
 * 立即撤去所有明文节点。所有动态文本经 textContent 插入，避免 XSS。
 */

import {
  CapacityError,
  InvalidPasswordError,
  NoVaultError,
  RevisionConflictError,
  StorageError,
  TamperError
} from "./errors.js";
import { NOTE_LIMIT } from "./db.js";
import { Note, Vault } from "./vault.js";

interface OpenState {
  id: string;
  rev: number;
  /** 已被其它标签页改动 / 删除，禁止再保存。 */
  stale: boolean;
}

export class App {
  private root: HTMLElement;
  private vault: Vault;
  private open: OpenState | null = null;

  constructor(root: HTMLElement, vault: Vault = new Vault()) {
    this.root = root;
    this.vault = vault;
    this.vault.subscribe((e) => this.onRemoteEvent(e));
  }

  async start(): Promise<void> {
    if (await this.vault.exists()) {
      this.renderUnlock();
    } else {
      this.renderCreate();
    }
  }

  // ---------- 跨标签页事件 ----------

  private onRemoteEvent(e: { type: string; id?: string; rev?: number }): void {
    if (e.type === "locked") {
      // 另一标签页锁定：本页也销毁内存密钥并立即撤去明文
      if (!this.vault.isLocked()) this.vault.lock();
      this.renderLockNotice();
      return;
    }
    if (this.vault.isLocked() || !this.open) return;
    if (e.type === "note-upserted" && e.id === this.open.id && e.rev !== this.open.rev) {
      this.open.stale = true;
      this.setBanner("⚠️ 此便笺已在另一个标签页被修改，请重新载入后再保存。", "warn");
      this.setSavingDisabled(true);
    } else if (e.type === "note-deleted" && e.id === this.open.id) {
      this.open.stale = true;
      this.setBanner("⚠️ 此便笺已在另一个标签页被删除。", "warn");
      this.setSavingDisabled(true);
    }
  }

  // ---------- 首次创建 ----------

  private renderCreate(): void {
    const form = this.shell(
      "创建加密工作台",
      "数据密钥将随机生成并由你的口令封装；口令无法找回。"
    );
    const pwd = input("password", "设置口令");
    const pwd2 = input("password", "再输一次口令");
    const err = alertBox();
    const btn = button("创建并进入");
    form.append(pwd.label, pwd2.label, err.box, btn);

    btn.addEventListener("click", async () => {
      err.hide();
      if (!pwd.value() || pwd.value() !== pwd2.value()) {
        err.show("两次输入的口令不一致，或口令为空。");
        return;
      }
      btn.disabled = true;
      try {
        await this.vault.setup(pwd.value());
        await this.renderWorkbench();
      } catch (e) {
        err.show(messageOf(e));
        btn.disabled = false;
      }
    });
  }

  // ---------- 解锁 ----------

  private renderUnlock(notice?: string): void {
    const form = this.shell("解锁工作台", "所有便笺仅保存在本浏览器的 IndexedDB 中。");
    const pwd = input("password", "口令");
    const err = alertBox();
    const btn = button("解锁");
    form.append(pwd.label, err.box, btn);
    if (notice) err.show(notice, "warn");

    const submit = async () => {
      err.hide();
      btn.disabled = true;
      try {
        await this.vault.unlock(pwd.value());
        await this.renderWorkbench();
      } catch (e) {
        if (e instanceof InvalidPasswordError) {
          err.show("口令错误，请重试。旧数据未被改动。");
        } else if (e instanceof NoVaultError) {
          this.renderCreate();
          return;
        } else {
          err.show(messageOf(e));
        }
        btn.disabled = false;
      }
    };
    btn.addEventListener("click", submit);
    pwd.el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void submit();
    });
  }

  private renderLockNotice(): void {
    this.open = null;
    this.renderUnlock("工作台已在另一个标签页锁定，本页明文已撤去。");
  }

  // ---------- 主界面 ----------

  private async renderWorkbench(): Promise<void> {
    this.open = null;
    this.root.replaceChildren();

    const header = el("header", { className: "topbar" });
    const title = el("h1", { textContent: "加密便笺" });
    const count = el("span", { className: "count" });
    const changeBtn = button("改口令", "ghost");
    const lockBtn = button("锁定");
    header.append(title, count, changeBtn, lockBtn);

    const layout = el("div", { className: "layout" });
    const listPane = el("div", { className: "list-pane" });
    const editorPane = el("div", { className: "editor-pane" });
    layout.append(listPane, editorPane);

    const banner = alertBox();
    banner.box.classList.add("banner");
    const newBtn = button("＋ 新建便笺", "ghost");
    listPane.append(newBtn, banner.box);

    const listEl = el("div", { className: "note-list" });
    listPane.append(listEl);

    this.root.append(header, layout);

    lockBtn.addEventListener("click", () => {
      this.vault.lock();
      this.open = null;
      this.renderUnlock();
    });
    changeBtn.addEventListener("click", () => this.renderChangePassword());
    newBtn.addEventListener("click", () => this.openEditor(null));

    await this.refreshList(listEl, count);
    this.openEditor(null);
  }

  private async refreshList(listEl: HTMLElement, countEl: HTMLElement): Promise<void> {
    const items = await this.vault.list();
    countEl.textContent = `${items.length} / ${NOTE_LIMIT}`;
    listEl.replaceChildren();
    for (const item of items) {
      const row = el("button", { className: "note-row" });
      let preview = "";
      try {
        const note = await this.vault.get(item.id);
        preview = firstLine(note.content) || "（空便笺）";
      } catch (e) {
        preview = e instanceof TamperError ? "（无法解密：数据可能被篡改）" : "（读取失败）";
      }
      const name = el("span", { className: "note-name", textContent: preview });
      const meta = el("span", {
        className: "note-meta",
        textContent: `rev ${item.rev} · ${new Date(item.updatedAt).toLocaleString()}`
      });
      row.append(name, meta);
      row.addEventListener("click", () => {
        if (this.open?.id === item.id) return;
        void this.openEditor(item.id);
      });
      listEl.append(row);
    }
  }

  private async openEditor(id: string | null): Promise<void> {
    const pane = this.root.querySelector(".editor-pane");
    if (!(pane instanceof HTMLElement)) return;
    pane.replaceChildren();
    const banner = alertBox();
    banner.box.classList.add("banner");
    const area = document.createElement("textarea");
    area.placeholder = "输入便笺内容（仅保存密文）…";
    const bar = el("div", { className: "editor-bar" });
    const saveBtn = button("保存");
    const delBtn = button("删除", "danger");
    const reloadBtn = button("重新载入", "ghost");
    reloadBtn.hidden = true;
    bar.append(saveBtn, reloadBtn, delBtn);
    pane.append(banner.box, area, bar);
    area.focus();

    if (!id) {
      this.open = null;
      delBtn.hidden = true;
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
          const note = await this.vault.create(area.value);
          await this.afterSaved(note);
        } catch (e) {
          this.showEditorError(banner, e);
          saveBtn.disabled = false;
        }
      };
      return;
    }

    let note: Note;
    try {
      note = await this.vault.get(id);
    } catch (e) {
      banner.show(messageOf(e), "danger");
      this.open = null;
      return;
    }
    area.value = note.content;
    this.open = { id: note.id, rev: note.rev, stale: false };

    saveBtn.onclick = async () => {
      if (!this.open) return;
      banner.hide();
      saveBtn.disabled = true;
      try {
        const updated = await this.vault.update(this.open.id, area.value, this.open.rev);
        await this.afterSaved(updated);
      } catch (e) {
        if (e instanceof RevisionConflictError) {
          this.open.stale = true;
          banner.show("此便笺已在别处被修改（后写已被阻止）。请重新载入。", "warn");
          reloadBtn.hidden = false;
        } else {
          this.showEditorError(banner, e);
        }
        saveBtn.disabled = false;
      }
    };

    reloadBtn.onclick = () => {
      if (this.open) void this.openEditor(this.open.id);
    };

    delBtn.onclick = async () => {
      if (!this.open) return;
      delBtn.disabled = true;
      try {
        await this.vault.delete(this.open.id, this.open.rev);
        this.open = null;
        await this.renderWorkbench();
      } catch (e) {
        this.showEditorError(banner, e);
        delBtn.disabled = false;
      }
    };
  }

  private async afterSaved(note: Note): Promise<void> {
    const listEl = this.root.querySelector(".note-list");
    const countEl = this.root.querySelector(".count");
    if (listEl instanceof HTMLElement && countEl instanceof HTMLElement) {
      await this.refreshList(listEl, countEl);
    }
    await this.openEditor(note.id);
  }

  private showEditorError(banner: ReturnType<typeof alertBox>, e: unknown): void {
    if (e instanceof CapacityError) {
      banner.show(`便笺数量已达上限（${NOTE_LIMIT} 条），无法新建。`, "danger");
    } else if (e instanceof StorageError) {
      banner.show(`保存失败，旧数据保持不变：${e.message}`, "danger");
    } else {
      banner.show(messageOf(e), "danger");
    }
  }

  private setSavingDisabled(disabled: boolean): void {
    const pane = this.root.querySelector(".editor-pane");
    pane?.querySelectorAll("button").forEach((b) => {
      if (b.textContent === "保存" || b.textContent === "删除") (b as HTMLButtonElement).disabled = disabled;
    });
    const reload = this.root.querySelector(".editor-bar button.ghost") as HTMLButtonElement | null;
    if (reload && disabled) reload.hidden = false;
  }

  private setBanner(text: string, kind: "warn" | "danger"): void {
    const box = this.root.querySelector(".banner");
    if (box instanceof HTMLElement) {
      box.textContent = text;
      box.className = `alert ${kind} banner`;
    }
  }

  // ---------- 改口令 ----------

  private renderChangePassword(): void {
    const overlay = el("div", { className: "overlay" });
    const dialog = el("div", { className: "dialog" });
    overlay.append(dialog);
    const h = el("h2", { textContent: "修改口令" });
    const info = el("p", {
      className: "hint",
      textContent: "只重新封装数据密钥，已有便笺密文不会被重写。"
    });
    const oldP = input("password", "当前口令");
    const newP = input("password", "新口令");
    const newP2 = input("password", "确认新口令");
    const err = alertBox();
    const ok = button("确认修改");
    const cancel = button("取消", "ghost");
    const bar = el("div", { className: "dialog-bar" });
    bar.append(ok, cancel);
    dialog.append(h, info, oldP.label, newP.label, newP2.label, err.box, bar);
    this.root.append(overlay);

    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close();
    });

    ok.addEventListener("click", async () => {
      err.hide();
      if (!newP.value() || newP.value() !== newP2.value()) {
        err.show("两次输入的新口令不一致，或新口令为空。");
        return;
      }
      ok.disabled = true;
      try {
        await this.vault.changePassword(oldP.value(), newP.value());
        close();
        this.setBanner("口令已修改，便笺未改动。", "warn");
      } catch (e) {
        if (e instanceof InvalidPasswordError) {
          err.show("当前口令错误，已取消，旧数据未改动。");
        } else {
          err.show(`修改失败（中断），旧口令仍然有效：${messageOf(e)}`);
        }
        ok.disabled = false;
      }
    });
  }

  // ---------- 骨架与工具 ----------

  private shell(title: string, subtitle: string): HTMLElement {
    this.open = null;
    this.root.replaceChildren();
    const wrap = el("div", { className: "auth-screen" });
    const card = el("form", { className: "card" });
    card.addEventListener("submit", (ev) => ev.preventDefault());
    const h = el("h1", { textContent: title });
    const sub = el("p", { className: "hint", textContent: subtitle });
    card.append(h, sub);
    wrap.append(card);
    this.root.append(wrap);
    return card;
  }
}

// ---- DOM 小工具 ----

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

function input(type: string, placeholder: string) {
  const label = el("label", { className: "field" });
  const inputEl = document.createElement("input");
  inputEl.type = type;
  inputEl.placeholder = placeholder;
  inputEl.autocomplete = type === "password" ? "new-password" : "off";
  label.append(inputEl);
  return {
    label,
    el: inputEl,
    value: () => inputEl.value
  };
}

function button(text: string, variant?: string): HTMLButtonElement {
  const b = el("button", { textContent: text, type: "button" });
  if (variant) b.classList.add(variant);
  return b;
}

function alertBox() {
  const box = el("div", { className: "alert" });
  box.hidden = true;
  return {
    box,
    show(text: string, kind: "warn" | "danger" = "danger") {
      box.textContent = text;
      box.className = `alert ${kind}`;
      box.hidden = false;
    },
    hide() {
      box.hidden = true;
      box.textContent = "";
    }
  };
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim().slice(0, 60);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
