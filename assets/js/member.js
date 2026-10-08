// ============================================================
//  会員サイト（member.html）の画面処理
// ============================================================
import {
  onAuth, logout, resetPassword, getMember, updateProfile, getMemberNews, getMemberDocs,
  getEvents, getMyRsvps, rsvp, errorMessage, MEMBER_TYPES, STATUS_LABEL, OCCUPATIONS, saveCardSignature, eventRsvpState,
  requestSignatureRewrite, canChangeEmail, requestEmailChange, syncMemberEmail,
  requestTypeChange, cancelTypeChange, compressImage
} from "./member-api.js";
import { esc, isDemo, app } from "./db.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { memberCardHtml, bindCard, printSheetHtml, qrSvg, verifyUrl } from "./card.js";
import { renderRich, htmlToText } from "./rich-view.js";
import { docFileUrl, kindOf, KIND_LABEL, extOf, fmtSize } from "./doc-files.js";
import { listMemberForms, listMySignatures } from "./consent-core.js";
import { docBoxHtml, fillDoc, signFormHtml, bindSignForm, receiptHtml, bindReceipt, isPastDeadline, fmtDateTime, padHtml, mountPad } from "./consent-ui.js";
import * as Poll from "./poll-ui.js";
import { mfaGate, openMfaSettings, getMfaStatus, MFA_METHOD_LABEL } from "./mfa.js";

// ---------- アイコン ----------
const I = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sign: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  vote: '<path d="M9 12l2 2 4-4"/><path d="M5 7h14l2 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8z"/><path d="M8 7V4h8v3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
};
const icon = (name, sw = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;

// ---------- メニュー（★項目の追加・並べ替えはここ） ----------
const ROUTES = [
  { id: "dashboard", label: "会員専用サイト", short: "ホーム", icon: "home", render: renderDashboard },
  { id: "news", label: "会員向けお知らせ", short: "お知らせ", icon: "bell", render: renderNews },
  { id: "events", label: "行事・参加登録", short: "行事", icon: "cal", render: renderEvents },
  { id: "docs", label: "会員限定資料室", short: "資料室", icon: "book", render: renderDocs },
  { id: "consent", label: "同意書・電子署名", short: "同意書", icon: "sign", render: renderConsent },
  { id: "votes", label: "投票・アンケート", short: "投票", icon: "vote", render: renderVotes },
  { id: "card", label: "デジタル会員証", short: "会員証", icon: "card", render: renderCard },
  { id: "profile", label: "プロフィール設定", short: "設定", icon: "user", render: renderProfile }
];

/** ID でメニューの項目を取り出す（並べ替えても壊れないように） */
const routeOf = (id) => ROUTES.find(r => r.id === id);
// スマホの下のメニューに出す画面（残りは「その他」のシートから）
const TABBAR = ["dashboard", "news", "events", "card"];

// ---------- 状態 ----------
const $ = (id) => document.getElementById(id);
const state = { user: null, member: null, news: null, docs: null, events: null, rsvps: new Set(), consentForms: null, mySigs: null, polls: null, pollVotes: {}, pollReceipts: {}, route: "dashboard", errors: {} };
const today = () => new Date().toISOString().slice(0, 10);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// ---------- 日付ユーティリティ ----------
const toDate = (v) => v?.toDate ? v.toDate() : v ? new Date(v) : null;
const ymd = (v) => { const d = toDate(v); return d && !isNaN(d) ? `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}` : "—"; };
const isNew = (date) => date && (Date.now() - new Date(date)) / 864e5 <= 14;
const daysLeft = (date) => date ? Math.ceil((new Date(date + "T23:59:59") - Date.now()) / 864e5) : null;

// ============================================================
//  起動
// ============================================================
onAuth(async (user) => {
  if (isDemo) return gate("setup");
  if (!user) return location.replace("member-login.html");
  // 2 段階認証を設定している人は、コードを確認してから（確認前は会員の情報を読めない）
  if (!(await mfaGate(user))) return;
  state.user = user;
  try {
    state.member = await getMember(user.uid);
  } catch (e) {
    console.error(e);
    return gate("error", errorMessage(e));
  }
  if (!state.member) return gate("none");
  if (state.member.status === "pending") return gate("pending");
  if (state.member.status === "rejected") return gate("rejected");
  if (state.member.status !== "active") return gate("suspended");
  // メールアドレスを変更した直後（確認リンクを開いた後）は、会員データのアドレスも合わせる
  try { if (await syncMemberEmail(user, state.member)) setTimeout(() => toast("メールアドレスの変更を反映しました"), 800); }
  catch (e) { console.warn("メールアドレスを会員データに反映できませんでした", e); }
  startPortal();
  ensureCardToken();
});

// 会員証のQRコード用の番号が無い会員（この機能より前に承認された方など）は、サーバーで発行してもらう
async function ensureCardToken() {
  const m = state.member;
  if (m.cardToken || !m.memberNo) return;
  try {
    const fn = httpsCallable(getFunctions(app, "asia-northeast1"), "ensureCardToken");
    const { data } = await fn();
    if (!data?.cardToken) return;
    m.cardToken = data.cardToken;
    if (state.route === "card" || state.route === "dashboard") rerender();
  } catch (e) { console.warn("会員証のQRコード番号を発行できませんでした", e); }
}

function hideBoot() { $("boot").classList.add("hide"); setTimeout(() => $("boot").remove(), 600); }

// 審査中・停止中などの画面
function gate(kind, detail = "") {
  hideBoot();
  const m = state.member;
  const views = {
    pending: `<p class="eyebrow">Under Review</p><h1>ただいま審査中です</h1>
      <p>${esc(m?.name || "")} 様、ご入会のお申込みありがとうございます。<br>本会は<strong style="color:var(--gold-light)">委員会承認制</strong>です。委員会で内容を確認しております。<br>承認されると、このページから会員サイトをご利用いただけます。</p>
      <ol class="timeline">
        <li class="done">お申込み受付<br><small>${ymd(m?.createdAt)}</small></li>
        <li class="now">委員会による審査・承認</li>
        <li>会員サイト利用開始</li>
      </ol>`,
    rejected: `<p class="eyebrow">Application Result</p><h1>入会のご承認に至りませんでした</h1><p>このたびはお申込みいただきありがとうございました。<br>委員会で審査いたしましたが、今回はご入会の承認に至りませんでした。<br>ご不明な点は委員会までお問い合わせください。</p>
      <p><a class="lux-btn ghost" href="contact.html">お問い合わせ</a></p>`,
    suspended: `<p class="eyebrow">Suspended</p><h1>会員資格が停止されています</h1><p>詳しくは委員会までお問い合わせください。</p>`,
    none: `<p class="eyebrow">Not a member</p><h1>会員登録が見つかりません</h1><p>このアカウントには会員情報が登録されていません。<br>入会をご希望の方は入会案内からお申込みください。</p>
      <p><a class="lux-btn" href="apply.html">入会を申し込む</a>　<a class="lux-btn ghost" href="join.html">入会案内</a></p>`,
    setup: `<p class="eyebrow">Setup</p><h1>Firebase が未設定です</h1><p>assets/js/firebase-config.js を設定してください。</p>`,
    error: `<p class="eyebrow">Error</p><h1>読み込みに失敗しました</h1><p>${esc(detail)}</p><p><button class="lux-btn" onclick="location.reload()">再読み込み</button></p>`
  };
  $("gate").innerHTML = `<div class="gate"><div class="gate-box">
    <img src="LOGO.png" alt="">${views[kind]}
    <p style="margin-top:28px"><a href="index.html" style="color:var(--gold-light)">公式サイトへ</a>
    ${kind !== "setup" ? `　|　<button class="link-btn" data-action="logout">ログアウト</button>` : ""}</p>
  </div></div>`;
  $("gate").hidden = false;
}

async function startPortal() {
  const m = state.member;
  // サイドバー・タブバー
  $("side-nav").innerHTML = ROUTES.map((r, i) =>
    `<li><a href="#${r.id}" data-route="${r.id}">${icon(r.icon)}${r.label}<span class="badge" data-badge="${r.id}" hidden></span></a></li>`).join("");
  $("tabbar").innerHTML = ROUTES.filter(r => TABBAR.includes(r.id)).map(r =>
    `<a href="#${r.id}" data-route="${r.id}">${icon(r.icon)}${r.short}<span class="badge tab-badge" data-badge="${r.id}" hidden></span></a>`).join("") +
    `<button type="button" class="tab-more" id="tab-more" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>その他<span class="badge tab-badge" id="more-badge" hidden></span></button>`;
  $("more-list").innerHTML = ROUTES.filter(r => !TABBAR.includes(r.id)).map(r =>
    `<li><a href="#${r.id}" data-route="${r.id}">${icon(r.icon)}<span>${r.label}</span><span class="badge" data-badge="${r.id}" hidden></span></a></li>`).join("") +
    `<li class="more-sep"><a href="index.html"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>公式サイトへ</span></a></li>
     <li><a href="#" data-action="logout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg><span>ログアウト</span></a></li>`;
  $("tab-more").addEventListener("click", () => toggleMore(true));
  fillMe();
  $("portal").hidden = false;
  hideBoot();

  window.addEventListener("hashchange", route);
  route();

  // データをまとめて読み込み（読み込み中はスケルトン表示）
  const load = async (key, fn) => {
    try { state[key] = await fn(); } catch (e) { console.error(e); state[key] = []; state.errors[key] = errorMessage(e); }
    updateBadges();
  };
  await Promise.all([
    load("news", getMemberNews),
    load("docs", getMemberDocs),
    load("events", getEvents),
    getMyRsvps(m.id).then(s => state.rsvps = s).catch(console.error),
    loadConsent().then(updateBadges),
    loadVotes().then(updateBadges)
  ]);
  updateBadges();
  rerender();
  if (state.route === "news") markNewsSeen();
  // 開いている間も新しいお知らせ・同意書を確認（5 分ごと・タブに戻ったとき）
  setInterval(refreshBadgeData, 300_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshBadgeData(); });
}
let lastBadgeRefresh = Date.now();
async function refreshBadgeData() {
  if (Date.now() - lastBadgeRefresh < 60_000) return;
  lastBadgeRefresh = Date.now();
  try {
    const news = await getMemberNews();
    const changed = JSON.stringify(news.map(n => n.id)) !== JSON.stringify((state.news || []).map(n => n.id));
    state.news = news;
    await loadConsent();
    await loadVotes({ background: true });
    updateBadges();
    if (changed && ["dashboard", "news"].includes(state.route)) rerender();
  } catch (e) { console.warn(e); }
}

function fillMe() {
  const m = state.member;
  $("me-avatar").textContent = (m.name || "?").trim().charAt(0);
  $("me-name").textContent = `${m.name} 様`;
  $("me-type").textContent = MEMBER_TYPES[m.type]?.label || "";
  $("more-avatar").textContent = $("me-avatar").textContent;
  $("more-name").textContent = $("me-name").textContent;
  $("more-type").textContent = $("me-type").textContent;
}

// ---------- スマホ：「その他」のシート ----------
function toggleMore(open) {
  const s = $("more-sheet");
  if (open === s.hidden) s.hidden = !open; else return;
  document.body.classList.toggle("more-open", open);
  $("tab-more")?.classList.toggle("is-active", open || !TABBAR.includes(state.route));
}
$("more-sheet").addEventListener("click", e => { if (e.target.id === "more-sheet" || e.target.closest("a")) toggleMore(false); });
addEventListener("keydown", e => { if (e.key === "Escape") toggleMore(false); });

// ---------- ルーティング ----------
function route() {
  const id = location.hash.slice(1).split("/")[0];
  const r = ROUTES.find(x => x.id === id) || ROUTES[0];
  state.route = r.id;
  document.querySelectorAll("[data-route]").forEach(a => {
    const on = a.dataset.route === r.id;
    a.classList.toggle("is-active", on);
    on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  });
  toggleMore(false);
  $("tab-more")?.classList.toggle("is-active", !TABBAR.includes(r.id));
  $("view-title").textContent = r.label;
  document.title = r.id === "dashboard" ? "会員専用サイト｜普賢アーカイブ運営委員会" : `${r.label}｜会員サイト｜普賢アーカイブ運営委員会`;
  rerender();
  window.scrollTo({ top: 0, behavior: "instant" });
  if (r.id === "news") markNewsSeen();
}

function rerender() {
  const r = ROUTES.find(x => x.id === state.route);
  const view = $("view");
  view.style.animation = "none"; void view.offsetWidth; view.style.animation = "";
  view.innerHTML = r.render();
  r.after?.();
}

// ---------- 未読バッジ ----------
const seenKey = () => `fugen-news-seen-${state.member.id}`;
function unreadCount() {
  const seen = store.get(seenKey(), "");
  return (state.news || []).filter(n => (n.date || "") > seen).length;
}
function markNewsSeen() {
  if (!state.news?.length) return;
  store.set(seenKey(), state.news[0].date || today());
  updateBadges();
}
function updateBadges() {
  const n = unreadCount();
  document.querySelectorAll('[data-badge="news"]').forEach(b => { b.hidden = !n; b.textContent = n; });
  const c = todoForms().length;
  document.querySelectorAll('[data-badge="consent"]').forEach(b => { b.hidden = !c; b.textContent = c; });
  const v = Poll.todoCount(state);
  document.querySelectorAll('[data-badge="votes"]').forEach(b => { b.hidden = !v; b.textContent = v; });
  // 「その他」のボタンには、シートの中にある項目の合計を表示
  const more = { news: n, consent: c, votes: v };
  const total = ROUTES.filter(r => !TABBAR.includes(r.id)).reduce((s, r) => s + (more[r.id] || 0), 0);
  const mb = $("more-badge");
  if (mb) { mb.hidden = !total; mb.textContent = total > 99 ? "99+" : total; }
}

// ============================================================
//  画面：ダッシュボード
// ============================================================
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? ["Good Evening", "こんばんは"] : h < 11 ? ["Good Morning", "おはようございます"] : h < 18 ? ["Good Afternoon", "こんにちは"] : ["Good Evening", "こんばんは"];
}
const skelRows = (n = 3) => Array.from({ length: n }, () => `<li class="row-item"><div class="skel" style="width:84px;height:18px"></div><div class="t"><div class="skel" style="height:18px;width:80%"></div></div></li>`).join("");
const emptyState = (msg, ic = "inbox") => `<div class="empty-state">${icon(ic, 1.2)}<div>${esc(msg)}</div></div>`;

function renderDashboard() {
  const m = state.member;
  const [en, ja] = greeting();
  const upcoming = (state.events || []).filter(e => e.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
  const left = daysLeft(m.validUntil);
  const unread = unreadCount();
  return `
  <section class="welcome">
    <div>
      <div class="greet">${en}</div>
      <h2>${ja}<span class="pc-only">、</span><span class="sp-only">。<br></span>${esc(m.name)} 様</h2>
      <p>会員番号 ${esc(m.memberNo || "—")}　／　入会日 ${ymd(m.approvedAt)}
        ${left !== null && left <= 60 ? `<span class="pill imp">有効期限まであと${left}日</span>` : ""}</p>
    </div>
    <a class="mini-card" href="#card" aria-label="会員証を表示">${cardHtml(true)}</a>
  </section>
  ${todoForms().length ? `<a class="notice-bar" href="#consent">${icon("sign")}<span>署名が必要な同意書が <b>${todoForms().length} 件</b> あります</span><span>確認する →</span></a>` : ""}
  ${Poll.todoCount(state) ? `<a class="notice-bar" href="#votes">${icon("vote")}<span>受付中の投票・アンケートが <b>${Poll.todoCount(state)} 件</b> あります</span><span>投票する →</span></a>` : ""}

  <div class="quick">
    <a href="#news"><span class="ico">${icon("bell")}</span><strong>お知らせ</strong><small>${state.news ? (unread ? `未読 ${unread} 件` : "すべて既読") : "読み込み中…"}</small></a>
    <a href="#events"><span class="ico">${icon("cal")}</span><strong>行事・参加登録</strong><small>${state.events ? `今後の予定 ${upcoming.length} 件` : "読み込み中…"}</small></a>
    <a href="#docs"><span class="ico">${icon("book")}</span><strong>資料室</strong><small>${state.docs ? `${state.docs.length} 件の資料` : "読み込み中…"}</small></a>
    <a href="#profile"><span class="ico">${icon("user")}</span><strong>プロフィール</strong><small>登録情報の確認・変更</small></a>
  </div>

  <div class="dash-grid">
    <section class="panel">
      <div class="panel-head"><h3>最新のお知らせ</h3><a href="#news">すべて見る →</a></div>
      <ul class="rows">${!state.news ? skelRows() : state.news.length ? state.news.slice(0, 4).map(n => `
        <li class="row-item"><time>${ymd(n.date)}</time><div class="t"><strong><a href="#news/${esc(n.id)}" style="color:inherit;text-decoration:none">${esc(n.title)}</a>
          ${n.important ? '<span class="pill imp">重要</span>' : ""}${isNew(n.date) ? '<span class="pill new">NEW</span>' : ""}</strong></div></li>`).join("")
        : `<li>${emptyState("お知らせはまだありません", "bell")}</li>`}</ul>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>次の行事</h3><a href="#events">すべて見る →</a></div>
      <ul class="rows">${!state.events ? skelRows() : upcoming.length ? upcoming.slice(0, 3).map(e => `
        <li class="row-item"><time>${ymd(e.date).slice(5)}</time><div class="t"><strong>${esc(e.title)}</strong>
          <p>${e.place ? esc(e.place) + "　" : ""}${state.rsvps.has(e.id) ? '<span class="pill ok" style="margin:0">参加登録済み</span>' : ""}</p></div></li>`).join("")
        : `<li>${emptyState("予定されている行事はありません", "cal")}</li>`}</ul>
    </section>
  </div>

  <section class="panel" style="margin-top:24px">
    <div class="panel-head"><h3>新着資料</h3><a href="#docs">資料室へ →</a></div>
    ${!state.docs ? `<ul class="rows">${skelRows(2)}</ul>` : state.docs.length
      ? `<div class="docs grid">${state.docs.slice(0, 4).map(docHtml).join("")}</div>`
      : emptyState("資料はまだありません", "book")}
  </section>`;
}

// ============================================================
//  画面：お知らせ
// ============================================================
routeOf("news").after = () => {
  const id = location.hash.split("/")[1];
  // 記事を開いているとき：本文（装飾つき HTML は安全な形にしてから）を表示
  if (id) {
    const n = state.news?.find(x => x.id === id);
    const el = document.querySelector(".news-article [data-body]");
    if (n && el) renderRich(el, n);
    return;
  }
  const q = $("news-q");
  // 絞り込み（すべて／重要／新着）と検索
  const apply = () => {
    const v = (q?.value || "").trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll(".news-list li").forEach(d => {
      const hit = (!v || d.dataset.text.includes(v)) && (newsFilter === "all" || d.dataset[newsFilter] === "1");
      d.hidden = !hit; if (hit) shown++;
    });
    const none = $("news-none");
    if (none) none.hidden = shown > 0 || !state.news?.length;
  };
  q?.addEventListener("input", apply);
  document.querySelectorAll("[data-nf]").forEach(b => b.addEventListener("click", () => {
    newsFilter = b.dataset.nf;
    document.querySelectorAll("[data-nf]").forEach(x => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-selected", x === b); });
    apply();
  }));
  apply();
};
let newsFilter = "all";
const newsMeta = (n) => `<span class="na-meta"><time>${ymd(n.date)}</time>${n.important ? '<span class="pill imp">重要</span>' : ""}${isNew(n.date) ? '<span class="pill new">NEW</span>' : ""}</span>`;
function renderNews() {
  if (!state.news) return `<div class="news-list">${Array.from({ length: 4 }, () => '<div class="skel" style="height:64px;margin-bottom:12px;border-radius:16px"></div>').join("")}</div>`;
  if (state.errors.news) return emptyState(state.errors.news);
  const back = `<a class="consent-back" href="#news">← お知らせの一覧へ</a>`;
  const id = location.hash.split("/")[1];
  // 1 件の記事
  if (id) {
    const n = state.news.find(x => x.id === id);
    if (!n) return `${back}${emptyState("このお知らせは見つかりませんでした", "bell")}`;
    return `${back}
    <article class="panel news-article">
      ${newsMeta(n)}
      <h2 class="news-title">${esc(n.title)}</h2>
      <div class="body" data-body="${esc(n.id)}"></div>
    </article>`;
  }
  if (!state.news.length) return emptyState("会員向けのお知らせはまだありません", "bell");
  const count = { all: state.news.length, imp: state.news.filter(n => n.important).length, new: state.news.filter(n => isNew(n.date)).length };
  const tab = (k, l) => `<button type="button" role="tab" data-nf="${k}" aria-selected="${newsFilter === k}" class="${newsFilter === k ? "is-active" : ""}">${l}<span>${count[k]}</span></button>`;
  return `
  <div class="ev-tabs" role="tablist" aria-label="お知らせの絞り込み">${tab("all", "すべて")}${tab("imp", "重要")}${tab("new", "新着")}</div>
  <div class="toolbar"><label class="search">${icon("search", 2)}<input id="news-q" type="search" placeholder="お知らせを検索（/ キーで移動）" aria-label="お知らせを検索"></label></div>
  <ul class="news-list">${state.news.map(n => `
    <li data-imp="${n.important ? 1 : 0}" data-new="${isNew(n.date) ? 1 : 0}" data-text="${esc(`${n.title} ${n.body || htmlToText(n.bodyHtml)}`.toLowerCase())}">
      <a href="#news/${esc(n.id)}">${newsMeta(n)}<span class="ttl">${esc(n.title)}</span><span class="na-chev" aria-hidden="true"></span></a>
    </li>`).join("")}</ul>
  <div id="news-none" hidden>${emptyState("該当するお知らせはありません", "search")}</div>`;
}

// ============================================================
//  画面：行事・参加登録
// ============================================================
let evFilter = "upcoming";
routeOf("events").after = () => {
  // 内容（装飾つき HTML は安全な形にしてから）を表示
  document.querySelectorAll("[data-ev-body]").forEach(el => {
    const ev = (state.events || []).find(x => x.id === el.dataset.evBody);
    if (ev?.bodyHtml) renderRich(el, ev);
  });
  document.querySelectorAll("[data-evf]").forEach(b => b.addEventListener("click", () => { evFilter = b.dataset.evf; rerender(); }));
  document.querySelectorAll("[data-rsvp]").forEach(b => b.addEventListener("click", () => toggleRsvp(b)));
};
function renderEvents() {
  if (!state.events) return `<div class="events">${Array.from({ length: 3 }, () => '<div class="skel" style="height:220px;border-radius:22px"></div>').join("")}</div>`;
  if (state.errors.events) return emptyState(state.errors.events);
  const t = today();
  const all = state.events;
  const sets = {
    upcoming: all.filter(e => e.date >= t).sort((a, b) => a.date.localeCompare(b.date)),
    mine: all.filter(e => state.rsvps.has(e.id)).sort((a, b) => a.date.localeCompare(b.date)),
    past: all.filter(e => e.date < t)
  };
  const rows = sets[evFilter];
  const tab = (k, l) => `<button type="button" role="tab" data-evf="${k}" aria-selected="${evFilter === k}" class="${evFilter === k ? "is-active" : ""}">${l}<span>${sets[k].length}</span></button>`;
  const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  return `
  <div class="ev-tabs" role="tablist" aria-label="行事の絞り込み">${tab("upcoming", "今後の予定")}${tab("mine", "参加登録済み")}${tab("past", "過去の行事")}</div>
  ${rows.length ? `<div class="events">${rows.map(e => {
    const d = new Date(e.date + "T00:00:00");
    const past = e.date < t;
    const on = state.rsvps.has(e.id);
    const rs = eventRsvpState(e, t);
    const time = e.startTime ? `　${esc(e.startTime)}${e.endTime ? "〜" + esc(e.endTime) : ""}` : "";
    return `<article class="ev${past ? " is-past" : ""}">
      <div class="ev-top">
        <div class="ev-date"><div class="m">${d.getMonth() + 1}月</div><div class="d">${d.getDate()}</div><div class="y">${WEEK[d.getDay()]}曜日</div></div>
        <div class="ev-head"><h4>${esc(e.title)}</h4>
          <div class="meta">${icon("cal")}${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）${time}</div>
          ${e.place ? `<div class="meta">${icon("pin")}${esc(e.place)}</div>` : ""}
          ${!past && e.rsvpOpen !== false ? `<div class="ev-cap">${rs.label ? `<span class="ev-badge ${rs.open ? "ok" : "ng"}">${rs.label}</span>` : ""}${rs.cap ? `<span>定員 ${rs.cap} 名・残り <b>${rs.remaining}</b> 名</span>` : "<span>定員なし</span>"}${e.rsvpDeadline ? `<span>締切 ${esc(e.rsvpDeadline.replace(/-/g, "/"))}</span>` : ""}</div>` : ""}</div>
      </div>
      <div class="desc rich-body" data-ev-body="${esc(e.id)}">${e.bodyHtml ? "" : esc(e.description || "")}</div>
      ${on || past ? `<div class="ev-status${on ? " on" : ""}">${past ? (on ? "✓ この行事に参加しました" : "この行事は終了しました") : "✓ 参加登録済みです"}</div>` : ""}
      ${evActions(e, past, on)}
    </article>`;
  }).join("")}</div>` : emptyState(evFilter === "mine" ? "参加登録した行事はありません" : "該当する行事はありません", "cal")}`;
}

// 行事カードの下のボタン（詳細・参加登録・取り消し）。ボタンが無いときは何も出さない
function evActions(e, past, on) {
  const rs = eventRsvpState(e, today());
  const btns = [
    e.url ? `<a class="lux-btn ghost" href="${esc(e.url)}" target="_blank" rel="noopener">詳細を見る ${icon("ext")}</a>` : "",
    past || e.rsvpOpen === false ? "" : on
      ? `<button type="button" class="lux-btn ghost ev-cancel" data-rsvp="${esc(e.id)}">登録を取り消す</button>`
      : rs.open ? `<button type="button" class="lux-btn" data-rsvp="${esc(e.id)}">参加登録する</button>`
      : `<button type="button" class="lux-btn" disabled>${esc(rs.label === "満員" ? "満員のため受付終了" : "受付は終了しました")}</button>`
  ].filter(Boolean);
  return btns.length ? `<div class="ev-actions">${btns.join("")}</div>` : '<div class="ev-pad"></div>';
}

async function toggleRsvp(btn) {
  const id = btn.dataset.rsvp;
  const join = !state.rsvps.has(id);
  const ev = state.events.find(e => e.id === id);
  if (!join && !window.confirm(`「${ev.title}」の参加登録を取り消します。よろしいですか？`)) return;
  btn.disabled = true;
  // 先に表示を切り替えて、失敗したら戻す
  join ? state.rsvps.add(id) : state.rsvps.delete(id);
  rerender();
  try {
    const res = await rsvp(id, state.member, join);
    ev.rsvpCount = res.count;
    rerender();
    toast(join ? `「${ev.title}」に参加登録しました。確認メールをお送りしました` : `「${ev.title}」の参加登録を取り消しました`);
  } catch (e) {
    console.error(e);
    join ? state.rsvps.delete(id) : state.rsvps.add(id);
    rerender();
    toast(errorMessage(e), true);
  }
}

// ============================================================
//  画面：資料室
// ============================================================
let docCat = "";
routeOf("docs").after = () => {
  const q = $("doc-q");
  const draw = () => {
    const v = (q?.value || "").trim().toLowerCase();
    const rows = (state.docs || []).filter(d => (!docCat || d.category === docCat) &&
      (!v || `${d.title} ${d.description || ""} ${d.category || ""}`.toLowerCase().includes(v)));
    const box = $("doc-box");
    if (!box) return;
    box.className = `docs ${store.get("fugen-doc-view", "grid")}`;
    box.innerHTML = rows.length ? rows.map(docHtml).join("") : emptyState("該当する資料はありません", "search");
    $("doc-count").textContent = `${rows.length} 件`;
  };
  q?.addEventListener("input", draw);
  // アップロードされたファイルを開く（動画・音声・画像はこの画面で再生・表示、PDF は新しいタブ、その他はダウンロード）
  $("doc-box")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-doc]");
    if (!b) return;
    const d = (state.docs || []).find(x => x.id === b.dataset.doc);
    if (d) openDocFile(d);
  });
  document.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", () => {
    docCat = b.dataset.cat;
    document.querySelectorAll("[data-cat]").forEach(x => x.classList.toggle("is-active", x === b));
    draw();
  }));
  document.querySelectorAll("[data-docview]").forEach(b => b.addEventListener("click", () => {
    store.set("fugen-doc-view", b.dataset.docview);
    document.querySelectorAll("[data-docview]").forEach(x => x.classList.toggle("is-active", x === b));
    draw();
  }));
  draw();
};
function fileLabel(url = "") {
  const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toUpperCase() : "LINK";
}
const DOC_ACTION = { video: "再生", audio: "再生", image: "表示", pdf: "開く", file: "ダウンロード" };
function docHtml(d) {
  if (d.filePath) {
    const kind = kindOf(d.fileType, d.fileName);
    return `<button type="button" class="doc doc-file k-${kind}" data-doc="${esc(d.id)}">
    <div class="file">${esc(extOf(d.fileName))}</div>
    <h4>${esc(d.title)}${isNew(d.date) ? ' <span class="pill new">NEW</span>' : ""}</h4>
    <p>${esc(d.description || "")}</p>
    <div class="foot"><span>${d.category ? esc(d.category) + "・" : ""}${ymd(d.date)}・${esc(KIND_LABEL[kind])} ${esc(fmtSize(d.fileSize))}</span><span class="open">${DOC_ACTION[kind]}</span></div>
  </button>`;
  }
  return `<a class="doc" href="${esc(d.url || "#")}" ${d.url ? 'target="_blank" rel="noopener"' : ""}>
    <div class="file">${esc(fileLabel(d.url))}</div>
    <h4>${esc(d.title)}${isNew(d.date) ? ' <span class="pill new">NEW</span>' : ""}</h4>
    <p>${esc(d.description || "")}</p>
    <div class="foot"><span>${d.category ? esc(d.category) + "・" : ""}${ymd(d.date)}</span><span class="open">開く ${icon("ext")}</span></div>
  </a>`;
}
// アップロードされた資料を開く
async function openDocFile(d) {
  const kind = kindOf(d.fileType, d.fileName);
  // PDF・その他は新しいタブで（ポップアップと判定されないよう、先にタブを開いておく）
  if (kind === "pdf" || kind === "file") {
    const w = window.open("", "_blank");
    try { const url = await docFileUrl(d.filePath); if (w) w.location = url; else location.href = url; }
    catch (err) { console.error(err); w?.close(); toast("資料を開けませんでした。時間をおいてお試しください", true); }
    return;
  }
  const dlg = document.createElement("dialog");
  dlg.className = "doc-viewer";
  dlg.innerHTML = `<div class="dv-head"><div><b>${esc(d.title)}</b><small>${esc(KIND_LABEL[kind])}・${esc(fmtSize(d.fileSize))}</small></div>
      <button type="button" class="dv-close" aria-label="閉じる">×</button></div>
    <div class="dv-body"><p class="dv-loading">読み込み中…</p></div>
    ${d.description ? `<p class="dv-desc">${esc(d.description)}</p>` : ""}`;
  document.body.appendChild(dlg);
  const close = () => { dlg.querySelectorAll("video, audio").forEach(m => m.pause()); dlg.close(); };
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", e => { if (e.target === dlg || e.target.closest(".dv-close")) close(); });
  dlg.showModal();
  try {
    const url = await docFileUrl(d.filePath);
    const body = dlg.querySelector(".dv-body");
    body.innerHTML = kind === "video" ? '<video controls playsinline preload="metadata"></video>'
      : kind === "audio" ? '<audio controls preload="metadata"></audio>' : `<img alt="${esc(d.title)}">`;
    body.firstElementChild.src = url;
    dlg.insertAdjacentHTML("beforeend", `<div class="dv-foot"><a class="lux-btn ghost sm" href="${esc(url)}" target="_blank" rel="noopener">新しいタブで開く</a></div>`);
  } catch (err) {
    console.error(err);
    dlg.querySelector(".dv-body").innerHTML = '<p class="dv-loading">資料を開けませんでした。時間をおいてお試しください。</p>';
  }
}
function renderDocs() {
  if (!state.docs) return `<div class="docs grid">${Array.from({ length: 6 }, () => '<div class="skel" style="height:200px;border-radius:20px"></div>').join("")}</div>`;
  if (state.errors.docs) return emptyState(state.errors.docs);
  if (!state.docs.length) return emptyState("資料はまだありません", "book");
  const cats = [...new Set(state.docs.map(d => d.category).filter(Boolean))];
  const view = store.get("fugen-doc-view", "grid");
  return `
  <div class="toolbar">
    <label class="search">${icon("search", 2)}<input id="doc-q" type="search" placeholder="資料を検索（/ キーで移動）" aria-label="資料を検索"></label>
    <div class="seg" role="group" aria-label="表示切替">
      <button data-docview="grid" class="${view === "grid" ? "is-active" : ""}" aria-label="カード表示">${icon("grid", 2)}</button>
      <button data-docview="list" class="${view === "list" ? "is-active" : ""}" aria-label="リスト表示">${icon("list", 2)}</button>
    </div>
  </div>
  <div class="toolbar">
    <div class="chips"><button data-cat="" class="${!docCat ? "is-active" : ""}">すべて</button>${cats.map(c => `<button data-cat="${esc(c)}" class="${docCat === c ? "is-active" : ""}">${esc(c)}</button>`).join("")}</div>
    <span id="doc-count" style="margin-left:auto;color:var(--muted);font-size:13px"></span>
  </div>
  <div id="doc-box" class="docs ${view}"></div>`;
}

// ============================================================
//  画面：デジタル会員証
// ============================================================
// 会員証のデザインは assets/js/card.js と assets/css/member.css の「会員証」で変更できます
const cardHtml = (mini = false) => memberCardHtml(state.member, { mini });
routeOf("card").after = () => {
  bindCard($("mcard"));
  $("print-card")?.addEventListener("click", printCard);
  $("scan-card")?.addEventListener("click", openScan);
  document.querySelectorAll("[data-card-sign]").forEach(b => b.addEventListener("click", openCardSign));
  document.querySelector("[data-sign-request]")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!window.confirm("会員証の署名の書き直しを申請します。管理者が許可すると、1 回だけ書き直せます。よろしいですか？")) return;
    b.disabled = true;
    try {
      await requestSignatureRewrite(state.member.id);
      state.member.signatureRewrite = "requested";
      rerender();
      toast("書き直しを申請しました。許可されるとメールでお知らせします");
    } catch (err) { console.error(err); toast(errorMessage(err), true); b.disabled = false; }
  });
};

// ============================================================
//  会員証の裏面の直筆署名（登録・書き直し）
// ============================================================
function openCardSign() {
  const dlg = document.createElement("dialog");
  dlg.className = "sig-dialog";
  dlg.innerHTML = `<form method="dialog">
      <h3>会員証の署名${state.member.cardSignature ? "（書き直し）" : ""}</h3>
      <p>枠の中に、指・マウス・ペンでお名前を手書きしてください。デジタル会員証の裏面（印刷にも）に表示されます。${state.member.cardSignature ? "<br><b>書き直しは 1 回のみです。</b>登録後にもう一度書き直すには、改めて申請が必要です。" : "登録後の書き直しには管理者の許可が必要です。"}</p>
      <div data-pad-box>${padHtml()}</div>
      <p class="sig-err" hidden>署名欄に署名してください</p>
      <div class="sig-actions">
        <button class="lux-btn ghost sm" value="cancel" type="submit">キャンセル</button>
        <button class="lux-btn sm" type="button" data-save>この署名で登録</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  const pad = mountPad(dlg.querySelector("[data-pad-box]"), p => { if (!p.isEmpty()) dlg.querySelector(".sig-err").hidden = true; });
  dlg.querySelector("[data-save]").addEventListener("click", async (e) => {
    if (pad.isEmpty()) { dlg.querySelector(".sig-err").hidden = false; return; }
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 保存中…';
    try {
      const image = pad.toDataURL();
      const rewrite = !!state.member.cardSignature;
      await saveCardSignature(state.member.id, image, { rewrite });
      state.member.cardSignature = image;
      if (rewrite) delete state.member.signatureRewrite;
      dlg.close();
      rerender();
      toast("会員証の署名を登録しました");
    } catch (err) {
      console.error(err);
      toast(errorMessage(err), true);
      btn.disabled = false; btn.textContent = "この署名で登録";
    }
  });
}

// ============================================================
//  スキャン用表示：受付などで読み取ってもらうため、QRコードと会員情報を画面いっぱいに表示
//  ・画面を最大の明るさにしやすいよう白背景、QRコードは大きく
//  ・偽造（画面のスクリーンショット）対策に、現在時刻を秒まで表示し動かす
//  ・可能なら画面が自動で消えないようにする（Wake Lock）
// ============================================================
let scanTimer = null, wakeLock = null;
async function openScan() {
  const m = state.member;
  const box = $("scan-view");
  const qr = qrSvg(verifyUrl(m));
  const left = daysLeft(m.validUntil);
  const expired = left !== null && left < 0;
  box.innerHTML = `
    <div class="scan-card">
      <div class="scan-top">
        <img src="LOGO.png" alt="">
        <div class="scan-org"><b>普賢アーカイブ運営委員会</b><span>MEMBERSHIP CARD</span></div>
        <button class="scan-close" type="button" aria-label="閉じる">×</button>
      </div>
      <div class="scan-qr-area"><div class="scan-qr">${qr || '<p class="scan-wait">QRコードを準備中です。<br>しばらくしてから開き直してください。</p>'}</div></div>
      <div class="scan-side">
        <div class="scan-status ${expired ? "ng" : "ok"}">${expired ? "有効期限切れ" : "✓ 有効な会員"}</div>
        <div class="scan-name">${esc(m.name)}<small> 様</small></div>
        <dl class="scan-info">
          <div><dt>会員番号</dt><dd>${esc(m.memberNo || "—")}</dd></div>
          <div><dt>会員種別</dt><dd>${esc(MEMBER_TYPES[m.type]?.label || "")}</dd></div>
          <div><dt>入会日</dt><dd>${ymd(m.approvedAt)}</dd></div>
          <div><dt>有効期限</dt><dd>${m.validUntil ? ymd(m.validUntil) : "期限なし"}</dd></div>
        </dl>
        <p class="scan-hint">QRコードを読み取ると会員資格を確認できます</p>
        <div class="scan-clock" aria-live="off"><span class="dot"></span><span id="scan-time"></span></div>
      </div>
    </div>`;
  box.hidden = false;
  document.body.classList.add("scan-open");
  const tick = () => { const t = $("scan-time"); if (t) t.textContent = new Date().toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
  tick(); clearInterval(scanTimer); scanTimer = setInterval(tick, 1000);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  box.focus();
}
function closeScan() {
  const box = $("scan-view");
  if (box.hidden) return;
  box.hidden = true; box.innerHTML = "";
  document.body.classList.remove("scan-open");
  clearInterval(scanTimer);
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  $("scan-card")?.focus();
}
$("scan-view").addEventListener("click", e => { if (e.target.closest(".scan-close") || e.target.id === "scan-view") closeScan(); });
addEventListener("keydown", e => { if (e.key === "Escape") closeScan(); });
addEventListener("hashchange", closeScan);
// 印刷：A4 専用のシートを body 直下に作って印刷（画面では見えない。次の印刷で作り直す）
// ※ スマホでも印刷できるよう、ボタンを押したらすぐ印刷する（待ってからだと印刷を受け付けないブラウザがある）
function printCard() {
  const m = state.member;
  document.getElementById("print-sheet")?.remove();
  const sheet = document.createElement("div");
  sheet.id = "print-sheet";
  sheet.innerHTML = printSheetHtml(m, {
    type: MEMBER_TYPES[m.type]?.label || "",
    since: ymd(m.approvedAt),
    until: m.validUntil ? ymd(m.validUntil) : "期限なし",
  });
  document.body.appendChild(sheet);
  window.print();
}
function renderCard() {
  const m = state.member;
  const left = daysLeft(m.validUntil);
  return `<div class="card-stage">
    ${cardHtml()}
    <p class="card-hint">カードを押すと裏面を表示します。表面のQRコードを読み取ると、会員資格を確認できます。</p>
    ${m.cardSignature ? "" : `<div class="sig-notice"><span>会員証の裏面の署名が未登録です。スマホなら指で直筆の署名を登録できます。</span><button class="lux-btn sm" type="button" data-card-sign>署名を登録する</button></div>`}
    <dl class="card-info">
      <div><dt>会員番号</dt><dd>${esc(m.memberNo || "—")}</dd></div>
      <div><dt>会員種別</dt><dd>${esc(MEMBER_TYPES[m.type]?.label || "")}</dd></div>
      <div><dt>入会日</dt><dd>${ymd(m.approvedAt)}</dd></div>
      <div><dt>有効期限</dt><dd>${m.validUntil ? ymd(m.validUntil) : "期限なし"}${left !== null ? `　<span class="pill ${left <= 60 ? "imp" : "ok"}">${left >= 0 ? `あと${left}日` : "期限切れ"}</span>` : ""}</dd></div>
    </dl>
    <div class="card-actions">
      <button class="lux-btn ca-main" id="scan-card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>スキャン用表示</button>
      <button class="lux-btn ghost" id="print-card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M6 14h12v7H6z"/></svg>印刷する</button>
      ${!m.cardSignature || m.signatureRewrite === "requested" ? ""
        : m.signatureRewrite === "allowed" ? '<button class="lux-btn ghost" type="button" data-card-sign><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>署名を書き直す</button>'
        : '<button class="lux-btn ghost" type="button" data-sign-request><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>署名変更を申請</button>'}
    </div>
    ${m.cardSignature && m.signatureRewrite === "requested" ? '<p class="sig-pending">署名の書き直しを申請中です（管理者の承認待ち）</p>' : ""}
    </div>
  </div>`;
}

// ============================================================
//  画面：同意書・電子署名
//   #consent              … 一覧（未署名を先頭に）
//   #consent/<同意書ID>     … 内容の確認と署名
//   #consent/<同意書ID>/receipt … 署名の控え
//  ※ 部品は consent-ui.js、ハッシュ計算・保存は consent-core.js
// ============================================================
async function loadConsent() {
  try {
    const [forms, sigs] = await Promise.all([listMemberForms(), listMySignatures(state.member.id)]);
    state.consentForms = forms;
    state.mySigs = Object.fromEntries(sigs.map(s => [s.formId, s]));
  } catch (e) {
    console.error(e);
    state.consentForms = []; state.mySigs = {};
    state.errors.consent = errorMessage(e);
  }
}
/** 署名が必要な同意書（未署名・期限内） */
const todoForms = () => (state.consentForms || []).filter(f => !state.mySigs?.[f.id] && !isPastDeadline(f));
const sigTime = (s) => s.agreedAt || s.clientSignedAt;
const memberSigner = () => ({ ...state.member, email: state.member.email || state.user.email });

routeOf("consent").after = () => {
  const [, formId, sub] = location.hash.slice(1).split("/");
  const box = $("consent-box");
  if (!box || !formId) return;
  const form = (state.consentForms || []).find(f => f.id === formId);
  const sig = state.mySigs?.[formId];
  if ((sub === "receipt" || !form) && sig) return bindReceipt(box, { id: `${formId}_${state.member.id}`, ...sig });
  if (form) {
    fillDoc(box, form);
    if (!sig && !isPastDeadline(form)) bindSignForm(box, form, {
      mode: "member", member: memberSigner(),
      onDone: (rec) => {
        state.mySigs[formId] = rec;
        updateBadges();
        toast(`「${form.title}」に署名しました`);
        location.hash = `consent/${formId}/receipt`;
      }
    });
  }
};
function renderConsent() {
  if (!state.consentForms) return `<div class="consent-list">${Array.from({ length: 3 }, () => '<div class="skel" style="height:84px;border-radius:16px"></div>').join("")}</div>`;
  if (state.errors.consent) return emptyState(state.errors.consent);
  const [, formId, sub] = location.hash.slice(1).split("/");
  const back = `<a class="consent-back" href="#consent">← 同意書の一覧へ</a>`;

  if (formId) {
    const form = state.consentForms.find(f => f.id === formId);
    const sig = state.mySigs[formId];
    // 控え
    if (sub === "receipt" || (sig && !form)) {
      if (!sig) return back + emptyState("署名の記録が見つかりません");
      return `<div class="consent-wrap" id="consent-box">${back}${receiptHtml({ id: `${formId}_${state.member.id}`, ...sig })}</div>`;
    }
    if (!form) return back + emptyState("この同意書は見つかりませんでした（受付が終了した可能性があります）");
    // 署名済み → 内容と控えへの案内
    if (sig) return `<div class="consent-wrap" id="consent-box">${back}<div class="alert ok">${esc(fmtDateTime(sigTime(sig)))} に署名済みです。<a href="#consent/${esc(formId)}/receipt">控えを見る →</a></div>${docBoxHtml(form)}</div>`;
    if (isPastDeadline(form)) return `<div class="consent-wrap" id="consent-box">${back}<div class="alert error">署名期限（${esc(form.deadline.replace(/-/g, "."))}）を過ぎたため、署名できません。委員会までお問い合わせください。</div>${docBoxHtml(form)}</div>`;
    return `<div class="consent-wrap" id="consent-box">${back}${docBoxHtml(form)}${signFormHtml(form, { mode: "member", member: memberSigner() })}</div>`;
  }

  // 一覧：公開中の同意書＋署名済みの記録（入会時の規約など、一覧に無いものも含む）
  const items = state.consentForms.map(f => ({ id: f.id, title: f.title, version: f.version, deadline: f.deadline, form: f, sig: state.mySigs[f.id] }));
  Object.values(state.mySigs).forEach(s => { if (!items.some(i => i.id === s.formId)) items.push({ id: s.formId, title: s.formTitle, version: s.formVersion, sig: s }); });
  if (!items.length) return emptyState("署名が必要な同意書はありません", "sign");
  const rank = (i) => i.sig ? 2 : i.form && isPastDeadline(i.form) ? 1 : 0;
  items.sort((a, b) => rank(a) - rank(b) || (b.sig ? (sigTime(b)?.toMillis?.() || 0) - (sigTime(a)?.toMillis?.() || 0) : 0));
  return `<p style="color:var(--muted);font-size:13px;margin:0 0 16px">委員会からの同意書です。内容をご確認のうえ、手書きで署名してください。署名は改ざんを検出できる形で記録され、控えはいつでもここから確認できます。</p>
  <div class="consent-list">${items.map(i => {
    const late = !i.sig && i.form && isPastDeadline(i.form);
    return `<div class="cf-item${!i.sig && !late ? " is-todo" : ""}">
      <span class="ico">${icon("sign")}</span>
      <div class="t"><h4>${esc(i.title)}${i.sig ? '<span class="pill ok">署名済み</span>' : late ? '<span class="pill">期限切れ</span>' : '<span class="pill imp">未署名</span>'}</h4>
        <p>第 ${esc(i.version || 1)} 版${i.sig ? `　／　${esc(fmtDateTime(sigTime(i.sig)))} 署名` : i.deadline ? `　／　署名期限 ${esc(i.deadline.replace(/-/g, "."))}` : ""}</p></div>
      ${i.sig ? `<a class="lux-btn ghost sm" href="#consent/${esc(i.id)}/receipt">控えを見る</a>`
        : late ? `<a class="lux-btn ghost sm" href="#consent/${esc(i.id)}">内容を見る</a>`
        : `<a class="lux-btn sm" href="#consent/${esc(i.id)}">署名する</a>`}
    </div>`;
  }).join("")}</div>`;
}

// ============================================================
//  画面：投票・アンケート（中身は poll-ui.js）
// ============================================================
async function loadVotes({ background = false } = {}) {
  try {
    const polls = await Poll.loadPolls(state.member);
    state.pollVotes = { ...(state.pollVotes || {}), ...(await Poll.loadMyVotes(polls)) };
    state.polls = polls;
    delete state.errors.votes;
  } catch (e) {
    console.error(e);
    state.polls = state.polls || [];
    state.errors.votes = errorMessage(e);
  }
  // 入力中の投票画面は書き換えない（定期更新のとき）
  const inPoll = state.route === "votes" && location.hash.split("/").length > 1;
  if ((state.route === "votes" || state.route === "dashboard") && !(background && inPoll)) rerender();
}
const pollCtx = () => ({ state, rerender, toast, icon, emptyState, updateBadges });
function renderVotes() { return Poll.render(pollCtx()); }
routeOf("votes").after = () => Poll.after(pollCtx());

// ============================================================
//  画面：プロフィール
// ============================================================
routeOf("profile").after = () => {
  const form = $("profile-form");
  const btn = $("save-btn");
  form.addEventListener("input", () => { btn.disabled = false; });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const f = form.elements;
    if (!f.name.value.trim()) { f.name.focus(); return toast("お名前を入力してください", true); }
    const data = {
      name: f.name.value.trim(), kana: f.kana.value.trim(), occupation: f.occupation.value, affiliation: f.affiliation.value.trim(),
      newsletter: f.newsletter.checked
    };
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 保存中…';
    try {
      await updateProfile(state.member.id, data);
      Object.assign(state.member, data);
      fillMe();
      toast("プロフィールを保存しました");
      btn.textContent = "変更を保存";
    } catch (err) {
      console.error(err);
      toast(errorMessage(err), true);
      btn.disabled = false; btn.textContent = "変更を保存";
    }
  });
  $("email-change")?.addEventListener("click", openEmailChange);
  $("type-open")?.addEventListener("click", openTypeChange);
  $("type-cancel")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!window.confirm("会員種別の変更の申請を取り消します。よろしいですか？")) return;
    b.disabled = true;
    try {
      await cancelTypeChange(state.member.id, state.member.typeRequest === "student");
      delete state.member.typeRequest; delete state.member.typeRequestReason; delete state.member.typeRequestAt; delete state.member.typeRequestStudentNo;
      rerender(); toast("申請を取り消しました");
    } catch (err) { console.error(err); toast(errorMessage(err), true); b.disabled = false; }
  });
  // 2 段階認証：状態を表示し、ボタンで設定画面を開く（閉じたら表示を更新）
  const showMfa = async () => {
    const el = $("mfa-state"), btn = $("mfa-settings");
    if (!el) return;
    try {
      const st = await getMfaStatus();
      el.textContent = st.enabled ? `設定済み（${MFA_METHOD_LABEL[st.method] || st.method}）` : "未設定";
      el.classList.toggle("is-on", st.enabled);
      btn.textContent = st.enabled ? "2段階認証の確認・解除" : "2段階認証を設定する";
    } catch (err) { console.warn(err); el.textContent = "—"; }
  };
  showMfa();
  $("mfa-settings").addEventListener("click", () => openMfaSettings({ onClose: showMfa }));
  $("pw-reset").addEventListener("click", async () => {
    try { await resetPassword(state.member.email || state.user.email); toast("パスワード再設定メールを送信しました"); }
    catch (err) { console.error(err); toast(errorMessage(err), true); }
  });
};
// 会員種別の変更を申請（学生会員へ変更する場合は学生証の画像か学籍番号も）
function openTypeChange() {
  const m = state.member;
  const options = Object.entries(MEMBER_TYPES).filter(([k]) => k !== m.type);
  const dlg = document.createElement("dialog");
  dlg.className = "sig-dialog";
  dlg.innerHTML = `<form novalidate>
      <h3>会員種別の変更を申請</h3>
      <p>現在の会員種別は「${esc(MEMBER_TYPES[m.type]?.label || m.type)}」です。委員会の承認後に変更されます。</p>
      <div class="field"><label>変更後の会員種別</label>
        <div class="type-choice">${options.map(([k, v], i) => `<label><input type="radio" name="newType" value="${k}"${i === 0 ? " checked" : ""}><span>${esc(v.label)}</span></label>`).join("")}</div></div>
      <div class="field"><label for="tc-reason">変更の理由</label><textarea id="tc-reason" maxlength="500" placeholder="例：大学に入学したため／卒業して就職したため"></textarea></div>
      <div class="field" id="tc-sid" hidden>
        <p class="sid-lead">学生の確認のため、<strong>学生証の画像</strong>か<strong>学籍番号</strong>のどちらかを入力してください</p>
        <label>学生証の画像（表面のみ）</label>
        <label class="sid-drop" for="tc-file"><img alt="学生証のプレビュー" hidden><span>タップして撮影・画像を選択</span></label>
        <input id="tc-file" type="file" accept="image/*" hidden>
        <p class="hint">お名前・学校名・有効期限が読み取れるように撮影してください。審査にのみ使用し、審査後に削除します。</p>
        <label for="tc-sno" class="sno-label">学籍番号</label>
        <input id="tc-sno" autocomplete="off" placeholder="例：A1234567" maxlength="50">
        <p class="hint">学生証の画像を出さない場合は、学籍番号を入力してください（ご所属に学校名もご記入ください）。</p></div>
      <p class="sig-err" hidden></p>
      <div class="sig-actions">
        <button class="lux-btn ghost sm" type="button" data-cancel>キャンセル</button>
        <button class="lux-btn sm" type="submit">申請する</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("[data-cancel]").addEventListener("click", () => dlg.close());
  dlg.showModal();
  const form = dlg.querySelector("form");
  const err = dlg.querySelector(".sig-err");
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  const sidBox = dlg.querySelector("#tc-sid");
  let sidImage = "";
  const sync = () => { sidBox.hidden = form.elements.newType.value !== "student"; };
  form.addEventListener("change", sync); sync();
  dlg.querySelector("#tc-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      sidImage = await compressImage(file);
      const img = sidBox.querySelector("img");
      img.src = sidImage; img.hidden = false;
      sidBox.querySelector(".sid-drop span").textContent = "タップして画像を選び直す";
      err.hidden = true;
    } catch (ex) { console.error(ex); sidImage = ""; fail("この画像は読み込めませんでした。JPEG または PNG の画像を選んでください。"); }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newType = form.elements.newType.value;
    const reason = dlg.querySelector("#tc-reason").value.trim();
    if (!reason) return fail("変更の理由を入力してください。");
    const studentNo = newType === "student" ? dlg.querySelector("#tc-sno").value.trim() : "";
    if (newType === "student" && !sidImage && !studentNo) return fail("学生証の画像か学籍番号のどちらかを入力してください。");
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 送信中…';
    try {
      await requestTypeChange(m.id, newType, reason, sidImage, studentNo);
      Object.assign(m, { typeRequest: newType, typeRequestReason: reason, ...(studentNo ? { typeRequestStudentNo: studentNo } : {}) });
      dlg.close(); rerender();
      toast("会員種別の変更を申請しました。結果はメールでお知らせします");
    } catch (ex) {
      console.error(ex);
      fail(errorMessage(ex));
      btn.disabled = false; btn.textContent = "申請する";
    }
  });
}

// メールアドレスの変更（新しいアドレスに確認メール → リンクを開くと切り替え → 次回ログイン時に会員データへ反映）
function openEmailChange() {
  const dlg = document.createElement("dialog");
  dlg.className = "sig-dialog";
  dlg.innerHTML = `<form id="email-form" novalidate>
      <h3>メールアドレスの変更</h3>
      <p>新しいメールアドレスに確認メールをお送りします。メール内のリンクを開くと変更が完了し、次回からは新しいアドレスでログインします。本人確認のため、現在のパスワードを入力してください。</p>
      <div class="field"><label for="ne-email">新しいメールアドレス</label><input id="ne-email" type="email" autocomplete="email" required maxlength="200"></div>
      <div class="field"><label for="ne-email2">新しいメールアドレス（確認）</label><input id="ne-email2" type="email" autocomplete="off" required maxlength="200"></div>
      <div class="field"><label for="ne-pw">現在のパスワード</label><input id="ne-pw" type="password" autocomplete="current-password" required></div>
      <p class="sig-err" hidden></p>
      <div class="sig-actions">
        <button class="lux-btn ghost sm" type="button" data-cancel>キャンセル</button>
        <button class="lux-btn sm" type="submit">確認メールを送る</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("[data-cancel]").addEventListener("click", () => dlg.close());
  dlg.showModal();
  const err = dlg.querySelector(".sig-err");
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = dlg.querySelector("#ne-email").value.trim().toLowerCase();
    const email2 = dlg.querySelector("#ne-email2").value.trim().toLowerCase();
    const pw = dlg.querySelector("#ne-pw").value;
    if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(email)) return fail("正しいメールアドレスを入力してください。");
    if (email !== email2) return fail("確認用のメールアドレスが一致しません。");
    if (email === (state.user.email || "").toLowerCase()) return fail("現在と同じメールアドレスです。");
    if (!pw) return fail("現在のパスワードを入力してください。");
    const btn = e.submitter || dlg.querySelector("[type=submit]");
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 送信中…';
    try {
      await requestEmailChange(state.user, email, pw);
      dlg.querySelector("form").innerHTML = `<h3>確認メールを送信しました</h3>
        <p><b>${esc(email)}</b> あてに確認メールをお送りしました。メール内のリンクを開くと変更が完了します。<br>
        変更が完了するまでは、これまでのメールアドレスでログインできます。完了後は、新しいメールアドレスでもう一度ログインしてください。</p>
        <div class="sig-actions"><button class="lux-btn sm" type="button" data-cancel>閉じる</button></div>`;
      dlg.querySelector("[data-cancel]").addEventListener("click", () => dlg.close());
    } catch (ex) {
      console.error(ex);
      const map = {
        "auth/wrong-password": "パスワードが正しくありません。", "auth/invalid-credential": "パスワードが正しくありません。",
        "auth/email-already-in-use": "このメールアドレスは、すでに別のアカウントで使われています。",
        "auth/invalid-email": "メールアドレスの形式が正しくありません。",
        "auth/too-many-requests": "試行回数が多すぎます。しばらく時間をおいてからお試しください。"
      };
      fail(map[ex.code] || errorMessage(ex));
      btn.disabled = false; btn.textContent = "確認メールを送る";
    }
  });
}

function renderProfile() {
  const m = state.member;
  const f = (name, label, attrs = "") => `<div class="field"><label for="p-${name}">${label}</label><input id="p-${name}" name="${name}" value="${esc(m[name] || "")}" ${attrs}></div>`;
  return `<div class="profile-grid">
    <section class="panel">
      <div class="panel-head"><h3>登録情報</h3></div>
      <form id="profile-form" novalidate>
        <div class="grid-2">${f("name", "お名前", 'autocomplete="name" maxlength="100" required')}${f("kana", "フリガナ", 'maxlength="100"')}</div>
        <div class="field"><label>メールアドレス</label>
          <div class="email-row"><input value="${esc(state.user.email || m.email)}" disabled>${canChangeEmail(state.user) ? '<button class="lux-btn ghost sm" type="button" id="email-change">変更する</button>' : ""}</div>
          <p class="hint">${canChangeEmail(state.user) ? "変更すると、新しいアドレスに確認メールが届きます。メール内のリンクを開いた時点で切り替わります。" : "Google アカウントでログインしているため、ここでは変更できません。変更が必要な場合は委員会までご連絡ください。"}</p></div>
        <div class="field"><label for="p-occupation">ご職業</label><select id="p-occupation" name="occupation"><option value="">選択してください</option>${OCCUPATIONS.map(g =>
          `<optgroup label="${esc(g.group)}">${g.items.map(v => `<option${m.occupation === v ? " selected" : ""}>${esc(v)}</option>`).join("")}</optgroup>`).join("")}</select></div>
        ${f("affiliation", "ご所属", 'autocomplete="organization" maxlength="200"')}
        <div class="field"><label class="check"><input type="checkbox" name="newsletter"${m.newsletter ? " checked" : ""}> 会員向けのお知らせをメールで受け取る</label></div>
        <button class="lux-btn" id="save-btn" type="submit" disabled>変更を保存</button>
      </form>
    </section>
    <div style="display:flex;flex-direction:column;gap:24px">
      <section class="panel">
        <div class="panel-head"><h3>会員ステータス</h3></div>
        <p class="status-badge">${esc(STATUS_LABEL[m.status] || m.status)}</p>
        <dl class="card-info" style="grid-template-columns:1fr;width:100%">
          <div><dt>会員番号</dt><dd>${esc(m.memberNo || "—")}</dd></div>
          <div><dt>会員種別</dt><dd>${esc(MEMBER_TYPES[m.type]?.label || "")}</dd></div>
          <div><dt>入会日</dt><dd>${ymd(m.approvedAt)}</dd></div>
        </dl>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>セキュリティ</h3></div>
        <p style="color:var(--muted);font-size:13px;margin:0 0 16px">ご登録のメールアドレスにパスワード再設定用のリンクをお送りします。</p>
        <button class="lux-btn ghost sm" id="pw-reset">パスワードを変更する</button>
        <div class="mfa-panel">
          <p class="mfa-panel-head"><b>2 段階認証</b><span class="mfa-badge" id="mfa-state">確認中…</span></p>
          <p style="color:var(--muted);font-size:13px;margin:0 0 10px">ログインのときに、パスワード（または Google）に加えて、認証アプリかメールの 6 桁のコードを確認します。</p>
          <button class="lux-btn ghost sm" id="mfa-settings">2段階認証を設定する</button>
        </div>      </section>
      <section class="panel" id="type-panel">
        <div class="panel-head"><h3>会員種別の変更</h3></div>
        ${m.typeRequest ? `
          <div class="type-req">
            <span class="type-req-badge">申請中</span>
            <p class="type-req-flow">${esc(MEMBER_TYPES[m.type]?.label || m.type)}<span>→</span><b>${esc(MEMBER_TYPES[m.typeRequest]?.label || m.typeRequest)}</b></p>
            ${m.typeRequestReason ? `<p class="type-req-reason">理由：${esc(m.typeRequestReason)}</p>` : ""}
            <p class="type-note">委員会で確認のうえ、結果をメールでお知らせします。</p>
            <button class="lux-btn ghost sm" type="button" id="type-cancel">申請を取り消す</button>
          </div>`
        : `
          <p class="type-note">現在の会員種別：<b>${esc(MEMBER_TYPES[m.type]?.label || m.type)}</b><br>変更は委員会の承認後に反映されます。学生会員への変更には学生証（表面）の画像か学籍番号が必要です。</p>
          <button class="lux-btn ghost sm" type="button" id="type-open">会員種別の変更を申請する</button>`}
      </section>
    </div>
  </div>`;
}

// ============================================================
//  トースト通知
// ============================================================
function toast(msg, isError = false) {
  const t = document.createElement("div");
  t.className = `toast${isError ? " error" : ""}`;
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, 3200);
}

// ============================================================
//  コマンドパレット（Ctrl+K / ⌘K）
// ============================================================
let palItems = [], palSel = 0;
function paletteSource() {
  const items = ROUTES.map((r, i) => ({ grp: "ページ", label: r.label, icon: r.icon, hint: String(i + 1), run: () => location.hash = r.id }));
  (state.news || []).forEach(n => items.push({ grp: "お知らせ", label: n.title, icon: "bell", hint: ymd(n.date), run: () => location.hash = `news/${n.id}` }));
  (state.events || []).forEach(e => items.push({ grp: "行事", label: e.title, icon: "cal", hint: ymd(e.date), run: () => location.hash = "events" }));
  (state.docs || []).forEach(d => items.push({ grp: "資料", label: d.title, icon: "book", hint: d.category || "", run: () => d.url && window.open(d.url, "_blank", "noopener") }));
  items.push({ grp: "操作", label: "公式サイトへ移動", icon: "home", hint: "", run: () => location.href = "index.html" });
  items.push({ grp: "操作", label: "ログアウト", icon: "out", hint: "", run: doLogout });
  return items;
}
function drawPalette() {
  const q = $("palette-q").value.trim().toLowerCase();
  palItems = paletteSource().filter(it => !q || it.label.toLowerCase().includes(q) || it.grp.includes(q)).slice(0, 40);
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  let last = "";
  $("palette-list").innerHTML = palItems.length ? palItems.map((it, i) => {
    const head = it.grp !== last ? `<li class="grp">${esc(it.grp)}</li>` : "";
    last = it.grp;
    return `${head}<li class="opt${i === palSel ? " is-sel" : ""}" role="option" data-i="${i}" aria-selected="${i === palSel}">${icon(it.icon)}<span>${esc(it.label)}</span><small>${esc(it.hint)}</small></li>`;
  }).join("") : `<li class="grp" style="text-align:center;padding:24px">見つかりませんでした</li>`;
  $("palette-list").querySelector(".is-sel")?.scrollIntoView({ block: "nearest" });
}
function openPalette() {
  if ($("portal").hidden) return;
  $("palette-bg").classList.add("is-open");
  $("palette-q").value = ""; palSel = 0; drawPalette();
  $("palette-q").focus();
}
function closePalette() { $("palette-bg").classList.remove("is-open"); }
function runPalette(i) { const it = palItems[i]; if (!it) return; closePalette(); it.run(); }

$("open-palette").addEventListener("click", openPalette);
$("palette-q").addEventListener("input", () => { palSel = 0; drawPalette(); });
$("palette-q").addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = (palSel + 1) % Math.max(1, palItems.length); drawPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = (palSel - 1 + palItems.length) % Math.max(1, palItems.length); drawPalette(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(palSel); }
});
$("palette-list").addEventListener("click", e => { const li = e.target.closest("[data-i]"); if (li) runPalette(+li.dataset.i); });
$("palette-bg").addEventListener("click", e => { if (e.target.id === "palette-bg") closePalette(); });

// ---------- キーボードショートカット ----------
document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette-bg").classList.contains("is-open") ? closePalette() : openPalette(); return; }
  if (e.key === "Escape") { closePalette(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $("portal").hidden || $("palette-bg").classList.contains("is-open")) return;
  if (e.key === "/") {
    e.preventDefault();
    const s = document.querySelector(".view input[type=search]");
    s ? s.focus() : openPalette();
  } else if (/^[1-9]$/.test(e.key) && ROUTES[+e.key - 1]) {
    location.hash = ROUTES[+e.key - 1].id;
  }
});

// ---------- ログアウト ----------
async function doLogout() {
  await logout();
  location.replace("member-login.html");
}
document.addEventListener("click", e => {
  const a = e.target.closest('[data-action="logout"]');
  if (a) { e.preventDefault(); doLogout(); }
});
