// ============================================================
//  会員サイト（member.html）の画面処理
// ============================================================
import {
  onAuth, logout, resetPassword, getMember, updateProfile, getMemberNews, getMemberDocs,
  getEvents, getMyRsvps, rsvp, errorMessage, MEMBER_TYPES, STATUS_LABEL, OCCUPATIONS
} from "./member-api.js";
import { esc, isDemo, app } from "./db.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { memberCardHtml, bindCard, printSheetHtml } from "./card.js";
import { renderRich, htmlToText } from "./rich-view.js";
import { listMemberForms, listMySignatures } from "./consent-core.js";
import { docBoxHtml, fillDoc, signFormHtml, bindSignForm, receiptHtml, bindReceipt, isPastDeadline, fmtDateTime } from "./consent-ui.js";

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
  { id: "card", label: "デジタル会員証", short: "会員証", icon: "card", render: renderCard },
  { id: "profile", label: "プロフィール設定", short: "設定", icon: "user", render: renderProfile }
];

/** ID でメニューの項目を取り出す（並べ替えても壊れないように） */
const routeOf = (id) => ROUTES.find(r => r.id === id);

// ---------- 状態 ----------
const $ = (id) => document.getElementById(id);
const state = { user: null, member: null, news: null, docs: null, events: null, rsvps: new Set(), consentForms: null, mySigs: null, route: "dashboard", errors: {} };
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
    `<li><a href="#${r.id}" data-route="${r.id}">${icon(r.icon)}${r.label}<span class="badge" data-badge="${r.id}" hidden></span><kbd>${i + 1}</kbd></a></li>`).join("");
  $("tabbar").innerHTML = ROUTES.filter(r => r.id !== "profile").map(r =>
    `<a href="#${r.id}" data-route="${r.id}">${icon(r.icon)}${r.short}</a>`).join("") +
    `<a href="#profile" data-route="profile">${icon("user")}設定</a>`;
  fillMe();
  $("portal").hidden = false;
  hideBoot();

  window.addEventListener("hashchange", route);
  route();

  // データをまとめて読み込み（読み込み中はスケルトン表示）
  const load = async (key, fn) => {
    try { state[key] = await fn(); } catch (e) { console.error(e); state[key] = []; state.errors[key] = errorMessage(e); }
  };
  await Promise.all([
    load("news", getMemberNews),
    load("docs", getMemberDocs),
    load("events", getEvents),
    getMyRsvps(m.id).then(s => state.rsvps = s).catch(console.error),
    loadConsent()
  ]);
  updateBadges();
  rerender();
  if (state.route === "news") markNewsSeen();
}

function fillMe() {
  const m = state.member;
  $("me-avatar").textContent = (m.name || "?").trim().charAt(0);
  $("me-name").textContent = `${m.name} 様`;
  $("me-type").textContent = MEMBER_TYPES[m.type]?.label || "";
}

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
  $("view-title").textContent = r.label;
  document.title = r.id === "dashboard" ? "会員専用サイト｜普賢アーカイブ運営委員会" : `${r.label}｜会員サイト｜普賢アーカイブ運営委員会`;
  rerender();
  window.scrollTo({ top: 0 });
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
  // 本文（装飾つき HTML は安全な形にしてから）を表示
  document.querySelectorAll(".news-acc [data-body]").forEach(el => {
    const n = state.news.find(x => x.id === el.dataset.body);
    if (n) renderRich(el, n);
  });
  const q = $("news-q");
  const target = location.hash.split("/")[1];
  const apply = () => {
    const v = q.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll(".news-acc details").forEach(d => {
      const hit = !v || d.dataset.text.includes(v);
      d.hidden = !hit; if (hit) shown++;
    });
    $("news-none").hidden = shown > 0 || !state.news?.length;
  };
  q?.addEventListener("input", apply);
  if (target) {
    const d = document.querySelector(`details[data-id="${CSS.escape(target)}"]`);
    if (d) { d.open = true; setTimeout(() => d.scrollIntoView({ behavior: "smooth", block: "center" }), 80); }
  }
};
function renderNews() {
  if (!state.news) return `<div class="news-acc">${Array.from({ length: 4 }, () => '<div class="skel" style="height:64px;margin-bottom:12px;border-radius:16px"></div>').join("")}</div>`;
  if (state.errors.news) return emptyState(state.errors.news);
  if (!state.news.length) return emptyState("会員向けのお知らせはまだありません", "bell");
  return `
  <div class="toolbar"><label class="search">${icon("search", 2)}<input id="news-q" type="search" placeholder="お知らせを検索（/ キーで移動）" aria-label="お知らせを検索"></label></div>
  <div class="news-acc">${state.news.map((n, i) => `
    <details data-id="${esc(n.id)}" data-text="${esc(`${n.title} ${n.body || htmlToText(n.bodyHtml)}`.toLowerCase())}"${i === 0 ? " open" : ""}>
      <summary><time>${ymd(n.date)}</time><span class="ttl">${esc(n.title)}
        ${n.important ? '<span class="pill imp">重要</span>' : ""}${isNew(n.date) ? '<span class="pill new">NEW</span>' : ""}</span></summary>
      <div class="body" data-body="${esc(n.id)}"></div>
    </details>`).join("")}</div>
  <div id="news-none" hidden>${emptyState("該当するお知らせはありません", "search")}</div>`;
}

// ============================================================
//  画面：行事・参加登録
// ============================================================
let evFilter = "upcoming";
routeOf("events").after = () => {
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
  const chip = (k, l) => `<button data-evf="${k}" class="${evFilter === k ? "is-active" : ""}">${l}（${sets[k].length}）</button>`;
  return `
  <div class="toolbar"><div class="chips">${chip("upcoming", "今後の予定")}${chip("mine", "参加登録済み")}${chip("past", "過去の行事")}</div></div>
  ${rows.length ? `<div class="events">${rows.map(e => {
    const d = new Date(e.date + "T00:00:00");
    const past = e.date < t;
    const on = state.rsvps.has(e.id);
    return `<article class="ev${past ? " is-past" : ""}">
      <div class="ev-top">
        <div class="ev-date"><div class="m">${d.toLocaleString("en", { month: "short" }).toUpperCase()}</div><div class="d">${d.getDate()}</div><div class="y">${d.getFullYear()}</div></div>
        <div><h4>${esc(e.title)}</h4>${e.place ? `<div class="meta">${icon("pin")}${esc(e.place)}</div>` : ""}</div>
      </div>
      <div class="desc">${esc(e.description || "")}</div>
      <div class="ev-foot">
        ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" style="color:var(--gold-light);font-size:13px">詳細 ↗</a>` : "<span></span>"}
        ${past ? `<span class="pill">${on ? "参加済み" : "終了"}</span>`
          : `<button class="lux-btn sm rsvp-btn${on ? " is-on" : ""}" data-rsvp="${esc(e.id)}" aria-pressed="${on}">${on ? "✓ 参加登録済み" : "参加登録する"}</button>`}
      </div>
    </article>`;
  }).join("")}</div>` : emptyState(evFilter === "mine" ? "参加登録した行事はありません" : "該当する行事はありません", "cal")}`;
}

async function toggleRsvp(btn) {
  const id = btn.dataset.rsvp;
  const join = !state.rsvps.has(id);
  const ev = state.events.find(e => e.id === id);
  btn.disabled = true;
  // 先に表示を切り替えて、失敗したら戻す
  join ? state.rsvps.add(id) : state.rsvps.delete(id);
  rerender();
  try {
    await rsvp(id, state.member, join);
    toast(join ? `「${ev.title}」に参加登録しました` : `「${ev.title}」の参加登録を取り消しました`);
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
function docHtml(d) {
  return `<a class="doc" href="${esc(d.url || "#")}" ${d.url ? 'target="_blank" rel="noopener"' : ""}>
    <div class="file">${esc(fileLabel(d.url))}</div>
    <h4>${esc(d.title)}${isNew(d.date) ? ' <span class="pill new">NEW</span>' : ""}</h4>
    <p>${esc(d.description || "")}</p>
    <div class="foot"><span>${d.category ? esc(d.category) + "・" : ""}${ymd(d.date)}</span><span class="open">開く ${icon("ext")}</span></div>
  </a>`;
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
};
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
    <dl class="card-info">
      <div><dt>会員番号</dt><dd>${esc(m.memberNo || "—")}</dd></div>
      <div><dt>会員種別</dt><dd>${esc(MEMBER_TYPES[m.type]?.label || "")}</dd></div>
      <div><dt>入会日</dt><dd>${ymd(m.approvedAt)}</dd></div>
      <div><dt>有効期限</dt><dd>${m.validUntil ? ymd(m.validUntil) : "期限なし"}${left !== null ? `　<span class="pill ${left <= 60 ? "imp" : "ok"}">${left >= 0 ? `あと${left}日` : "期限切れ"}</span>` : ""}</dd></div>
    </dl>
    <div class="card-actions"><button class="lux-btn ghost sm" id="print-card">印刷する</button></div>
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
      phone: f.phone.value.trim(), address: f.address.value.trim(), newsletter: f.newsletter.checked
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
  $("pw-reset").addEventListener("click", async () => {
    try { await resetPassword(state.member.email || state.user.email); toast("パスワード再設定メールを送信しました"); }
    catch (err) { console.error(err); toast(errorMessage(err), true); }
  });
};
function renderProfile() {
  const m = state.member;
  const f = (name, label, attrs = "") => `<div class="field"><label for="p-${name}">${label}</label><input id="p-${name}" name="${name}" value="${esc(m[name] || "")}" ${attrs}></div>`;
  return `<div class="profile-grid">
    <section class="panel">
      <div class="panel-head"><h3>登録情報</h3></div>
      <form id="profile-form" novalidate>
        <div class="grid-2">${f("name", "お名前", 'autocomplete="name" maxlength="100" required')}${f("kana", "フリガナ", 'maxlength="100"')}</div>
        <div class="field"><label>メールアドレス</label><input value="${esc(m.email || state.user.email)}" disabled><p class="hint">メールアドレスの変更は委員会までご連絡ください</p></div>
        <div class="field"><label for="p-occupation">ご職業</label><select id="p-occupation" name="occupation"><option value="">選択してください</option>${OCCUPATIONS.map(g =>
          `<optgroup label="${esc(g.group)}">${g.items.map(v => `<option${m.occupation === v ? " selected" : ""}>${esc(v)}</option>`).join("")}</optgroup>`).join("")}</select></div>
        ${f("affiliation", "ご所属", 'autocomplete="organization" maxlength="200"')}
        <div class="grid-2">${f("phone", "電話番号", 'type="tel" autocomplete="tel" maxlength="30"')}${f("address", "ご住所", 'autocomplete="street-address" maxlength="300"')}</div>
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
        <button class="lux-btn ghost sm" data-action="logout" style="margin-top:10px">ログアウト</button>
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
