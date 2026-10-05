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

// ============================================================
//  画像の大きさ・位置
//  画像をクリックすると、画像の上に操作バーが出ます。
//   ・大きさ：小（25%）／中（50%）／大（75%）／全幅（100%）／元のサイズ、右下の □ をドラッグして自由に変更
//   ・位置　：左寄せ／中央／右寄せ／左に置いて文字を回り込み／右に置いて文字を回り込み
//   ・代替テキスト（画像の説明。読み上げ・画像が出ないときに表示）、削除
//  保存される HTML：<img src width="50%" data-align="center" alt="…">
//  ※ 表示側の見た目は style.css / member.css / admin.css の .rich-body img[data-align]
// ============================================================
const IMG_ALIGNS = [
  { v: "left", label: "左寄せ", icon: '<path d="M3 5h18M3 19h18"/><rect x="3" y="8" width="9" height="8" rx="1"/>' },
  { v: "center", label: "中央", icon: '<path d="M3 5h18M3 19h18"/><rect x="7.5" y="8" width="9" height="8" rx="1"/>' },
  { v: "right", label: "右寄せ", icon: '<path d="M3 5h18M3 19h18"/><rect x="12" y="8" width="9" height="8" rx="1"/>' },
  { v: "float-left", label: "左に置いて文字を回り込み", icon: '<rect x="3" y="5" width="8" height="8" rx="1"/><path d="M14 6h7M14 10h7M3 16h18M3 20h18"/>' },
  { v: "float-right", label: "右に置いて文字を回り込み", icon: '<rect x="13" y="5" width="8" height="8" rx="1"/><path d="M3 6h7M3 10h7M3 16h18M3 20h18"/>' }
];
const IMG_SIZES = [["25%", "小"], ["50%", "中"], ["75%", "大"], ["100%", "全幅"], ["", "元のサイズ"]];

/** 画像に「位置（data-align）」を保存できるようにする（Quill の画像を拡張） */
let flexImageRegistered = false;
function registerFlexImage(Quill) {
  if (flexImageRegistered) return;
  flexImageRegistered = true;
  const BaseImage = Quill.import("formats/image");
  class FlexImage extends BaseImage {
    static formats(node) {
      const f = super.formats(node);
      if (node.hasAttribute("data-align")) f.imgAlign = node.getAttribute("data-align");
      return f;
    }
    format(name, value) {
      if (name === "imgAlign") {
        if (IMG_ALIGNS.some(a => a.v === value)) this.domNode.setAttribute("data-align", value);
        else this.domNode.removeAttribute("data-align");
      } else super.format(name, value);
    }
  }
  Quill.register(FlexImage, true);
}

let imageToolStyle = false;
function injectImageToolStyle() {
  if (imageToolStyle) return;
  imageToolStyle = true;
  const st = document.createElement("style");
  st.textContent = `
  .rich-editor { position: relative; }
  .re-imgbox { position: absolute; z-index: 5; pointer-events: none; outline: 2px solid #1d5590; outline-offset: 1px; border-radius: 4px; }
  .re-imgbox .re-handle { position: absolute; right: -7px; bottom: -7px; width: 14px; height: 14px; border-radius: 3px; background: #1d5590; border: 2px solid #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.35); cursor: nwse-resize; pointer-events: auto; touch-action: none; }
  .re-imgbox .re-size { position: absolute; left: 6px; bottom: 6px; padding: 2px 8px; border-radius: 99px; background: rgba(10,20,40,.78); color: #fff; font: 600 11px/1.6 sans-serif; }
  .re-imgbar { position: absolute; z-index: 6; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; max-width: calc(100% - 8px); padding: 4px; border-radius: 10px;
    background: #14233a; box-shadow: 0 10px 28px -8px rgba(0,0,0,.45); }
  .re-imgbar button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 30px; height: 30px; padding: 0 8px; border: 0; border-radius: 7px;
    background: transparent; color: #dfe6f0; font: 600 12px/1 sans-serif; cursor: pointer; white-space: nowrap; }
  .re-imgbar button:hover { background: rgba(255,255,255,.12); color: #fff; }
  .re-imgbar button.is-on { background: #3a6ea5; color: #fff; }
  .re-imgbar button.danger:hover { background: #9b1c1c; }
  .re-imgbar svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .re-imgbar i { width: 1px; height: 20px; margin: 0 4px; background: rgba(255,255,255,.2); }
  .rich-editor .ql-editor img { cursor: pointer; }
  /* 見出し・文字サイズの選択肢を日本語に */
  .rich-editor .ql-snow .ql-picker.ql-header { width: 104px; }
  .rich-editor .ql-snow .ql-picker.ql-size { width: 84px; }
  .rich-editor .ql-snow .ql-picker.ql-header .ql-picker-label::before, .rich-editor .ql-snow .ql-picker.ql-header .ql-picker-item::before { content: "本文"; }
  .rich-editor .ql-snow .ql-picker.ql-header [data-value="2"]::before { content: "大見出し" !important; }
  .rich-editor .ql-snow .ql-picker.ql-header [data-value="3"]::before { content: "中見出し" !important; }
  .rich-editor .ql-snow .ql-picker.ql-header [data-value="4"]::before { content: "小見出し" !important; }
  .rich-editor .ql-snow .ql-picker.ql-size .ql-picker-label::before, .rich-editor .ql-snow .ql-picker.ql-size .ql-picker-item::before { content: "標準"; }
  .rich-editor .ql-snow .ql-picker.ql-size [data-value="small"]::before { content: "小さく" !important; }
  .rich-editor .ql-snow .ql-picker.ql-size [data-value="large"]::before { content: "大きく" !important; }
  .rich-editor .ql-snow .ql-picker.ql-size [data-value="huge"]::before { content: "特大" !important; }`;
  document.head.appendChild(st);
}

/** 画像をクリックしたときの操作バーとサイズ変更ハンドル */
function bindImageTools(Quill, quill, host) {
  injectImageToolStyle();
  const box = document.createElement("div");
  box.className = "re-imgbox";
  box.hidden = true;
  box.innerHTML = '<span class="re-size"></span><span class="re-handle" title="ドラッグして大きさを変更"></span>';
  const bar = document.createElement("div");
  bar.className = "re-imgbar";
  bar.hidden = true;
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "画像の大きさと位置");
  bar.innerHTML =
    IMG_SIZES.map(([w, l]) => `<button type="button" data-w="${w}" title="幅 ${w || "元のサイズ"}">${l}</button>`).join("") + "<i></i>" +
    IMG_ALIGNS.map(a => `<button type="button" data-a="${a.v}" title="${a.label}" aria-label="${a.label}"><svg viewBox="0 0 24 24">${a.icon}</svg></button>`).join("") + "<i></i>" +
    '<button type="button" data-act="alt" title="代替テキスト（画像の説明）">説明</button>' +
    '<button type="button" data-act="del" class="danger" title="画像を削除" aria-label="画像を削除"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>';
  host.append(box, bar);

  let img = null;
  const blotIndex = () => { const b = img && Quill.find(img); return b ? quill.getIndex(b) : -1; };

  function place() {
    if (!img || !img.isConnected) return hide();
    const h = host.getBoundingClientRect(), r = img.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - h.left}px`, top: `${r.top - h.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.querySelector(".re-size").textContent = img.getAttribute("width") || `${img.naturalWidth}px`;
    // 操作バーは画像の上（入らなければ下）に
    const barH = bar.offsetHeight || 40;
    let top = r.top - h.top - barH - 8;
    if (r.top - barH - 8 < h.top + 44) top = r.bottom - h.top + 8;
    bar.style.top = `${top}px`;
    bar.style.left = `${Math.max(4, Math.min(r.left - h.left, h.width - bar.offsetWidth - 4))}px`;
    const w = img.getAttribute("width") || "", a = img.getAttribute("data-align") || "";
    bar.querySelectorAll("[data-w]").forEach(b => b.classList.toggle("is-on", b.dataset.w === w));
    bar.querySelectorAll("[data-a]").forEach(b => b.classList.toggle("is-on", b.dataset.a === a));
  }
  function show(target) {
    img = target;
    box.hidden = bar.hidden = false;
    place();
  }
  function hide() {
    img = null;
    box.hidden = bar.hidden = true;
  }
  const apply = (name, value) => {
    const i = blotIndex();
    if (i < 0) return hide();
    const keep = img;
    quill.formatText(i, 1, name, value, "user");
    // 書式を変えると画像の要素が作り直されることがあるので選び直す
    const again = keep.isConnected ? keep : quill.getLeaf(i + 1)[0]?.domNode;
    if (again?.tagName === "IMG") show(again); else hide();
  };

  quill.root.addEventListener("click", e => { if (e.target.tagName === "IMG") { e.preventDefault(); show(e.target); } else hide(); });
  document.addEventListener("pointerdown", e => { if (img && !host.contains(e.target)) hide(); });
  quill.root.addEventListener("keydown", () => hide());
  quill.on("text-change", () => requestAnimationFrame(place));
  quill.root.addEventListener("load", e => { if (e.target === img) place(); }, true); // 画像の読み込み完了で位置を合わせ直す
  quill.root.addEventListener("scroll", place);
  host.closest(".panel-body, .slide-body, [data-scroll]")?.addEventListener("scroll", place);
  window.addEventListener("resize", place);

  bar.addEventListener("mousedown", e => e.preventDefault()); // エディタの選択を保つ
  bar.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || !img) return;
    if (b.dataset.w !== undefined) apply("width", b.dataset.w || false);
    else if (b.dataset.a) apply("imgAlign", img.getAttribute("data-align") === b.dataset.a ? false : b.dataset.a);
    else if (b.dataset.act === "alt") {
      const t = window.prompt("画像の説明（代替テキスト）を入力してください", img.getAttribute("alt") || "");
      if (t !== null) apply("alt", t.trim() || false);
    } else if (b.dataset.act === "del") {
      const i = blotIndex();
      if (i >= 0) quill.deleteText(i, 1, "user");
      hide();
    }
  });

  // 右下の □ をドラッグして大きさを変更（エディタの幅に対する % で保存、5% 刻み）
  const handle = box.querySelector(".re-handle");
  handle.addEventListener("pointerdown", e => {
    if (!img) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = img.getBoundingClientRect().width;
    const full = quill.root.clientWidth - 30; // 本文の左右の余白を除いた幅
    let pct = null;
    const move = ev => {
      const w = Math.max(40, startW + (ev.clientX - startX));
      pct = Math.max(10, Math.min(100, Math.round((w / full) * 100 / 5) * 5));
      img.setAttribute("width", `${pct}%`);
      place();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (pct) apply("width", `${pct}%`);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

/**
 * エディタを作る
 * @param host  エディタを置く要素
 * @param opts  { html, placeholder, minHeight, onChange, notify(msg, isError) }
 */
export async function createRichEditor(host, { html = "", placeholder = "本文を入力…", minHeight = 320, onChange, notify } = {}) {
  const Quill = await loadQuill();
  registerFlexImage(Quill);
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

  bindImageTools(Quill, quill, host);

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
