// ============================================================
//  装飾つき本文（bodyHtml）の表示
//  管理画面のエディタで作った HTML を、危険なタグ・属性を取り除いて（DOMPurify）表示します。
//  ・使えるのは見出し・太字・色・リンク・画像・リスト・引用・YouTube/Vimeo の埋め込みなど
//  ・<script> やイベント属性（onclick など）、外部の iframe は表示されません
//  ※ 見た目は style.css / member.css の .rich-body
// ============================================================

const PURIFY_URL = "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js";
// 埋め込みを許可する動画サイト
const IFRAME_OK = /^https:\/\/(www\.youtube(-nocookie)?\.com\/embed\/|player\.vimeo\.com\/video\/)/;

let purifyPromise = null;
function loadPurify() {
  if (window.DOMPurify) return Promise.resolve(window.DOMPurify);
  purifyPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PURIFY_URL;
    s.onload = () => {
      const P = window.DOMPurify;
      // 許可していない iframe は削除
      P.addHook("uponSanitizeElement", (node, data) => {
        if (data.tagName === "iframe" && !IFRAME_OK.test(node.getAttribute("src") || "")) node.parentNode?.removeChild(node);
      });
      // リンクは別タブで安全に開く
      P.addHook("afterSanitizeAttributes", node => {
        if (node.tagName === "A" && node.getAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
        if (node.tagName === "IFRAME") { node.setAttribute("allowfullscreen", ""); node.setAttribute("loading", "lazy"); }
        if (node.tagName === "IMG") node.setAttribute("loading", "lazy");
      });
      resolve(P);
    };
    s.onerror = () => reject(new Error("表示用ライブラリを読み込めませんでした"));
    document.head.appendChild(s);
  });
  return purifyPromise;
}

/** HTML を安全な形にする（Promise で文字列を返す） */
export async function sanitize(html) {
  const P = await loadPurify();
  return P.sanitize(html || "", {
    ADD_TAGS: ["iframe"],
    ADD_ATTR: ["allowfullscreen", "frameborder", "target"],
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["onerror", "onload"]
  });
}

/**
 * 要素に本文を表示する。bodyHtml があればそれを、無ければ body（プレーンテキスト）を表示
 * @param el    表示先の要素（.rich-body クラスが付きます）
 * @param item  { bodyHtml?, body? }
 */
export async function renderRich(el, item) {
  el.classList.add("rich-body");
  if (item?.bodyHtml) {
    try { el.innerHTML = await sanitize(item.bodyHtml); return; }
    catch (e) { console.error(e); }
  }
  el.textContent = item?.body || htmlToText(item?.bodyHtml || "");
}

/** HTML からプレーンテキストを取り出す（検索・メール用） */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  doc.querySelectorAll("p, h1, h2, h3, h4, li, blockquote, br").forEach(n => n.append("\n"));
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
