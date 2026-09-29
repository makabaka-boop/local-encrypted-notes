import "./styles.css";
import { App } from "./ui.js";

const root = document.getElementById("app");
if (!(root instanceof HTMLElement)) {
  throw new Error("缺少 #app 根节点");
}

// Vault 在内存中持有数据密钥；刷新 / 关闭标签页后进程销毁，密钥随之消失，
// IndexedDB 中本就只有密文，因此无需额外的卸载清理。
const app = new App(root);
void app.start();
