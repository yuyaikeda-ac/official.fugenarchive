// ============================================================
//  高機能エディタ（管理画面のお知らせ・会員向けお知らせ・同意書の本文）
//  Quill 2 を使用。見出し・文字サイズ・太字/斜体/下線/取消線・文字色/背景色・
//  配置・リスト・インデント・引用・リンク・画像（Firebase Storage へ自動アップロード）・
//  動画（YouTube / Vimeo）の埋め込み・書式のクリア に対応。
//
//  使い方：
//    const ed = await createRichEditor(要素, { html: "初期HTML", placeholder: "…" });
//    ed.getHtml()  … 保存用の HTML
//    ed.getText()  … プレーンテキスト（検索・メール用）
//    ed.isEmpty()
//  ※ 表示側は rich-view.js（安全な形にしてから表示）
// ============================================================
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { app, isDemo } from "./db.js";

const QUILL_JS = "https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.js";
const QUILL_CSS = "https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css";

// ★ 文字色・背景色のパレット（サイトの色＋よく使う色）
const COLORS = ["#000000", "#14233a", "#0b3a6e", "#1d5590", "#3a6ea5", "#2e7d6b", "#1e6b3a", "#b8862b", "#a0522d",
  "#c0392b", "#9b1c1c", "#6b4c9a", "#5b6b7d", "#8a94a3", "#ffffff", "#fff3cd", "#fde2e2", "#e3f2e8", "#e6eef8", "#f3eee2"];

let quillPromise = null;
function loadQuill() {
  if (window.Quill) return Promise.resolve(window.Quill);
  quillPromise ||= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = QUILL_CSS;
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = QUILL_JS;
    s.onload = () => resolve(window.Quill);
    s.onerror = () => reject(new Error("エディタを読み込めませんでした。通信環境をご確認ください。"));
    document.head.appendChild(s);
  });
  return quillPromise;
}

/** 画像を縮小（長辺 maxSide px）して Blob にする。GIF・SVG はそのまま */
async function shrinkImage(file, maxSide = 2000) {
  if (/image\/(gif|svg)/.test(file.type)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    return await new Promise(r => canvas.toBlob(r, type, 0.88));
  } finally { URL.revokeObjectURL(url); }
}

/** 画像を Firebase Storage（content/年/ランダム名）にアップロードして URL を返す */
export async function uploadImage(file) {
  if (isDemo) throw new Error("デモモードでは画像をアップロードできません。");
  if (!file.type.startsWith("image/")) throw new Error("画像ファイルを選んでください。");
  const blob = await shrinkImage(file);
  if (blob.size > 10 * 1024 * 1024) throw new Error("画像が大きすぎます（10MB まで）。");
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/gif" ? "gif" : blob.type === "image/svg+xml" ? "svg" : "jpg";
  const name = `${crypto.randomUUID()}.${ext}`;
  const r = ref(getStorage(app), `content/${new Date().getFullYear()}/${name}`);
  await uploadBytes(r, blob, { contentType: blob.type, cacheControl: "public, max-age=31536000" });
  return getDownloadURL(r);
}

/** YouTube / Vimeo の URL を埋め込み用 URL にする（対応外は null） */
function toEmbedUrl(url) {
  const yt = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/.exec(url);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vm = /vimeo\.com\/(?:video\/)?(\d+)/.exec(url);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return null;
}

/**
 * エディタを作る
 * @param host  エディタを置く要素
 * @param opts  { html, placeholder, minHeight, onChange, notify(msg, isError) }
 */
export async function createRichEditor(host, { html = "", placeholder = "本文を入力…", minHeight = 320, onChange, notify } = {}) {
  const Quill = await loadQuill();
  const say = notify || ((m, err) => (err ? console.error : console.info)(m));

  host.classList.add("rich-editor");
  host.innerHTML = `<div class="re-body"></div><div class="re-status" aria-live="polite"></div>`;
  const body = host.querySelector(".re-body");
  const status = host.querySelector(".re-status");
  body.style.minHeight = `${minHeight}px`;

  const quill = new Quill(body, {
    theme: "snow",
    placeholder,
    modules: {
      toolbar: {
        container: [
          [{ header: [2, 3, 4, false] }, { size: ["small", false, "large", "huge"] }],
          ["bold", "italic", "underline", "strike"],
          [{ color: COLORS }, { background: COLORS }],
          [{ align: [] }],
          [{ list: "ordered" }, { list: "bullet" }, { indent: "-1" }, { indent: "+1" }],
          ["blockquote", "link", "image", "video"],
          ["clean"]
        ],
        handlers: {
          image: () => pickImage(),
          video: () => {
            const url = window.prompt("YouTube または Vimeo の URL を入力してください");
            if (!url) return;
            const embed = toEmbedUrl(url.trim());
            if (!embed) return say("YouTube・Vimeo の URL のみ埋め込めます。", true);
            const range = quill.getSelection(true);
            quill.insertEmbed(range.index, "video", embed, "user");
            quill.setSelection(range.index + 1);
          }
        }
      },
      history: { delay: 800, maxStack: 200, userOnly: true }
    }
  });

  // ツールバーのボタンに日本語の説明を付ける
  const titles = {
    "ql-bold": "太字", "ql-italic": "斜体", "ql-underline": "下線", "ql-strike": "取り消し線",
    "ql-blockquote": "引用", "ql-link": "リンク", "ql-image": "画像を挿入", "ql-video": "動画を埋め込む",
    "ql-clean": "書式をクリア", "ql-header": "見出し", "ql-size": "文字サイズ", "ql-color": "文字色",
    "ql-background": "背景色（マーカー）", "ql-align": "配置", "ql-list": "リスト", "ql-indent": "インデント"
  };
  host.querySelectorAll(".ql-toolbar button, .ql-toolbar .ql-picker").forEach(b => {
    const cls = [...b.classList].find(c => titles[c]);
    if (cls) b.title = titles[cls] + (b.value === "ordered" ? "（番号）" : b.value === "bullet" ? "（箇条書き）" : b.value === "+1" ? "（深く）" : b.value === "-1" ? "（浅く）" : "");
  });

  // 画像のアップロード（ボタン・貼り付け・ドラッグ＆ドロップ）
  async function insertImages(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      status.textContent = `画像をアップロード中…（${file.name}）`;
      try {
        const url = await uploadImage(file);
        const range = quill.getSelection(true) || { index: quill.getLength() };
        quill.insertEmbed(range.index, "image", url, "user");
        quill.setSelection(range.index + 1);
        status.textContent = "";
      } catch (e) {
        console.error(e);
        status.textContent = "";
        say("画像のアップロードに失敗しました：" + (e.code === "storage/unauthorized" ? "権限がありません（管理者でログインしているか確認してください）" : e.message), true);
      }
    }
  }
  function pickImage() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*"; input.multiple = true;
    input.onchange = () => insertImages([...input.files]);
    input.click();
  }
  quill.root.addEventListener("paste", e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); e.stopPropagation(); insertImages(files); }
  }, true);
  quill.root.addEventListener("drop", e => {
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); e.stopPropagation(); insertImages(files); }
  }, true);

  // 画像をダブルクリック → 幅を % で指定（Quill の width 属性として保存される）
  quill.root.addEventListener("dblclick", e => {
    if (e.target.tagName !== "IMG") return;
    const blot = Quill.find(e.target);
    if (!blot) return;
    const w = window.prompt("画像の幅を % で入力してください（例：50）。空欄で元の大きさ", (e.target.getAttribute("width") || "").replace("%", ""));
    if (w === null) return;
    const n = parseInt(w, 10);
    quill.formatText(quill.getIndex(blot), 1, "width", n > 0 && n <= 100 ? `${n}%` : false, "user");
  });

  if (html) quill.clipboard.dangerouslyPasteHTML(html, "silent");
  quill.history.clear();
  quill.on("text-change", () => onChange?.());

  return {
    quill,
    getHtml() {
      if (this.isEmpty()) return "";
      // リストを正しい ul/ol に変換した HTML（Quill の getSemanticHTML）
      return quill.getSemanticHTML().replace(/&nbsp;/g, " ").replace(/ /g, " ");
    },
    getText: () => quill.getText().trim(),
    isEmpty: () => quill.getText().trim() === "" && !quill.root.querySelector("img, iframe"),
    focus: () => quill.focus()
  };
}
