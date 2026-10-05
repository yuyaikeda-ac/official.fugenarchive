// ============================================================
//  お問い合わせチャット（ticket.html#チケットID.秘密の番号）
//  ・チケットの内容・やり取りの取得・送信は Cloud Functions（ticketGet / ticketSend / ticketClose）
//  ・AI オペレータが対応中のときは、送信すると AI の返事を待って表示
//  ・担当者の返信は 15 秒ごとに確認（タブが表示されているときだけ）
// ============================================================
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { app, isDemo } from "./db.js";

const root = document.getElementById("tk-root");
const fns = isDemo ? null : getFunctions(app, "asia-northeast1");
const call = (name, data) => httpsCallable(fns, name, { timeout: 120000 })(data).then(r => r.data);

const POLL_MS = 15000;
const STATUS = {
  ai: { label: "AI 対応中", cls: "ai" },
  waiting_staff: { label: "担当者の確認待ち", cls: "wait" },
  staff: { label: "担当者が対応中", cls: "staff" },
  closed: { label: "対応完了", cls: "closed" }
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** 文字列を安全に HTML にする（先にエスケープしてから URL をリンクに・改行を保持） */
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,、。）)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const fmt = (iso) => iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }) : "";

const ICON = {
  ai: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6M2 12v3M22 12v3"/></svg>',
  staff: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>'
};

// ---------- URL のチケット ID・秘密の番号 ----------
const [id, token] = decodeURIComponent(location.hash.slice(1)).split(".");
let state = null;       // { ticket, messages }
let sending = false;
let pending = null;     // 送信中の自分の発言（すぐに表示）
let pollTimer = null;

function fail(title, text, link = true) {
  root.innerHTML = `<div class="tk-state tk-error"><h2>${esc(title)}</h2><p>${text}</p>${link ? '<p><a class="btn" href="contact.html">お問い合わせページへ</a></p>' : ""}</div>`;
}
const errText = (e) => e?.code === "functions/permission-denied" || e?.code === "functions/not-found"
  ? "リンクが正しくないか、有効期限が切れています。メールに記載のリンクから開き直してください。"
  : (e?.message && e.code !== "functions/internal" ? e.message : "通信に失敗しました。時間をおいて再度お試しください。");

// ---------- 画面 ----------
function shell() {
  root.innerHTML = `
    <section class="tk-card">
      <div class="tk-head" id="tk-head"></div>
      <p class="tk-note">返信があるとメールでお知らせします。このページの URL は他の人に教えないでください。</p>
      <div class="tk-log" id="tk-log" aria-live="polite"></div>
      <div class="tk-composer" id="tk-composer"></div>
    </section>`;
}

function renderHead() {
  const t = state.ticket;
  const st = STATUS[t.status] || { label: t.statusLabel || t.status, cls: "wait" };
  document.getElementById("tk-head").innerHTML = `
    <div class="tk-head-main">
      <span class="tk-no">${esc(t.no || "")}</span>
      <h1>${esc(t.category || "お問い合わせ")}</h1>
      <small>${esc(t.name ? `${t.name} 様・` : "")}${esc(fmtDate(t.createdAt))} 受付</small>
    </div>
    <span class="tk-status ${st.cls}">${esc(t.statusLabel || st.label)}</span>`;
  document.title = `${t.no || "お問い合わせ"}｜お問い合わせチャット｜普賢アーカイブ運営委員会`;
}

function bubble(m) {
  if (m.from === "system") return `<div class="tk-sys"><span>${linkify(m.text)}</span></div>`;
  const mine = m.from === "customer";
  const who = m.from === "ai" ? `${ICON.ai}AI オペレータ` : m.from === "staff" ? `${ICON.staff}担当者${m.staffName ? `（${esc(m.staffName)}）` : ""}` : "";
  return `<div class="tk-msg ${mine ? "me" : m.from}${m.pending ? " is-pending" : ""}">
    ${who ? `<div class="tk-who">${who}</div>` : ""}
    <div class="tk-bubble">${linkify(m.text)}</div>
    <div class="tk-time">${m.pending ? "送信中…" : esc(fmt(m.at))}</div>
  </div>`;
}

function renderLog(scroll = false) {
  const log = document.getElementById("tk-log");
  const atBottom = getComputedStyle(log).overflowY === "visible"
    ? log.getBoundingClientRect().bottom <= window.innerHeight - (document.getElementById("tk-composer")?.offsetHeight || 0) + 120
    : log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const list = [...state.messages, ...(pending ? [pending] : [])];
  log.innerHTML = list.map(bubble).join("") +
    (sending && state.ticket.status === "ai" ? `<div class="tk-msg ai tk-typing"><div class="tk-who">${ICON.ai}AI オペレータ</div><div class="tk-bubble"><span class="tk-dots"><i></i><i></i><i></i></span> 入力中…</div></div>` : "");
  if (scroll || atBottom) scrollToEnd();
}
/** 最新のメッセージまでスクロール（スマホではページ全体、パソコンではやり取りの枠の中） */
function scrollToEnd() {
  const log = document.getElementById("tk-log");
  if (!log) return;
  if (getComputedStyle(log).overflowY === "visible") {
    // 最後のメッセージが、画面の下に固定した入力欄のすぐ上に見える位置まで（フッターまでは行かない）
    const composerH = document.getElementById("tk-composer")?.offsetHeight || 0;
    window.scrollTo({ top: Math.max(0, log.getBoundingClientRect().bottom + window.scrollY - (window.innerHeight - composerH)), behavior: "instant" });
  } else log.scrollTop = log.scrollHeight;
}

function renderComposer() {
  const box = document.getElementById("tk-composer");
  const t = state.ticket;
  if (t.status === "closed") {
    box.innerHTML = `<p class="tk-closed">このお問い合わせは終了しました。新しいお問い合わせは <a href="contact.html">こちら</a></p>`;
    return;
  }
  const keep = box.querySelector("textarea")?.value || "";
  box.innerHTML = `
    <form id="tk-form" class="tk-form">
      <label class="tk-sr" for="tk-text">メッセージ</label>
      <textarea id="tk-text" rows="2" maxlength="1500" placeholder="メッセージを入力（Ctrl + Enter で送信）"${sending ? " disabled" : ""}></textarea>
      <button type="submit" class="tk-send" aria-label="送信"${sending ? " disabled" : ""}>${sending ? '<span class="tk-spin"></span>' : ICON.send}<span>送信</span></button>
    </form>
    <div class="tk-actions">
      ${t.status === "ai" ? `<button type="button" class="tk-link" id="tk-human"${sending ? " disabled" : ""}>担当者に相談する</button>` : `<span class="tk-wait-note">${t.status === "waiting_staff" ? "担当者が確認しています。返信までしばらくお待ちください。" : "担当者が対応しています。"}</span>`}
      <button type="button" class="tk-link danger" id="tk-close"${sending ? " disabled" : ""}>お問い合わせを終了する</button>
    </div>`;
  const ta = box.querySelector("#tk-text");
  ta.value = keep;
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(false); } });
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`; });
  box.querySelector("#tk-form").addEventListener("submit", (e) => { e.preventDefault(); send(false); });
  box.querySelector("#tk-human")?.addEventListener("click", () => {
    if (window.confirm("担当者（人）に引き継ぎます。入力中のメッセージがあれば一緒に送ります。よろしいですか？")) send(true);
  });
  box.querySelector("#tk-close").addEventListener("click", closeTicket);
}

function render(scroll = false) {
  renderHead();
  renderLog(scroll);
  renderComposer();
}

// ---------- 通信 ----------
function apply(data, scroll = false) {
  const before = state?.messages?.length || 0;
  state = data;
  render(scroll || data.messages.length !== before);
}

async function send(requestHuman) {
  if (sending) return;
  const ta = document.getElementById("tk-text");
  const text = (ta?.value || "").trim();
  if (!text && !requestHuman) { ta?.focus(); return; }
  sending = true;
  pending = text ? { from: "customer", text, pending: true } : null;
  if (ta) ta.value = "";
  render(true);
  try {
    apply(await call("ticketSend", { id, token, text, requestHuman: !!requestHuman }), true);
  } catch (e) {
    console.error(e);
    // 送れなかった文章は入力欄に戻す
    sending = false; pending = null; render();
    const box = document.getElementById("tk-text");
    if (box && text) box.value = text;
    toastError(errText(e));
    return;
  }
  sending = false; pending = null; render(true);
}

async function closeTicket() {
  if (!window.confirm("このお問い合わせを終了します。終了後は、このチャットで送信できなくなります。よろしいですか？")) return;
  try { apply(await call("ticketClose", { id, token }), true); }
  catch (e) { console.error(e); toastError(errText(e)); }
}

async function refresh() {
  if (sending || document.hidden || !state || state.ticket.status === "closed") return;
  try { apply(await call("ticketGet", { id, token })); } catch (e) { console.warn(e); }
}

function toastError(msg) {
  const log = document.getElementById("tk-log");
  log?.insertAdjacentHTML("beforeend", `<div class="tk-sys err"><span>${esc(msg)}</span></div>`);
  scrollToEnd();
}

// ---------- 開始 ----------
async function start() {
  if (isDemo) return fail("現在ご利用いただけません", "時間をおいて再度お試しください。");
  if (!id || !token || !/^[\w-]{6,64}$/.test(id) || !/^[\w-]{16,128}$/.test(token)) {
    return fail("お問い合わせが見つかりません", "リンクが正しくないか、有効期限が切れています。メールに記載のリンクから開き直してください。");
  }
  try {
    const data = await call("ticketGet", { id, token });
    shell();
    apply(data, true);
  } catch (e) {
    console.error(e);
    return fail("お問い合わせを開けませんでした", esc(errText(e)));
  }
  pollTimer = setInterval(refresh, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.addEventListener("focus", refresh);
}

window.addEventListener("hashchange", () => location.reload());
start();
