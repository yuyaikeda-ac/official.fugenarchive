// ============================================================
//  管理コンソール（admin.html）
//  ・ログイン（メール／Google）、招待された管理者の初回登録
//  ・ダッシュボード、お知らせ・行事・会員向けコンテンツの編集（高機能エディタ）
//  ・会員の審査（承認・否認・停止・再開）、学生証の確認
//  ・電子同意書の作成・公開・署名の確認・検証（ハッシュ／封印）
//  ・理事会（理事のグループ・入会審査の担当）と、理事会による審査状況の確認
//  ・管理者の招待（オーナーのみ）
// ============================================================
import { adminApi, esc, fmtDate, isDemo, NEWS_CATEGORIES, db, app } from "./db.js";
import { getStudentId, OCCUPATIONS } from "./member-api.js";
import { createRichEditor } from "./rich-editor.js";
import { renderRich } from "./rich-view.js";
import { uploadDocFile, deleteDocFile, docFileUrl, fmtSize, extOf, kindOf, KIND_LABEL, MAX_DOC_BYTES } from "./doc-files.js";
import {
  formContentHash, verifySignature, verifyChain, fmtHash,
  AUDIENCE_LABEL, PURPOSE_LABEL, FORM_STATUS_LABEL, SIGNER_LABEL, EXTRA_FIELDS
} from "./consent-core.js";
import {
  collection, query, where, getDocs, getDoc, doc, addDoc, updateDoc, setDoc, deleteDoc, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// ============================================================
//  コレクションごとの入力項目
//  ★ 項目を追加したい場合はここに1行追加するだけで、編集パネルと一覧に反映されます。
//    type: text | date | textarea | select | checkbox | url | rich（高機能エディタ。bodyHtml と body に保存）
//    list: true で一覧に表示／today: true で新規作成のとき今日の日付を最初から入れる
// ============================================================
const SCHEMA = {
  news: {
    label: "お知らせ", order: "date",
    fields: [
      { key: "date", label: "日付", type: "date", today: true, required: true, list: true, half: true },
      { key: "category", label: "区分", type: "select", options: Object.fromEntries(NEWS_CATEGORIES.map(c => [c.key, c.label])), required: true, list: true, half: true },
      { key: "title", label: "タイトル", type: "text", required: true, list: true },
      { key: "important", label: "「重要」ラベルを付ける", type: "checkbox", list: true },
      { key: "body", label: "本文", type: "rich" },
      { key: "url", label: "リンク先URL（入力すると本文ではなくこのURLへ移動）", type: "url" }
    ]
  },
  member_news: {
    label: "会員向けお知らせ", order: "date",
    fields: [
      { key: "date", label: "日付", type: "date", today: true, required: true, list: true },
      { key: "title", label: "タイトル", type: "text", required: true, list: true },
      { key: "important", label: "「重要」ラベルを付ける", type: "checkbox", list: true },
      { key: "body", label: "本文", type: "rich" }
    ]
  },
  events: {
    label: "行事", order: "date",
    fields: [
      { key: "date", label: "開催日", type: "date", required: true, list: true, half: true },
      { key: "place", label: "会場", type: "text", list: true, half: true },
      { key: "title", label: "行事名", type: "text", required: true, list: true },
      { key: "description", label: "説明", type: "textarea" },
      { key: "url", label: "詳細ページURL", type: "url" }
    ]
  },
  member_docs: {
    label: "会員限定資料", order: "date",
    fields: [
      { key: "date", label: "掲載日", type: "date", today: true, required: true, list: true, half: true },
      { key: "category", label: "分類（会議資料・活動報告 など）", type: "text", list: true, half: true },
      { key: "title", label: "資料名", type: "text", required: true, list: true },
      { key: "description", label: "説明", type: "textarea" },
      // ファイル（PDF・動画・音声・画像・Office など）をアップロード。または外部の URL を登録
      { key: "file", label: "ファイル（PDF・動画・音声・画像・Word・Excel など）", type: "file", list: true },
      { key: "url", label: "または 外部のURL（Google ドライブ・YouTube など）", type: "url" }
    ]
  },
  members: {
    label: "会員", order: "createdAt",
    fields: [
      { key: "type", label: "会員種別", type: "select", options: { regular: "正会員", associate: "準会員", student: "学生会員" }, required: true, half: true },
      { key: "validUntil", label: "有効期限（空欄＝期限なし）", type: "date", half: true },
      { key: "memberNo", label: "会員番号（有効な会員は空欄で保存すると自動で採番）", type: "text", generate: true },
      { key: "name", label: "お名前", type: "text", required: true, half: true },
      { key: "kana", label: "フリガナ", type: "text", half: true },
      { key: "email", label: "メールアドレス", type: "text" },
      { key: "occupation", label: "職業", type: "select", options: Object.fromEntries([["", "（未選択）"], ...OCCUPATIONS.flatMap(g => g.items).map(v => [v, v])]), half: true },
      { key: "affiliation", label: "所属", type: "text", half: true },
      { key: "phone", label: "電話番号", type: "text", half: true },
      { key: "address", label: "住所", type: "text", half: true },
      { key: "message", label: "入会時のメッセージ", type: "textarea" },
      { key: "newsletter", label: "お知らせメールを受け取る", type: "checkbox" }
    ]
  }
};

const MEMBER_TYPE = { regular: "正会員", associate: "準会員", student: "学生会員" };
// ★ 会員の状態は「承認」「否認」「停止」「再開」ボタンでのみ変更します（委員会承認制）
const MEMBER_STATUS = { pending: "審査中", active: "有効", suspended: "停止中", rejected: "否認" };

// ============================================================
//  会員番号の自動採番（例：FA-2026-0001）
//  ★ 形式を変えるときは MEMBER_NO の prefix（頭の文字）と digits（連番の桁数）を変更
//    ・連番はデータベースのカウンター（counters/memberNo）で管理し、重複しません
//    ・functions/index.js の MEMBER_NO と揃えてください
// ============================================================
const MEMBER_NO = { prefix: "FA", digits: 4 };
const memberNoSeq = (no) => { const m = /-(\d+)$/.exec(no || ""); return m ? +m[1] : 0; };
async function issueMemberNo() {
  const members = await getRows("members");
  const maxUsed = Math.max(0, ...members.map(r => memberNoSeq(r.memberNo)));
  const seq = await adminApi.issueMemberSeq(maxUsed);
  return `${MEMBER_NO.prefix}-${new Date().getFullYear()}-${String(seq).padStart(MEMBER_NO.digits, "0")}`;
}

// ============================================================
//  メニュー
//  ★ 並び替え・名前の変更はここで
// ============================================================
const ICONS = {
  dash: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  news: '<path d="M4 4h13v16H6a2 2 0 0 1-2-2zM17 8h3v10a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h3"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  doc: '<path d="M6 3h8l5 5v13H6zM14 3v5h5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  sign: '<path d="M4 20h16M6 16l9.5-9.5a2.1 2.1 0 0 1 3 3L9 19H6z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  board: '<path d="M3 21h18M5 21V10l7-6 7 6v11"/><path d="M9 21v-6h6v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;
const NAV = [
  { id: "dashboard", label: "ダッシュボード", icon: "dash" },
  { group: "コンテンツ" },
  { id: "news", label: "お知らせ", icon: "news" },
  { id: "member_news", label: "会員向けお知らせ", icon: "lock" },
  { id: "events", label: "行事", icon: "cal" },
  { id: "member_docs", label: "会員限定資料", icon: "doc" },
  { group: "会員" },
  { id: "members", label: "会員管理", icon: "users", badge: "pending" },
  { id: "consent", label: "電子同意書", icon: "sign" },
  { id: "board", label: "理事会", icon: "board" },
  { group: "受信" },
  { id: "contacts", label: "お問い合わせ", icon: "mail" },
  { group: "設定", owner: true },
  { id: "admins", label: "管理者", icon: "shield", owner: true }
];

// ============================================================
//  共通
// ============================================================
const $ = (id) => document.getElementById(id);
let currentAdmin = null;
let currentRole = "";
const cache = {};                 // コレクションの読み込み結果
const isOwner = () => currentRole === "owner";

/** コレクションを読み込む（cache を使う。force で読み直し） */
async function getRows(name, force = false) {
  if (!force && cache[name]) return cache[name];
  const order = SCHEMA[name]?.order || "createdAt";
  let rows;
  if (["consent_forms", "consent_signatures", "admins", "admin_invites", "board_groups", "reviews"].includes(name)) rows = await adminApi.listAll(name);
  else rows = await adminApi.list(name, { order });
  cache[name] = rows;
  return rows;
}
const invalidate = (...names) => names.forEach(n => delete cache[n]);

const toDate = (v) => v?.toDate ? v.toDate() : v ? new Date(v) : null;
const fmtDT = (v) => { const d = toDate(v); return d && !isNaN(d) ? d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; };
const fmtD = (v) => { const d = toDate(v); return d && !isNaN(d) ? d.toLocaleDateString("ja-JP") : "—"; };
const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text)}</span>`;

/** トースト（画面右下のお知らせ） */
function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), type === "error" ? 8000 : 4000);
}
const fail = (prefix) => (err) => { console.error(err); toast(`${prefix}：${err.message || err}`, "error"); };

/** ログイン画面のお知らせ */
const notice = (el, type, text) => { $(el).innerHTML = text ? `<div class="note ${type}">${esc(text)}</div>` : ""; };

// ---------- モーダル・編集パネル ----------
function openModal(title, html, { wide = false } = {}) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  $("modal").classList.toggle("wide", wide);
  if (!$("modal").open) $("modal").showModal();
  return $("modal-body");
}
function openDrawer(title, html) {
  $("drawer-title").textContent = title;
  $("drawer-body").innerHTML = html;
  if (!$("drawer").open) $("drawer").showModal();
  $("drawer-body").scrollTop = 0;
  return $("drawer-body");
}
const closeDrawer = () => $("drawer").close();
// モーダル：✕ ボタン・外側（背景）のクリックで閉じる
$("modal").addEventListener("click", e => {
  const d = $("modal");
  if (e.target.closest("[data-close]")) d.close();
  if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); }
});
// 編集パネル：入力内容を失わないよう、閉じる前に確認（保存したときは確認なし）
const confirmDiscard = () => window.confirm("編集中の内容は保存されません。閉じてよろしいですか？");
$("drawer").addEventListener("click", e => { if (e.target.closest("[data-close]") && confirmDiscard()) closeDrawer(); });
$("drawer").addEventListener("cancel", e => { if (!confirmDiscard()) e.preventDefault(); });

// ============================================================
//  認証
// ============================================================
if (isDemo) {
  $("auth-view").hidden = false;
  notice("login-msg", "info", "Firebase が未設定のため、ログインできません。assets/js/firebase-config.js を設定してください。");
}
adminApi.onAuth(user => { if (!isDemo) enter(user); });

// ログイン状態に応じて画面を切り替える
async function enter(user) {
  $("verify-box").hidden = true;
  if (!user) { $("auth-view").hidden = false; $("app").hidden = true; return; }
  let admin = null;
  try { admin = await adminApi.getAdmin(user.uid); } catch (e) { console.error(e); }

  // 管理者でなければ、招待されているか確認
  if (!admin) {
    const invite = await adminApi.getMyInvite(user);
    if (!invite) {
      await adminApi.logout();
      notice("login-msg", "error", `${user.email} には管理者権限がありません。管理者になるには、オーナーから招待を受けてください。`);
      return;
    }
    if (!user.emailVerified) {
      // メール確認待ち
      $("auth-view").hidden = false; $("app").hidden = true;
      $("login-form").hidden = true; $("register-box").hidden = true;
      $("verify-email").textContent = user.email;
      $("verify-box").hidden = false;
      return;
    }
    try {
      await adminApi.acceptInvite(user, invite);
      admin = await adminApi.getAdmin(user.uid);
    } catch (e) {
      console.error(e);
      notice("login-msg", "error", "管理者の登録に失敗しました：" + e.message);
      return;
    }
  }

  currentAdmin = user;
  currentRole = admin.role || "admin";
  $("auth-view").hidden = true; $("app").hidden = false;
  $("login-form").hidden = false; $("register-box").hidden = false;
  $("user-email").textContent = user.email;
  $("role-badge").textContent = isOwner() ? "オーナー" : "管理者";
  $("role-badge").className = `role ${currentRole}`;
  renderNav();
  route();
  refreshBadges();
}

// ---------- Google ログイン ----------
$("google-btn").addEventListener("click", async () => {
  if (isDemo) return;
  notice("login-msg", "", "");
  try { await adminApi.loginWithGoogle(); }
  catch (err) {
    console.error(err);
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    notice("login-msg", "error", err.code === "auth/operation-not-allowed"
      ? "Google ログインが有効になっていません。Firebase コンソールの Authentication で Google を有効にしてください。"
      : "Google ログインに失敗しました：" + err.message);
  }
});

// ---------- 招待された方の初回登録 ----------
$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  notice("register-msg", "", "");
  try {
    await adminApi.register($("reg-email").value.trim(), $("reg-pass").value);
  } catch (err) {
    console.error(err);
    const msg = {
      "auth/email-already-in-use": "このメールアドレスは登録済みです。上のフォームからログインしてください（パスワードが不明な場合は「パスワードの設定・再設定」）。",
      "auth/weak-password": "パスワードは8文字以上で設定してください。",
      "auth/invalid-email": "メールアドレスの形式が正しくありません。"
    }[err.code] || "登録に失敗しました：" + err.message;
    notice("register-msg", "error", msg);
  }
});
$("verified-btn").addEventListener("click", async () => {
  const user = await adminApi.refresh(adminApi.currentUser());
  if (!user.emailVerified) { notice("verify-msg", "error", "まだメールアドレスの確認が完了していません。メール内のリンクを開いてください。"); return; }
  enter(user);
});
$("resend-btn").addEventListener("click", async () => {
  try { await adminApi.sendVerification(adminApi.currentUser()); notice("verify-msg", "success", "確認メールを再送しました。"); }
  catch (err) { console.error(err); notice("verify-msg", "error", "再送できませんでした。しばらく時間をおいてお試しください。"); }
});
$("verify-logout").addEventListener("click", () => { $("login-form").hidden = false; $("register-box").hidden = false; adminApi.logout(); });

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isDemo) return;
  notice("login-msg", "", "");
  try { await adminApi.login($("login-email").value, $("login-pass").value); }
  catch (err) { console.error(err); notice("login-msg", "error", "ログインに失敗しました。メールアドレスとパスワードをご確認ください。"); }
});
$("logout").addEventListener("click", () => { Object.keys(cache).forEach(k => delete cache[k]); adminApi.logout(); });

// パスワードの設定・再設定メール
$("reset-btn").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  if (!email) { notice("login-msg", "error", "メールアドレスを入力してください。"); $("login-email").focus(); return; }
  try { await adminApi.resetPassword(email); notice("login-msg", "success", `${email} にパスワード設定用のメールを送信しました。メール内のリンクからパスワードを設定してください。`); }
  catch (err) { console.error(err); notice("login-msg", "error", "メールを送信できませんでした。メールアドレスをご確認ください。"); }
});

// ============================================================
//  画面の切り替え（#news のように URL の # で管理）
// ============================================================
function renderNav() {
  $("side-nav").innerHTML = NAV.filter(n => !n.owner || isOwner()).map(n => n.group
    ? `<div class="nav-group">${esc(n.group)}</div>`
    : `<a class="nav-link" href="#${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${esc(n.label)}</span>${n.badge ? `<span class="badge" data-badge="${n.badge}" hidden></span>` : ""}</a>`).join("");
}
const VIEWS = {
  dashboard: { title: "ダッシュボード", render: renderDashboard },
  news: { title: "お知らせ", render: (sub) => renderContent("news", sub) },
  member_news: { title: "会員向けお知らせ", render: (sub) => renderContent("member_news", sub) },
  events: { title: "行事", render: (sub) => renderContent("events", sub) },
  member_docs: { title: "会員限定資料", render: (sub) => renderContent("member_docs", sub) },
  members: { title: "会員管理", render: renderMembers },
  consent: { title: "電子同意書", render: renderConsent },
  board: { title: "理事会", render: renderBoard },
  contacts: { title: "お問い合わせ", render: renderContacts },
  admins: { title: "管理者", render: renderAdmins, owner: true }
};
function route() {
  if (!currentAdmin) return;
  const [name, sub] = (location.hash.slice(1) || "dashboard").split("/");
  const view = VIEWS[name] && (!VIEWS[name].owner || isOwner()) ? VIEWS[name] : VIEWS.dashboard;
  const key = VIEWS[name] === view ? name : "dashboard";
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("is-active", a.dataset.nav === key));
  $("page-title").textContent = view.title;
  document.title = `${view.title}｜管理コンソール｜普賢アーカイブ運営委員会`;
  $("app").classList.remove("nav-open");
  $("page").innerHTML = '<div class="loading"><span class="spin"></span> 読み込み中…</div>';
  return Promise.resolve(view.render(sub ? decodeURIComponent(sub) : "")).catch(e => {
    console.error(e);
    $("page").innerHTML = `<div class="note error">読み込みに失敗しました：${esc(e.message)}</div>`;
  });
}
addEventListener("hashchange", route);
$("menu-btn").addEventListener("click", () => $("app").classList.add("nav-open"));
$("scrim").addEventListener("click", () => $("app").classList.remove("nav-open"));

/** メニューの「審査待ち」の数 */
async function refreshBadges() {
  try {
    const rows = await getRows("members");
    const n = rows.filter(r => r.status === "pending" || r.signatureRewrite === "requested" || r.typeRequest).length;
    document.querySelectorAll('[data-badge="pending"]').forEach(b => { b.hidden = !n; b.textContent = n; });
  } catch (e) { console.warn(e); }
}

// ============================================================
//  ダッシュボード
// ============================================================
async function renderDashboard() {
  const safe = (p) => p.catch(e => { console.warn(e); return []; });
  const [members, contacts, forms, sigs, news, reviews] = await Promise.all([
    safe(getRows("members", true)), safe(getRows("contacts", true)), safe(getRows("consent_forms", true)),
    safe(getRows("consent_signatures", true)), safe(getRows("news")), safe(getRows("reviews", true))
  ]);
  const pending = members.filter(m => m.status === "pending");
  const active = members.filter(m => m.status === "active").length;
  const published = forms.filter(f => f.status === "published").length;
  const recentContacts = [...contacts].sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0)).slice(0, 5);

  const sigRequests = members.filter(m => m.signatureRewrite === "requested");
  const typeRequests = members.filter(m => m.typeRequest);
  $("page").innerHTML = `
    <p class="page-intro">${esc(currentAdmin.email)} さん、お疲れさまです。最新の状況です。</p>
    ${typeRequests.length ? `<section class="card sigreq-card">
      <div class="card-head"><h2>会員種別の変更申請（${typeRequests.length}件）</h2><a class="btn btn-sm" href="#members">会員管理へ</a></div>
      <ul class="mini-list">${typeRequests.map(m => `<li><div class="t"><b>${esc(m.name)}：${esc(MEMBER_TYPE[m.type] || m.type)} → ${esc(MEMBER_TYPE[m.typeRequest] || m.typeRequest)}</b>
          <small>${esc(m.memberNo || "")}・${fmtD(m.typeRequestAt)} 申請${m.typeRequestReason ? `・理由：${esc(m.typeRequestReason)}` : ""}</small></div>
        ${m.typeRequest === "student" ? `<button class="btn btn-sm" data-sid="${esc(m.id)}">学生証</button>` : ""}
        <button class="btn btn-sm btn-ok" data-typeallow="${esc(m.id)}">許可</button>
        <button class="btn btn-sm btn-danger" data-typedeny="${esc(m.id)}">却下</button></li>`).join("")}</ul>
    </section>` : ""}
    ${sigRequests.length ? `<section class="card sigreq-card">
      <div class="card-head"><h2>会員証の署名の書き直し申請（${sigRequests.length}件）</h2><a class="btn btn-sm" href="#members">会員管理へ</a></div>
      <ul class="mini-list">${sigRequests.map(m => `<li><div class="t"><b>${esc(m.name)}</b><small>${esc(m.memberNo || "")}・${fmtD(m.signatureRewriteAt)} 申請</small></div>
        <button class="btn btn-sm" data-sigview="${esc(m.id)}">現在の署名</button>
        <button class="btn btn-sm btn-ok" data-sigallow="${esc(m.id)}">許可</button>
        <button class="btn btn-sm btn-danger" data-sigdeny="${esc(m.id)}">却下</button></li>`).join("")}</ul>
    </section>` : ""}
    <div class="stats">
      <a class="card stat warn${pending.length ? " has" : ""}" href="#members"><div class="ic">${icon("users")}</div><div class="k">審査待ちの入会申込</div><div class="v">${pending.length}<small>件</small></div></a>
      <a class="card stat ok" href="#members"><div class="ic">${icon("shield")}</div><div class="k">有効会員</div><div class="v">${active}<small>名</small></div></a>
      <a class="card stat info" href="#contacts"><div class="ic">${icon("mail")}</div><div class="k">お問い合わせ</div><div class="v">${contacts.length}<small>件</small></div></a>
      <a class="card stat gold" href="#consent"><div class="ic">${icon("sign")}</div><div class="k">公開中の同意書 ／ 署名</div><div class="v">${published}<small>件 ／ ${sigs.length} 署名</small></div></a>
    </div>
    <div class="grid2">
      <section class="card">
        <div class="card-head"><h2>審査待ちの入会申込</h2><a class="btn btn-sm" href="#members">会員管理へ</a></div>
        ${pending.length ? `<ul class="mini-list">${pending.map(m => `<li>
          <div class="t"><b>${esc(m.name)}（${esc(MEMBER_TYPE[m.type] || m.type)}）</b><small>${esc(m.email)}・${fmtD(m.createdAt)} 申込${m.occupation ? `・${esc(m.occupation)}` : ""}</small>
            ${reviewBadge(reviewOf(reviews, m.id), true)}</div>
          <button class="btn btn-sm" data-review="${esc(m.id)}">審査状況</button>
          ${m.type === "student" ? `<button class="btn btn-sm" data-sid="${esc(m.id)}">学生証</button>` : ""}
          <button class="btn btn-sm btn-ok" data-approve="${esc(m.id)}">承認</button>
          <button class="btn btn-sm btn-danger" data-reject="${esc(m.id)}">否認</button></li>`).join("")}</ul>`
          : '<div class="empty">審査待ちの申込はありません。</div>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>クイック操作</h2></div>
        <div class="card-body quick">
          <a href="#news/new">${icon("plus")}お知らせを書く</a>
          <a href="#member_news/new">${icon("plus")}会員向けお知らせ</a>
          <a href="#events/new">${icon("plus")}行事を登録</a>
          <a href="#consent/new">${icon("plus")}同意書を作る</a>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>最近のお問い合わせ</h2><a class="btn btn-sm" href="#contacts">すべて見る</a></div>
        ${recentContacts.length ? `<ul class="mini-list">${recentContacts.map(c => `<li><div class="t"><b>${esc(c.subject || "")}：${esc(c.name)}</b><small>${fmtDT(c.createdAt)}・${esc((c.message || "").slice(0, 80))}</small></div></li>`).join("")}</ul>`
          : '<div class="empty">お問い合わせはありません。</div>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>最近のお知らせ</h2><a class="btn btn-sm" href="#news">一覧へ</a></div>
        ${news.length ? `<ul class="mini-list">${news.slice(0, 5).map(n => `<li><div class="t"><b>${esc(n.title)}</b><small>${esc(fmtDate(n.date))}</small></div></li>`).join("")}</ul>`
          : '<div class="empty">お知らせはありません。</div>'}
      </section>
    </div>`;
  refreshBadges();
}

// ============================================================
//  お知らせ・行事・会員向けお知らせ・会員限定資料（共通の一覧と編集）
// ============================================================
async function renderContent(name, sub = "") {
  const s = SCHEMA[name];
  const rows = await getRows(name, true);
  let rsvpBy = null;
  if (name === "events") {
    rsvpBy = {};
    try { (await adminApi.list("rsvps", { order: "createdAt" })).forEach(r => (rsvpBy[r.eventId] ||= []).push(r.name)); }
    catch (e) { console.error(e); }
  }
  const cols = s.fields.filter(f => f.list);
  $("page").innerHTML = `
    <div class="toolbar">
      <input class="search" id="q" type="search" placeholder="タイトルなどで検索">
      <span class="spacer"></span>
      <button class="btn btn-primary" id="new-btn">${icon("plus").replace("<svg", '<svg width="16" height="16"')} 新規作成</button>
    </div>
    <div class="card table-wrap"><table class="tbl cards" id="tbl">
      <thead><tr>${cols.map(c => `<th>${esc(c.label.replace(/（.*）/, ""))}</th>`).join("")}${rsvpBy ? "<th>参加登録</th>" : ""}<th></th></tr></thead>
      <tbody></tbody></table></div>`;
  const cell = (c, r) => {
    if (c.type === "checkbox") return r[c.key] ? pill("ng", "重要") : "";
    if (c.type === "file") return r.filePath ? `${pill("info", extOf(r.fileName))} ${esc(fmtSize(r.fileSize))}` : r.url ? pill("draft", "外部リンク") : "";
    if (c.options) return esc(c.options[r[c.key]] ?? r[c.key] ?? "");
    if (c.type === "date") return esc(fmtDate(r[c.key]));
    return esc(r[c.key] ?? "");
  };
  const draw = () => {
    const q = $("q").value.trim().toLowerCase();
    const list = rows.filter(r => !q || `${r.title} ${r.body || ""} ${r.place || ""} ${r.category || ""}`.toLowerCase().includes(q));
    $("tbl").querySelector("tbody").innerHTML = list.length ? list.map(r => `<tr>
      ${cols.map(c => `<td${c.key === "title" ? ' class="main"' : c.type === "checkbox" ? "" : ` data-label="${esc(c.label.replace(/（.*）/, ""))}"`}>${c.key === "title" ? `<b>${cell(c, r)}</b>${r.bodyHtml ? ' <span class="pill info">装飾つき</span>' : ""}` : cell(c, r)}</td>`).join("")}
      ${rsvpBy ? `<td data-label="参加登録">${(rsvpBy[r.id] || []).length} 名${(rsvpBy[r.id] || []).length ? `<span class="sub">${esc((rsvpBy[r.id] || []).join("、"))}</span>` : ""}</td>` : ""}
      <td class="act"><button class="btn btn-sm" data-edit="${esc(r.id)}">編集</button><button class="btn btn-sm btn-danger" data-del="${esc(r.id)}">削除</button></td></tr>`).join("")
      : `<tr><td colspan="${cols.length + 2}" class="empty">データがありません。</td></tr>`;
  };
  draw();
  $("q").addEventListener("input", draw);
  $("new-btn").addEventListener("click", () => openEditor(name, null));
  $("tbl").addEventListener("click", async e => {
    const { edit, del } = e.target.dataset;
    if (edit) openEditor(name, rows.find(r => r.id === edit));
    if (del) {
      const r = rows.find(x => x.id === del);
      if (!window.confirm(`「${r.title || del}」を削除します。よろしいですか？`)) return;
      try {
        await adminApi.remove(name, del);
        if (r.filePath) await deleteDocFile(r.filePath).catch(err => console.warn("ファイルの削除に失敗", err));
        toast("削除しました。"); invalidate(name); route();
      }
      catch (err) { fail("削除に失敗しました")(err); }
    }
  });
  if (sub === "new") { history.replaceState(null, "", `#${name}`); openEditor(name, null); }
}

/** プレーンテキストを段落の HTML に（古いお知らせを編集するとき） */
const textToHtml = (t) => (t || "").split(/\r?\n/).map(l => `<p>${l ? esc(l) : "<br>"}</p>`).join("");

/** 入力欄の HTML（SCHEMA の 1 項目） */
/** 今日の日付（日本時間、YYYY-MM-DD） */
const todayJst = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

function fieldHtml(f, row) {
  const v = esc(row?.[f.key] ?? (!row && f.today ? todayJst() : ""));
  const req = f.required ? " required" : "";
  const reqMark = f.required ? '<span class="req">必須</span>' : "";
  if (f.type === "checkbox") return `<label class="check"><input type="checkbox" name="${f.key}"${row?.[f.key] ? " checked" : ""}> ${esc(f.label)}</label>`;
  if (f.type === "file") return `<div class="fld"><span>${esc(f.label)}</span>
    <div class="file-drop" data-file-box>
      <input type="file" data-file-input hidden>
      <div class="file-cur" data-file-cur>${row?.filePath ? fileChipHtml(row) : ""}</div>
      <button type="button" class="btn" data-file-pick>${row?.filePath ? "別のファイルに差し替える" : "ファイルを選ぶ"}</button>
      <span class="hint">ここにドラッグ＆ドロップもできます。1 ファイル ${fmtSize(MAX_DOC_BYTES)} まで。保存すると、会員だけが閲覧できる場所にアップロードされます。</span>
      <div class="file-prog" data-file-prog hidden><i></i><b></b></div>
    </div></div>`;
  if (f.type === "rich") return `<div class="fld"><span>${esc(f.label)}</span><div data-rich="${f.key}"></div>
    <span class="hint">画像はボタン・貼り付け・ドラッグ＆ドロップで挿入できます。画像をクリックすると、大きさ（小・中・大・全幅、右下の□をドラッグ）と位置（左・中央・右・回り込み）を変えられます。</span></div>`;
  let input;
  if (f.type === "textarea") input = `<textarea name="${f.key}"${req}>${v}</textarea>`;
  else if (f.type === "select") input = `<select name="${f.key}"${req}>${Object.entries(f.options).map(([k, l]) =>
    `<option value="${esc(k)}"${(row?.[f.key] ?? "") === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  else input = `<input type="${f.type === "url" ? "url" : f.type}" name="${f.key}" value="${v}"${req}${f.type === "url" ? ' placeholder="https://"' : ""}>`;
  if (f.generate) input = `<div style="display:flex;gap:8px">${input}<button type="button" class="btn" data-generate="${f.key}">自動生成</button></div>`;
  return `<label class="fld"><span>${esc(f.label)}${reqMark}</span>${input}</label>`;
}
/** アップロード済み・選択中のファイルの表示 */
function fileChipHtml(x) {
  return `<div class="file-chip"><span class="ext">${esc(extOf(x.fileName))}</span><span class="nm">${esc(x.fileName)}</span>
    <small>${esc(KIND_LABEL[kindOf(x.fileType, x.fileName)])}・${esc(fmtSize(x.fileSize))}</small>
    ${x.filePath ? '<button type="button" class="btn btn-sm" data-file-open>開く</button>' : ""}
    <button type="button" class="btn btn-sm btn-danger" data-file-clear>外す</button></div>`;
}

/** 項目を並べる（half: true の項目は 2 列） */
function fieldsHtml(fields, row) {
  let out = "", buf = [];
  const flush = () => { if (buf.length) { out += buf.length > 1 ? `<div class="row2">${buf.join("")}</div>` : buf[0]; buf = []; } };
  for (const f of fields) {
    if (f.half) { buf.push(fieldHtml(f, row)); if (buf.length === 2) flush(); }
    else { flush(); out += fieldHtml(f, row); }
  }
  flush();
  return out;
}

/** 編集パネルを開く（お知らせ・行事・会員など） */
async function openEditor(name, row) {
  const s = SCHEMA[name];
  const hasRich = s.fields.some(f => f.type === "rich");
  const body = openDrawer(`${s.label}を${row ? "編集" : "新規作成"}`, `
    <form id="edit-form" novalidate>
      ${fieldsHtml(s.fields, row)}
      <div class="drawer-foot">
        ${hasRich ? '<button type="button" class="btn" id="preview-btn">プレビュー</button>' : ""}
        <span style="flex:1"></span>
        <button type="button" class="btn" data-close>キャンセル</button>
        <button type="submit" class="btn btn-primary" id="save-btn">保存</button>
      </div>
    </form>`);
  const form = body.querySelector("#edit-form");
  // 高機能エディタ
  const editors = {};
  for (const el of body.querySelectorAll("[data-rich]")) {
    el.innerHTML = '<div class="loading"><span class="spin"></span> エディタを読み込み中…</div>';
    try {
      editors[el.dataset.rich] = await createRichEditor(el, {
        html: row?.bodyHtml || textToHtml(row?.[el.dataset.rich]),
        notify: (m, isErr) => toast(m, isErr ? "error" : "info")
      });
    } catch (e) { el.innerHTML = `<div class="note error">${esc(e.message)}</div>`; }
  }
  body.querySelector("#preview-btn")?.addEventListener("click", async () => {
    const ed = Object.values(editors)[0];
    const title = form.elements.title?.value || "";
    const out = openModal("プレビュー", `<h2 style="margin-top:0">${esc(title)}</h2><div class="preview" id="pv"></div>`, { wide: true });
    await renderRich(out.querySelector("#pv"), { bodyHtml: ed?.getHtml() || "" });
  });
  // ファイル欄（選ぶ・ドロップ・外す・開く）
  let fileState = { pending: null, removed: false };
  const fbox = form.querySelector("[data-file-box]");
  if (fbox) {
    const input = fbox.querySelector("[data-file-input]");
    const cur = fbox.querySelector("[data-file-cur]");
    const choose = (file) => {
      if (!file) return;
      if (file.size > MAX_DOC_BYTES) return toast(`ファイルが大きすぎます（${fmtSize(MAX_DOC_BYTES)} まで）。`, "error");
      fileState.pending = file;
      cur.innerHTML = fileChipHtml({ fileName: file.name, fileSize: file.size, fileType: file.type });
      if (!form.elements.title.value.trim()) form.elements.title.value = file.name.replace(/\.[^.]+$/, "");
    };
    fbox.querySelector("[data-file-pick]").addEventListener("click", () => input.click());
    input.addEventListener("change", () => choose(input.files[0]));
    fbox.addEventListener("dragover", e => { e.preventDefault(); fbox.classList.add("is-over"); });
    fbox.addEventListener("dragleave", () => fbox.classList.remove("is-over"));
    fbox.addEventListener("drop", e => { e.preventDefault(); fbox.classList.remove("is-over"); choose(e.dataTransfer.files[0]); });
    cur.addEventListener("click", async e => {
      if (e.target.closest("[data-file-clear]")) { fileState = { pending: null, removed: true }; cur.innerHTML = ""; input.value = ""; }
      if (e.target.closest("[data-file-open]") && row?.filePath) {
        const w = window.open("", "_blank");
        try { w.location = await docFileUrl(row.filePath); } catch (err) { w?.close(); fail("ファイルを開けませんでした")(err); }
      }
    });
  }
  // 会員番号の「自動生成」
  form.addEventListener("click", async (e) => {
    const key = e.target.dataset.generate;
    if (!key) return;
    const input = form.elements[key];
    if (input.value.trim() && !window.confirm(`現在の会員番号「${input.value.trim()}」を新しい番号に置き換えますか？`)) return;
    e.target.disabled = true;
    try { input.value = await issueMemberNo(); }
    catch (err) { fail("会員番号の採番に失敗しました")(err); }
    finally { e.target.disabled = false; }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of s.fields) {
      if (f.type === "rich") {
        const ed = editors[f.key];
        if (!ed) continue;
        data.bodyHtml = ed.getHtml();
        data[f.key] = ed.getText();
        continue;
      }
      if (f.type === "file") continue;
      const el = form.elements[f.key];
      data[f.key] = f.type === "checkbox" ? el.checked : el.value.trim();
      if (f.required && !data[f.key]) { toast(`「${f.label.replace(/（.*）/, "")}」を入力してください。`, "error"); el.focus(); return; }
    }
    // 会員限定資料：ファイルか URL のどちらかが必要
    const hasFile = fbox && (fileState.pending || (row?.filePath && !fileState.removed));
    if (fbox && !hasFile && !data.url) { toast("ファイルを選ぶか、外部のURLを入力してください。", "error"); return; }
    const btn = form.querySelector("#save-btn");
    btn.disabled = true;
    let uploaded = null;
    try {
      if (fbox && fileState.pending) {
        const prog = fbox.querySelector("[data-file-prog]");
        prog.hidden = false;
        btn.innerHTML = '<span class="spin"></span> アップロード中…';
        uploaded = await uploadDocFile(fileState.pending, p => {
          prog.querySelector("i").style.width = `${Math.round(p * 100)}%`;
          prog.querySelector("b").textContent = `${Math.round(p * 100)}%`;
        });
        Object.assign(data, uploaded);
      } else if (fbox && fileState.removed) {
        Object.assign(data, { filePath: "", fileName: "", fileSize: 0, fileType: "" });
      }
      if (name === "members") {
        const members = await getRows("members");
        const member = members.find(r => r.id === row?.id);
        // 有効な会員で番号が空欄なら自動で採番
        if (!data.memberNo && member?.status === "active") data.memberNo = await issueMemberNo();
        // 他の会員と同じ番号は保存しない
        const dup = data.memberNo && members.find(r => r.id !== row?.id && r.memberNo === data.memberNo);
        if (dup) { toast(`会員番号「${data.memberNo}」は ${dup.name} さんが使用しています。別の番号にするか「自動生成」を押してください。`, "error"); btn.disabled = false; return; }
      }
      await adminApi.save(name, row?.id || null, data);
      // 差し替え・取り外したときは、前のファイルを削除
      if (fbox && row?.filePath && (uploaded || fileState.removed)) await deleteDocFile(row.filePath).catch(err => console.warn("前のファイルの削除に失敗", err));
      toast("保存しました。");
      closeDrawer(); invalidate(name); route();
    } catch (err) {
      // 保存に失敗したら、アップロードしたファイルは消しておく
      if (uploaded) deleteDocFile(uploaded.filePath).catch(() => {});
      fail(err.code === "storage/unauthorized" ? "アップロードの権限がありません" : "保存に失敗しました")(err);
      btn.disabled = false; btn.textContent = "保存";
    }
  });
}

// ============================================================
//  会員管理
// ============================================================
let memberFilter = { status: "all", type: "all", q: "" };
async function renderMembers() {
  const safe = (p, v) => p.catch(e => { console.warn(e); return v; });
  const [rows, reviews, setting] = await Promise.all([getRows("members", true), safe(getRows("reviews", true), []), safe(getReviewSetting(), {})]);
  const hasGroup = !!setting.groupId;
  const count = (st) => st === "all" ? rows.length : rows.filter(r => r.status === st).length;
  $("page").innerHTML = `
    <div class="toolbar">
      <div class="chips" id="chips">${["all", "pending", "active", "suspended", "rejected"].map(st =>
        `<button class="chip${memberFilter.status === st ? " is-active" : ""}" data-st="${st}">${st === "all" ? "すべて" : MEMBER_STATUS[st]}<span class="n">${count(st)}</span></button>`).join("")}</div>
      <span class="spacer"></span>
      <select class="sel" id="type-filter"><option value="all">すべての種別</option>${Object.entries(MEMBER_TYPE).map(([k, l]) => `<option value="${k}"${memberFilter.type === k ? " selected" : ""}>${l}</option>`).join("")}</select>
      <input class="search" id="q" type="search" placeholder="名前・メール・会員番号で検索" value="${esc(memberFilter.q)}">
    </div>
    <div class="card table-wrap"><table class="tbl cards" id="tbl">
      <thead><tr><th>状態</th><th>お名前 / メール</th><th>種別・会員番号</th><th>申込日 / 承認日</th><th></th></tr></thead><tbody></tbody></table></div>`;
  const draw = () => {
    const q = memberFilter.q.toLowerCase();
    const list = rows
      .filter(r => memberFilter.status === "all" || r.status === memberFilter.status)
      .filter(r => memberFilter.type === "all" || r.type === memberFilter.type)
      .filter(r => !q || `${r.name} ${r.kana || ""} ${r.email} ${r.memberNo || ""} ${r.affiliation || ""} ${r.occupation || ""}`.toLowerCase().includes(q))
      .sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1));
    $("tbl").querySelector("tbody").innerHTML = list.length ? list.map(r => `<tr>
      <td class="st">${pill(r.status, MEMBER_STATUS[r.status] || r.status)}${reviewBadge(reviewOf(reviews, r.id))}${
        r.signatureRewrite === "requested" ? pill("pending", "署名の書き直し申請中") : r.signatureRewrite === "allowed" ? pill("info", "署名の書き直し許可済み") : ""}${
        r.typeRequest ? pill("pending", `種別変更の申請：→ ${MEMBER_TYPE[r.typeRequest] || r.typeRequest}`) : ""}</td>
      <td class="main"><b>${esc(r.name)}</b>（${esc(r.kana || "")}）<span class="sub"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></span>${r.occupation || r.affiliation ? `<span class="sub">${esc([r.occupation, r.affiliation].filter(Boolean).join("／"))}</span>` : ""}</td>
      <td data-label="種別">${esc(MEMBER_TYPE[r.type] || r.type)}${r.memberNo ? `<span class="sub">${esc(r.memberNo)}</span>` : r.status === "pending" ? '<span class="sub hide-sm">承認時に自動付与</span>' : ""}
        ${(r.type === "student" && r.status === "pending") || r.typeRequest === "student" ? `<button class="btn btn-sm" data-sid="${esc(r.id)}" style="margin-top:4px">学生証を見る</button>` : ""}
        ${r.typeRequest && r.typeRequestReason ? `<span class="sub">変更の理由：${esc(r.typeRequestReason)}</span>` : ""}</td>
      <td data-label="申込日">${fmtD(r.createdAt)}${r.approvedAt ? `<span class="sub">承認 ${fmtD(r.approvedAt)}</span>` : ""}</td>
      <td class="act">
        ${reviewOf(reviews, r.id) || (r.status === "pending" && hasGroup) ? `<button class="btn btn-sm" data-review="${esc(r.id)}">審査状況</button>` : ""}
        ${r.status === "pending" ? `<button class="btn btn-sm btn-ok" data-approve="${esc(r.id)}">承認</button><button class="btn btn-sm btn-danger" data-reject="${esc(r.id)}">否認</button>` : ""}
        ${r.signatureRewrite === "requested" ? `<button class="btn btn-sm btn-ok" data-sigallow="${esc(r.id)}">署名の書き直しを許可</button><button class="btn btn-sm btn-danger" data-sigdeny="${esc(r.id)}">却下</button>` : ""}
        ${r.signatureRewrite === "allowed" ? `<button class="btn btn-sm" data-sigdeny="${esc(r.id)}">許可を取り消す</button>` : ""}
        ${r.typeRequest ? `<button class="btn btn-sm btn-ok" data-typeallow="${esc(r.id)}">種別変更を許可</button><button class="btn btn-sm btn-danger" data-typedeny="${esc(r.id)}">却下</button>` : ""}
        ${r.cardSignature ? `<button class="btn btn-sm" data-sigview="${esc(r.id)}">署名</button>` : ""}
        ${r.status === "active" ? `<button class="btn btn-sm" data-suspend="${esc(r.id)}">停止</button>` : ""}
        ${r.status === "suspended" ? `<button class="btn btn-sm" data-activate="${esc(r.id)}">再開</button>` : ""}
        <button class="btn btn-sm" data-edit="${esc(r.id)}">編集</button>
        <button class="btn btn-sm btn-danger" data-del="${esc(r.id)}">削除</button>
      </td></tr>`).join("")
      : '<tr><td colspan="5" class="empty">該当する会員・申込はありません。</td></tr>';
  };
  draw();
  $("chips").addEventListener("click", e => {
    const st = e.target.closest("[data-st]")?.dataset.st;
    if (!st) return;
    memberFilter.status = st;
    $("chips").querySelectorAll(".chip").forEach(c => c.classList.toggle("is-active", c.dataset.st === st));
    draw();
  });
  $("type-filter").addEventListener("change", e => { memberFilter.type = e.target.value; draw(); });
  $("q").addEventListener("input", e => { memberFilter.q = e.target.value.trim(); draw(); });
}

/** 会員の状態を更新 */
async function setMember(id, data, msg) {
  await adminApi.save("members", id, data);
  toast(msg);
  invalidate("members");
}
/** 学生証の画像を削除（審査にのみ使用するため、承認・否認・削除のときに消す） */
const removeStudentId = (id) => adminApi.remove("student_ids", id).catch(err => console.warn("学生証の削除に失敗", err));

// 会員の操作ボタン（ダッシュボードと会員管理で共通）
$("page").addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const { sid, approve, reject, suspend, activate, review, sigallow, sigdeny, sigview, typeallow, typedeny } = t.dataset;
  const isMembers = location.hash.startsWith("#members");
  const del = isMembers ? t.dataset.del : null, edit = isMembers ? t.dataset.edit : null;
  const target = sid || approve || reject || suspend || activate || del || edit || review || sigallow || sigdeny || sigview || typeallow || typedeny;
  if (!target) return;
  const members = await getRows("members");
  const r = members.find(x => x.id === target);
  if (!r) return;
  // 会員種別の変更申請（許可・却下）。学生証の画像は審査にのみ使うので、どちらの場合も削除
  if (typeallow || typedeny) {
    const allow = !!typeallow;
    const from = MEMBER_TYPE[r.type] || r.type, to = MEMBER_TYPE[r.typeRequest] || r.typeRequest;
    if (!window.confirm(allow ? `${r.name} さんの会員種別を「${from}」から「${to}」に変更します。よろしいですか？` : `${r.name} さんの会員種別の変更申請（${from} → ${to}）を却下します。よろしいですか？`)) return;
    try {
      await updateDoc(doc(db, "members", r.id), {
        ...(allow ? { type: r.typeRequest } : {}),
        typeRequest: deleteField(), typeRequestReason: deleteField(), typeRequestAt: deleteField(),
        typeDecision: allow ? "approved" : "rejected", typeDecisionTo: r.typeRequest, typeDecidedBy: currentAdmin.uid, typeDecidedAt: new Date()
      });
      if (r.typeRequest === "student") await removeStudentId(r.id);
      toast(allow ? `会員種別を「${to}」に変更しました。本人にメールでお知らせします。` : "申請を却下しました。本人にメールでお知らせします。");
      invalidate("members"); refreshBadges(); route();
    } catch (err) { console.error(err); toast("更新に失敗しました：" + err.message, "error"); }
    return;
  }
  // 会員証の署名の書き直し（申請の許可・却下、現在の署名の確認）
  if (sigview) {
    const body = openModal(`${r.name} さんの会員証の署名`, '<div class="sig-view"><img alt="署名"></div>');
    body.querySelector("img").src = r.cardSignature || "";
    return;
  }
  if (sigallow || sigdeny) {
    const allow = !!sigallow;
    const msg = allow ? `${r.name} さんの会員証の署名の書き直しを許可します（1 回のみ）。よろしいですか？`
      : r.signatureRewrite === "allowed" ? `${r.name} さんへの書き直しの許可を取り消します。よろしいですか？` : `${r.name} さんの書き直しの申請を却下します。よろしいですか？`;
    if (!window.confirm(msg)) return;
    try {
      await updateDoc(doc(db, "members", r.id), allow
        ? { signatureRewrite: "allowed", signatureRewriteBy: currentAdmin.uid, signatureRewriteAt: new Date() }
        : { signatureRewrite: deleteField(), signatureRewriteBy: currentAdmin.uid, signatureRewriteAt: new Date() });
      toast(allow ? "書き直しを許可しました。本人にメールでお知らせします。" : "取り消しました。");
      invalidate("members"); refreshBadges(); route();
    } catch (err) { console.error(err); toast("更新に失敗しました：" + err.message, "error"); }
    return;
  }
  // 理事会の審査中かどうか（管理者が手動で確定するときは確認文に添える）
  const underReview = (approve || reject) ? reviewOf(await getRows("reviews").catch(() => []), r.id)?.status === "open" : false;
  const boardNote = underReview ? BOARD_NOTE : "";
  try {
    if (review) return openReviewView(r);
    if (sid) {
      const image = await getStudentId(sid);
      if (!image) return toast(`${r.name} さんの学生証の画像は登録されていません（承認・否認済みの場合は削除されています）。`, "error");
      const body = openModal(`${r.name} さんの学生証（表面）`, '<img class="img-view" alt="学生証（表面）">');
      body.querySelector("img").src = image;
      return;
    }
    if (edit) return openEditor("members", r);
    if (approve) {
      if (!window.confirm(`${r.name} さんを委員会承認として登録します。${r.memberNo ? `\n会員番号：${r.memberNo}` : "\n会員番号は自動で採番されます。"}${boardNote}`)) return;
      const no = r.memberNo || await issueMemberNo();
      await setMember(approve, { status: "active", memberNo: no, approvedAt: new Date(), approvedBy: currentAdmin.uid }, `${r.name} さんを承認しました（${no}）。`);
      // 承認後は学生証の画像は不要なので削除（審査にのみ使用）
      if (r.type === "student") await removeStudentId(approve);
    } else if (reject) {
      if (!window.confirm(`${r.name} さんの入会申込を否認します。よろしいですか？${boardNote}`)) return;
      await setMember(reject, { status: "rejected", rejectedAt: new Date(), rejectedBy: currentAdmin.uid }, `${r.name} さんの申込を否認しました。`);
      // 否認したときも学生証の画像は不要なので削除
      if (r.type === "student") await removeStudentId(reject);
    } else if (suspend) {
      if (!window.confirm(`${r.name} さんの会員資格を停止しますか？`)) return;
      await setMember(suspend, { status: "suspended" }, "会員資格を停止しました。");
    } else if (activate) {
      await setMember(activate, { status: "active" }, "会員資格を再開しました。");
    } else if (del) {
      if (!window.confirm(`「${r.name}」さんの会員データを削除します。よろしいですか？`)) return;
      await adminApi.remove("members", del);
      // 学生会員は学生証の画像も一緒に削除
      if (r.type === "student") await removeStudentId(del);
      toast("削除しました。");
      invalidate("members");
    }
    invalidate("reviews");
    route(); refreshBadges();
  } catch (err) { fail("処理に失敗しました")(err); }
});

// ============================================================
//  お問い合わせ
// ============================================================
async function renderContacts() {
  const rows = (await getRows("contacts", true)).slice().sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0));
  $("page").innerHTML = `
    <div class="toolbar"><input class="search" id="q" type="search" placeholder="名前・メール・内容で検索"></div>
    <div class="card table-wrap"><table class="tbl cards" id="tbl">
      <thead><tr><th>受信日時</th><th>種別</th><th>お名前 / メール</th><th>内容</th><th></th></tr></thead><tbody></tbody></table></div>`;
  const draw = () => {
    const q = $("q").value.trim().toLowerCase();
    const list = rows.filter(r => !q || `${r.name} ${r.email} ${r.subject} ${r.message}`.toLowerCase().includes(q));
    $("tbl").querySelector("tbody").innerHTML = list.length ? list.map(r => `<tr>
      <td data-label="受信">${fmtDT(r.createdAt)}</td>
      <td data-label="種別">${pill("info", r.subject || "")}</td>
      <td class="main"><b>${esc(r.name)}</b><span class="sub"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></span></td>
      <td class="msg-cell">${esc(r.message)}</td>
      <td class="act"><a class="btn btn-sm" href="mailto:${esc(r.email)}?subject=${encodeURIComponent("Re: " + (r.subject || "お問い合わせ"))}">返信</a><button class="btn btn-sm btn-danger" data-del="${esc(r.id)}">削除</button></td></tr>`).join("")
      : '<tr><td colspan="5" class="empty">お問い合わせはありません。</td></tr>';
  };
  draw();
  $("q").addEventListener("input", draw);
  $("tbl").addEventListener("click", async e => {
    const id = e.target.dataset.del;
    if (!id) return;
    const r = rows.find(x => x.id === id);
    if (!window.confirm(`${r.name} さんからのお問い合わせを削除します。よろしいですか？`)) return;
    try { await adminApi.remove("contacts", id); toast("削除しました。"); invalidate("contacts"); route(); }
    catch (err) { fail("削除に失敗しました")(err); }
  });
}

// ============================================================
//  管理者（オーナー専用）
// ============================================================
async function renderAdmins() {
  const [admins, invites] = await Promise.all([adminApi.listAll("admins"), adminApi.listAll("admin_invites")]);
  admins.sort((a, b) => (a.role === "owner" ? -1 : 1) - (b.role === "owner" ? -1 : 1));
  $("page").innerHTML = `
    <section class="card" style="margin-bottom:20px">
      <div class="card-head"><h2>管理者を招待する</h2></div>
      <div class="card-body">
        <p class="muted small" style="margin-top:0">招待したメールアドレスで管理画面に登録・ログインすると、自動で管理者になります。招待した方には、管理画面のURL（${esc(location.origin)}/admin.html）をお知らせください（招待メールも自動で届きます）。</p>
        <form id="invite-form" class="row2" style="align-items:end">
          <label class="fld"><span>メールアドレス</span><input type="email" id="inv-email" required></label>
          <label class="fld"><span>お名前</span><input type="text" id="inv-name" maxlength="100" required></label>
          <div><button class="btn btn-primary" type="submit">招待する</button></div>
        </form>
      </div>
    </section>
    <div class="card table-wrap"><table class="tbl cards" id="tbl">
      <thead><tr><th>役割</th><th>お名前 / メール</th><th>登録日</th><th></th></tr></thead>
      <tbody>
      ${admins.map(a => `<tr>
        <td class="st">${a.role === "owner" ? pill("gold", "オーナー") : pill("info", "管理者")}</td>
        <td class="main"><b>${esc(a.name || "")}</b><span class="sub">${esc(a.email || a.id)}</span></td>
        <td data-label="登録日">${fmtD(a.createdAt)}</td>
        <td class="act">${a.role === "owner" ? "" : `<button class="btn btn-sm btn-danger" data-deladmin="${esc(a.id)}">管理者から外す</button>`}</td></tr>`).join("")}
      <tr><th colspan="4">招待中（未登録）</th></tr>
      ${invites.length ? invites.map(i => `<tr>
        <td class="st">${pill("draft", "招待中")}</td>
        <td class="main"><b>${esc(i.name || "")}</b><span class="sub">${esc(i.email)}</span></td>
        <td data-label="招待日">${fmtD(i.createdAt)}</td>
        <td class="act"><button class="btn btn-sm" data-delinvite="${esc(i.id)}">招待を取り消す</button></td></tr>`).join("")
        : '<tr><td colspan="4" class="empty">招待中の方はいません。</td></tr>'}
      </tbody></table></div>`;
  $("invite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("inv-email").value.trim().toLowerCase(), name = $("inv-name").value.trim();
    try { await adminApi.invite(email, name, currentAdmin.uid); toast(`${email} を招待しました。`); route(); }
    catch (err) { fail("招待に失敗しました")(err); }
  });
  $("tbl").addEventListener("click", async e => {
    const { deladmin, delinvite } = e.target.dataset;
    try {
      if (deladmin) {
        const a = admins.find(x => x.id === deladmin);
        if (!window.confirm(`${a.name || a.email} さんを管理者から外します。よろしいですか？`)) return;
        await adminApi.remove("admins", deladmin); toast("管理者から外しました。"); route();
      }
      if (delinvite) { await adminApi.remove("admin_invites", delinvite); toast("招待を取り消しました。"); route(); }
    } catch (err) { fail("失敗しました")(err); }
  });
}

// ============================================================
//  理事会（理事のグループ）と入会審査
//  ・board_groups … 理事会（name, description, members: [{ name, email }]）
//  ・settings/review … 入会審査を担当する理事会（groupId。空なら従来どおり管理者が承認）
//  ・reviews/{会員UID} … 理事会の審査状況（Cloud Functions が作成・更新。理由は申込者には見せない）
//  ・adminReview（呼び出し用の関数）… 審査の開始・未回答の理事への再送
// ============================================================
const BOARD_NOTE = "\n\n理事会の審査中です。管理者の判断で確定しますか？";
const REVIEW_STATUS = { open: "理事会審査中", approved: "理事会：全員承認", rejected: "理事会：否認", closed: "理事会審査：終了" };
const DECISION = { approve: { label: "承認", cls: "ok" }, reject: { label: "非承認", cls: "ng" } };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 入会審査を担当する理事会の設定（無ければ {}） */
async function getReviewSetting() {
  const snap = await getDoc(doc(db, "settings", "review"));
  return snap.exists() ? snap.data() : {};
}
const reviewOf = (reviews, memberId) => (reviews || []).find(v => v.id === memberId || v.memberId === memberId) || null;

/** 審査状況のラベル（例：理事会審査中 3/5 承認） */
function reviewBadge(rv, inline = false) {
  if (!rv) return "";
  const cls = { open: "pending", approved: "ok", rejected: "ng", closed: "closed" }[rv.status] || "info";
  const text = rv.status === "open" ? `理事会審査中 ${rv.approveCount || 0}/${rv.total || 0} 承認` : REVIEW_STATUS[rv.status] || rv.status;
  return `<span class="rv-badge${inline ? " inline" : ""}">${pill(cls, text)}</span>`;
}

/** 理事会の審査を操作する（start：審査開始 / resend：未回答の理事に再送） */
async function callReview(action, memberId) {
  const fn = httpsCallable(getFunctions(app, "asia-northeast1"), "adminReview");
  return (await fn({ action, memberId })).data;
}

/** 審査状況（理事ごとの承認・非承認と理由）。理由は理事会・管理者のみが見られる */
async function openReviewView(m) {
  const body = openModal(`${m.name} さんの理事会審査`, '<div class="loading"><span class="spin"></span> 読み込み中…</div>', { wide: true });
  const [snap, setting] = await Promise.all([getDoc(doc(db, "reviews", m.id)), getReviewSetting().catch(() => ({}))]);
  const rv = snap.exists() ? { id: snap.id, ...snap.data() } : null;
  const canStart = m.status === "pending" && (!rv || rv.status === "closed");
  if (!rv) {
    body.innerHTML = `<div class="note info">まだ理事会の審査は始まっていません。</div>
      ${canStart ? (setting.groupId
        ? `<p class="muted small">「理事会審査を開始」を押すと、審査を担当する理事会の全員に承認依頼メールが届きます。</p><div class="rv-actions"><button class="btn btn-primary" data-rv="start">理事会審査を開始</button></div>`
        : `<p class="muted small">審査を担当する理事会が設定されていません。<a href="#board">理事会</a>の画面で設定してください（未設定の場合は管理者が承認・否認します）。</p>`) : ""}`;
  } else {
    const voters = Object.entries(rv.voters || {}).map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => (a.decision ? 0 : 1) - (b.decision ? 0 : 1) || String(a.name).localeCompare(String(b.name), "ja"));
    const waiting = voters.filter(v => !v.decision).length;
    body.innerHTML = `
      <div class="rv-head">
        <div>${reviewBadge(rv)}<span class="muted small" style="margin-left:8px">担当：${esc(rv.groupName || "—")}</span></div>
        <div class="rv-counts">
          <span><b class="c-ok">${rv.approveCount || 0}</b>承認</span>
          <span><b class="c-ng">${rv.rejectCount || 0}</b>非承認</span>
          <span><b>${waiting}</b>未回答</span>
          <span class="muted">／ ${rv.total || voters.length} 名</span>
        </div>
      </div>
      <div class="rv-bar" aria-hidden="true"><i class="ok" style="width:${pct(rv.approveCount, rv.total)}%"></i><i class="ng" style="width:${pct(rv.rejectCount, rv.total)}%"></i></div>
      <p class="muted small">申込：${fmtDT(rv.createdAt)}${rv.decidedAt ? `　／　結果：${fmtDT(rv.decidedAt)}` : ""}${rv.closedReason ? `　／　${esc(rv.closedReason)}` : ""}。
        理由は理事会と管理者だけが見られます（申込者には表示されません）。</p>
      <div class="table-wrap"><table class="tbl cards rv-tbl">
        <thead><tr><th>理事</th><th>判断</th><th>理由</th><th>回答日時 / 依頼メール</th></tr></thead>
        <tbody>${voters.map(v => `<tr>
          <td class="main"><b>${esc(v.name || "")}</b><span class="sub">${esc(v.email || "")}</span></td>
          <td data-label="判断">${v.decision ? pill(DECISION[v.decision]?.cls || "info", DECISION[v.decision]?.label || v.decision) : pill("draft", "未回答")}</td>
          <td data-label="理由" class="rv-reason">${v.reason ? esc(v.reason) : ""}</td>
          <td data-label="回答">${fmtDT(v.decidedAt)}<span class="sub">依頼 ${fmtDT(v.sentAt)}</span></td></tr>`).join("")}</tbody>
      </table></div>
      <div class="rv-actions">
        ${rv.status === "open" && waiting ? `<button class="btn" data-rv="resend">未回答の理事に再送（${waiting} 名）</button>` : ""}
        ${canStart && setting.groupId ? `<button class="btn btn-primary" data-rv="start">理事会審査をやり直す</button>` : ""}
      </div>`;
  }
  body.querySelectorAll("[data-rv]").forEach(b => b.addEventListener("click", async () => {
    const action = b.dataset.rv;
    if (action === "start" && !window.confirm(`${m.name} さんの理事会審査を開始し、理事全員に承認依頼メールを送ります。よろしいですか？`)) return;
    b.disabled = true;
    try {
      const res = await callReview(action, m.id);
      toast(action === "start" ? `理事会審査を開始しました（${res?.sent ?? 0} 名に送信）。` : `未回答の理事 ${res?.sent ?? 0} 名に再送しました。`);
      invalidate("reviews");
      openReviewView(m);
      if (location.hash.startsWith("#members") || !location.hash || location.hash === "#dashboard") route();
    } catch (err) { fail(action === "start" ? "審査を開始できませんでした" : "再送できませんでした")(err); b.disabled = false; }
  }));
}
const pct = (n, total) => total ? Math.round((Number(n) || 0) / total * 100) : 0;

/** 理事会の画面 */
async function renderBoard() {
  const [groups, setting] = await Promise.all([getRows("board_groups", true), getReviewSetting()]);
  groups.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
  const cur = setting.groupId || "";
  const curGroup = groups.find(g => g.id === cur);
  $("page").innerHTML = `
    <section class="card" style="margin-bottom:20px">
      <div class="card-head"><h2>入会審査を担当する理事会</h2>${curGroup ? pill("ok", "理事会審査：有効") : pill("closed", "管理者が承認")}</div>
      <div class="card-body">
        <div class="note info" style="margin-bottom:14px">新しい入会申込は、ここで選んだ理事会の全員に承認依頼メールが届きます。
          <b>全員が承認すると自動で入会承認、1人でも非承認なら自動で否認</b>され、申込者に結果のメールが届きます。
          承認・非承認の理由は必須で、理事会と管理者だけが見られます（申込者には表示されません）。<br>
          未選択の場合は、従来どおり管理者が「会員管理」で承認・否認します。</div>
        <form id="rv-setting" class="rv-setting">
          <label class="fld" style="margin:0;flex:1"><span>担当する理事会</span>
            <select name="groupId"><option value="">（選択しない：管理者が承認）</option>${groups.map(g => `<option value="${esc(g.id)}"${g.id === cur ? " selected" : ""}>${esc(g.name)}（${(g.members || []).length} 名）</option>`).join("")}</select></label>
          <button class="btn btn-primary" type="submit">保存</button>
        </form>
        ${setting.updatedAt ? `<p class="muted small" style="margin:8px 0 0">最終更新：${fmtDT(setting.updatedAt)}</p>` : ""}
      </div>
    </section>
    <div class="toolbar"><h2 class="sec-title">理事会の一覧</h2><span class="spacer"></span><button class="btn btn-primary" id="new-group">${icon("plus")}理事会を作成</button></div>
    ${groups.length ? `<div class="group-grid">${groups.map(g => `
      <section class="card group${g.id === cur ? " is-current" : ""}">
        <div class="card-head"><h3>${esc(g.name)}</h3>${g.id === cur ? pill("gold", "審査担当") : ""}</div>
        <div class="card-body">
          ${g.description ? `<p class="muted small" style="margin-top:0">${esc(g.description)}</p>` : ""}
          <div class="small muted">理事 ${(g.members || []).length} 名</div>
          <ul class="member-list">${(g.members || []).map(p => `<li><b>${esc(p.name || "")}</b><span>${esc(p.email)}</span></li>`).join("")}</ul>
          <div class="group-actions">
            <button class="btn btn-sm" data-gedit="${esc(g.id)}">編集</button>
            <button class="btn btn-sm btn-danger" data-gdel="${esc(g.id)}">削除</button>
          </div>
        </div>
      </section>`).join("")}</div>`
      : '<div class="card"><div class="empty">理事会はまだありません。「理事会を作成」から、理事の名前とメールアドレスを登録してください。</div></div>'}`;

  $("rv-setting").addEventListener("submit", async (e) => {
    e.preventDefault();
    const groupId = e.target.elements.groupId.value;
    const g = groups.find(x => x.id === groupId);
    if (g && !(g.members || []).length) return toast("理事が登録されていない理事会は選べません。", "error");
    try {
      await setDoc(doc(db, "settings", "review"), { groupId, updatedAt: new Date(), updatedBy: currentAdmin.uid });
      toast(g ? `入会審査の担当を「${g.name}」にしました。` : "理事会審査を使わない設定にしました（管理者が承認します）。");
      route();
    } catch (err) { fail("保存できませんでした")(err); }
  });
  $("new-group").addEventListener("click", () => openGroupEditor(null));
  $("page").querySelectorAll("[data-gedit]").forEach(b => b.addEventListener("click", () => openGroupEditor(groups.find(g => g.id === b.dataset.gedit))));
  $("page").querySelectorAll("[data-gdel]").forEach(b => b.addEventListener("click", async () => {
    const g = groups.find(x => x.id === b.dataset.gdel);
    if (g.id === cur) return toast("入会審査を担当している理事会は削除できません。先に担当を変更してください。", "error");
    if (!window.confirm(`理事会「${g.name}」を削除します。よろしいですか？\n（これまでの審査の記録は残ります）`)) return;
    try { await deleteDoc(doc(db, "board_groups", g.id)); toast("削除しました。"); invalidate("board_groups"); route(); }
    catch (err) { fail("削除できませんでした")(err); }
  }));
}

/** 理事会の作成・編集（右から出るパネル） */
function openGroupEditor(g) {
  const row = (p = {}) => `<div class="dir-row">
      <input name="dname" placeholder="お名前" maxlength="100" value="${esc(p.name || "")}">
      <input name="demail" type="email" placeholder="メールアドレス" maxlength="200" value="${esc(p.email || "")}">
      <button type="button" class="icon-btn" data-rm aria-label="この理事を削除">✕</button>
    </div>`;
  const body = openDrawer(g ? `理事会を編集：${g.name}` : "理事会を作成", `
    <form id="grp-form" novalidate>
      <label class="fld"><span>理事会の名前<span class="req">必須</span></span><input name="name" required maxlength="100" value="${esc(g?.name || "")}" placeholder="例：2026年度 理事会"></label>
      <label class="fld"><span>説明（任意）</span><input name="description" maxlength="300" value="${esc(g?.description || "")}" placeholder="例：入会審査を担当"></label>
      <div class="fld"><span>理事（承認依頼メールの送り先）<span class="req">必須</span></span>
        <div id="dirs" class="dirs">${(g?.members?.length ? g.members : [{}]).map(row).join("")}</div>
        <div><button type="button" class="btn btn-sm" id="add-dir">${icon("plus")}理事を追加</button></div>
        <span class="hint">審査では、ここに登録した全員の承認が必要です。理事が審査中に入れ替わった場合は、会員管理の「審査状況」から審査をやり直せます。</span>
      </div>
      <div id="grp-err"></div>
      <div class="drawer-foot">
        <button type="button" class="btn" data-close>キャンセル</button>
        <button type="submit" class="btn btn-primary" id="grp-save">保存</button>
      </div>
    </form>`);
  const form = body.querySelector("#grp-form"), dirs = body.querySelector("#dirs");
  body.querySelector("#add-dir").addEventListener("click", () => { dirs.insertAdjacentHTML("beforeend", row()); dirs.lastElementChild.querySelector("input").focus(); });
  dirs.addEventListener("click", e => {
    if (!e.target.closest("[data-rm]")) return;
    e.target.closest(".dir-row").remove();
    if (!dirs.children.length) dirs.insertAdjacentHTML("beforeend", row());
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = (msg) => { body.querySelector("#grp-err").innerHTML = `<div class="note error" style="margin-top:8px">${esc(msg)}</div>`; };
    const name = form.elements.name.value.trim();
    if (!name) { form.elements.name.focus(); return err("理事会の名前を入力してください。"); }
    const members = [], seen = new Set();
    for (const r of dirs.querySelectorAll(".dir-row")) {
      const n = r.querySelector('[name="dname"]').value.trim(), m = r.querySelector('[name="demail"]').value.trim().toLowerCase();
      r.classList.remove("is-bad");
      if (!n && !m) continue;
      if (!EMAIL_RE.test(m)) { r.classList.add("is-bad"); r.querySelector('[name="demail"]').focus(); return err(`メールアドレスの形式が正しくありません：${m || "（空欄）"}`); }
      if (seen.has(m)) continue; // 同じメールアドレスは 1 人として扱う
      seen.add(m);
      members.push({ name: n || m, email: m });
    }
    if (!members.length) return err("理事を 1 人以上登録してください。");
    const data = { name, description: form.elements.description.value.trim(), members, updatedAt: new Date() };
    const btn = body.querySelector("#grp-save");
    btn.disabled = true;
    try {
      if (g) await updateDoc(doc(db, "board_groups", g.id), data);
      else await addDoc(collection(db, "board_groups"), { ...data, createdAt: new Date() });
      toast(g ? "理事会を更新しました。" : "理事会を作成しました。");
      closeDrawer(); invalidate("board_groups"); route();
    } catch (e2) { fail("保存できませんでした")(e2); btn.disabled = false; }
  });
}

// ============================================================
//  電子同意書
// ============================================================
const formStatusPill = (st) => pill(st, FORM_STATUS_LABEL[st] || st);
const sigTime = (s) => toDate(s.agreedAt) || (s.clientSignedAt ? new Date(s.clientSignedAt) : null);
const signUrl = (id) => `${location.origin}/sign.html?f=${encodeURIComponent(id)}`;

async function renderConsent(sub = "") {
  if (sub === "new") { history.replaceState(null, "", "#consent"); await renderConsentList(); return openFormEditor(null); }
  if (sub) return renderFormDetail(sub);
  return renderConsentList();
}

async function renderConsentList() {
  const [forms, sigs] = await Promise.all([getRows("consent_forms", true), getRows("consent_signatures", true)]);
  const countBy = {};
  sigs.forEach(s => { countBy[s.formId] = (countBy[s.formId] || 0) + 1; });
  forms.sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0));
  $("page").innerHTML = `
    <p class="page-intro">同意書を作成して公開すると、会員は会員サイトで、外部の方は専用URLから手書きで署名できます。公開した文書はSHA-256でハッシュ化され、本文は変更できなくなります。署名はサーバーで封印（HMAC）され、すべての署名がハッシュチェーンでつながります。</p>
    <div class="toolbar">
      <input class="search" id="q" type="search" placeholder="タイトルで検索">
      <span class="spacer"></span>
      <button class="btn" id="chain-btn">${icon("shield").replace("<svg", '<svg width="16" height="16"')} 全署名のハッシュチェーンを検証</button>
      <button class="btn btn-primary" id="new-btn">${icon("plus").replace("<svg", '<svg width="16" height="16"')} 同意書を作成</button>
    </div>
    <div class="card table-wrap"><table class="tbl cards" id="tbl">
      <thead><tr><th>タイトル</th><th>用途</th><th>対象</th><th>状態</th><th>版</th><th>署名数</th><th>公開日</th><th></th></tr></thead><tbody></tbody></table></div>`;
  const draw = () => {
    const q = $("q").value.trim().toLowerCase();
    const list = forms.filter(f => !q || (f.title || "").toLowerCase().includes(q));
    $("tbl").querySelector("tbody").innerHTML = list.length ? list.map(f => `<tr class="clickable" data-open="${esc(f.id)}">
      <td class="main"><b>${esc(f.title || "（無題）")}</b>${f.deadline ? `<span class="sub">期限 ${esc(fmtDate(f.deadline))}</span>` : ""}</td>
      <td data-label="用途">${f.purpose === "membership" ? pill("gold", PURPOSE_LABEL.membership) : esc(PURPOSE_LABEL[f.purpose] || "一般")}</td>
      <td data-label="対象">${esc(AUDIENCE_LABEL[f.audience] || f.audience || "")}</td>
      <td data-label="状態">${formStatusPill(f.status)}</td>
      <td data-label="版">第${esc(f.version || 1)}版</td>
      <td data-label="署名数">${countBy[f.id] || 0}</td>
      <td data-label="公開日">${fmtD(f.publishedAt)}</td>
      <td class="act"><button class="btn btn-sm" data-open="${esc(f.id)}">開く</button></td></tr>`).join("")
      : '<tr><td colspan="8" class="empty">同意書はまだありません。「同意書を作成」から作れます。</td></tr>';
  };
  draw();
  $("q").addEventListener("input", draw);
  $("new-btn").addEventListener("click", () => openFormEditor(null));
  $("chain-btn").addEventListener("click", runChainCheck);
  $("tbl").addEventListener("click", e => {
    const id = e.target.closest("[data-open]")?.dataset.open;
    if (id) location.hash = `#consent/${encodeURIComponent(id)}`;
  });
}

/** 全署名のハッシュチェーンを検証 */
async function runChainCheck() {
  const body = openModal("ハッシュチェーンの検証", '<div class="loading"><span class="spin"></span> すべての署名を検証しています…</div>');
  try {
    const r = await verifyChain();
    const broken = Array.isArray(r?.broken) ? r.broken : [];
    body.innerHTML = `
      <div class="note ${r?.ok ? "success" : "error"}"><b>${r?.ok ? "改ざんは見つかりませんでした" : "問題が見つかりました"}</b><br>${esc(r?.summary || "")}</div>
      <p class="muted small">検証した署名：${esc(r?.total ?? "—")} 件</p>
      ${broken.length ? `<ul class="checks">${broken.map(b => `<li class="ng"><span class="mk">!</span><div>${esc(typeof b === "string" ? b : [b.seq != null ? `#${b.seq}` : "", b.id || "", b.reason || b.detail || ""].filter(Boolean).join("　"))}</div></li>`).join("")}</ul>` : ""}`;
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="note error">検証できませんでした：${esc(e.message)}<br><span class="small">サーバーの検証機能（verifyConsent）が公開されているか確認してください。</span></div>`;
  }
}

/** 同意書の作成・編集（下書きのみ） */
async function openFormEditor(f) {
  const extra = f?.extraFields || [];
  const body = openDrawer(f ? `同意書を編集（第${f.version || 1}版・下書き）` : "同意書を作成", `
    <form id="cf-form" novalidate>
      <div class="note info" style="margin-bottom:16px">下書きの間は自由に編集できます。<b>公開すると本文・対象などは変更できません</b>（改ざん防止のため）。修正が必要になったら「新しい版を作る」から作り直します。</div>
      <label class="fld"><span>タイトル<span class="req">必須</span></span><input name="title" required maxlength="200" value="${esc(f?.title || "")}" placeholder="例：写真・映像の利用に関する同意書"></label>
      <div class="row2">
        <label class="fld"><span>用途</span><select name="purpose">${Object.entries(PURPOSE_LABEL).map(([k, l]) => `<option value="${k}"${(f?.purpose || "general") === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        <label class="fld"><span>署名できる人</span><select name="audience">${Object.entries(AUDIENCE_LABEL).map(([k, l]) => `<option value="${k}"${(f?.audience || "members") === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
          <span class="hint" id="aud-hint"></span></label>
      </div>
      <div class="fld"><span>外部の方に追加で入力してもらう項目（氏名・メールは必須で入ります）</span>
        <div>${Object.entries(EXTRA_FIELDS).map(([k, x]) => `<label class="check" style="display:inline-flex;margin-right:18px"><input type="checkbox" name="extra" value="${k}"${extra.includes(k) ? " checked" : ""}> ${esc(x.label)}</label>`).join("")}</div></div>
      <label class="fld" style="max-width:260px"><span>署名の期限（目安・任意）</span><input type="date" name="deadline" value="${esc(f?.deadline || "")}"></label>
      <div class="fld"><span>本文<span class="req">必須</span></span><div data-rich="body"></div></div>
      <div class="drawer-foot">
        <button type="button" class="btn" id="preview-btn">プレビュー</button>
        <span style="flex:1"></span>
        <button type="button" class="btn" data-close>キャンセル</button>
        <button type="submit" class="btn btn-primary" id="save-btn">下書きを保存</button>
      </div>
    </form>`);
  const form = body.querySelector("#cf-form");
  const syncPurpose = () => {
    const membership = form.elements.purpose.value === "membership";
    if (membership) form.elements.audience.value = "public";
    form.elements.audience.disabled = membership;
    body.querySelector("#aud-hint").textContent = membership ? "入会規約は、ログイン前の入会申込ページで読み込むため「外部の方」に固定されます。" : "";
  };
  form.elements.purpose.addEventListener("change", syncPurpose);
  syncPurpose();
  const host = body.querySelector("[data-rich]");
  host.innerHTML = '<div class="loading"><span class="spin"></span> エディタを読み込み中…</div>';
  let ed = null;
  try { ed = await createRichEditor(host, { html: f?.bodyHtml || "", placeholder: "同意書の本文を入力…", notify: (m, isErr) => toast(m, isErr ? "error" : "info") }); }
  catch (e) { host.innerHTML = `<div class="note error">${esc(e.message)}</div>`; }
  body.querySelector("#preview-btn").addEventListener("click", async () => {
    const out = openModal("プレビュー", `<h2 style="margin-top:0">${esc(form.elements.title.value)}</h2><div class="preview" id="pv"></div>`, { wide: true });
    await renderRich(out.querySelector("#pv"), { bodyHtml: ed?.getHtml() || "" });
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = form.elements.title.value.trim();
    if (!title) { toast("タイトルを入力してください。", "error"); form.elements.title.focus(); return; }
    if (!ed || ed.isEmpty()) { toast("本文を入力してください。", "error"); return; }
    const purpose = form.elements.purpose.value;
    const data = {
      title, purpose,
      audience: purpose === "membership" ? "public" : form.elements.audience.value,
      extraFields: [...form.querySelectorAll('input[name="extra"]:checked')].map(i => i.value),
      deadline: form.elements.deadline.value,
      bodyHtml: ed.getHtml(), bodyText: ed.getText(),
      updatedAt: new Date()
    };
    const btn = form.querySelector("#save-btn");
    btn.disabled = true;
    try {
      let id = f?.id;
      if (id) await updateDoc(doc(db, "consent_forms", id), data);
      else id = (await addDoc(collection(db, "consent_forms"), { ...data, status: "draft", version: 1, createdAt: new Date(), createdBy: currentAdmin.uid })).id;
      toast("下書きを保存しました。");
      closeDrawer(); invalidate("consent_forms");
      if (location.hash === `#consent/${encodeURIComponent(id)}`) route(); else location.hash = `#consent/${encodeURIComponent(id)}`;
    } catch (err) { fail("保存に失敗しました")(err); btn.disabled = false; }
  });
}

/** QRコード（qrcode-generator を必要なときに読み込む） */
let qrLib = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve();
  qrLib ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  return qrLib;
}

/** 同意書の詳細（状態の変更・署名一覧・検証） */
async function renderFormDetail(id) {
  const snap = await getDoc(doc(db, "consent_forms", id));
  if (!snap.exists()) { $("page").innerHTML = '<div class="note error">同意書が見つかりません。</div><p><a href="#consent">← 一覧へ戻る</a></p>'; return; }
  const f = { id: snap.id, ...snap.data() };
  const sigSnap = await getDocs(query(collection(db, "consent_signatures"), where("formId", "==", id)));
  const sigs = sigSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (sigTime(b) || 0) - (sigTime(a) || 0));
  const forMembers = ["members", "both"].includes(f.audience);
  const forPublic = ["public", "both"].includes(f.audience);
  let unsigned = [];
  if (forMembers) {
    try {
      const signedUids = new Set(sigs.map(s => s.uid).filter(Boolean));
      unsigned = (await getRows("members", true)).filter(m => m.status === "active" && !signedUids.has(m.id));
    } catch (e) { console.warn(e); }
  }

  $("page").innerHTML = `
    <p style="margin:0 0 10px"><a href="#consent">← 同意書の一覧</a></p>
    <div class="form-head">
      <div>
        <div class="meta">${formStatusPill(f.status)} ${pill("info", `第${f.version || 1}版`)} ${f.purpose === "membership" ? pill("gold", PURPOSE_LABEL.membership) : ""} ${pill("closed", AUDIENCE_LABEL[f.audience] || f.audience)}</div>
        <h2>${esc(f.title)}</h2>
        <div class="muted small">作成 ${fmtDT(f.createdAt)}${f.publishedAt ? `　／　公開 ${fmtDT(f.publishedAt)}` : ""}${f.deadline ? `　／　期限 ${esc(fmtDate(f.deadline))}` : ""}${f.previousId ? `　／　<a href="#consent/${encodeURIComponent(f.previousId)}">前の版</a>` : ""}</div>
      </div>
      <div class="form-actions">
        ${f.status === "draft" ? `<button class="btn" id="edit-btn">編集</button><button class="btn btn-ok" id="publish-btn">公開する</button>` : ""}
        ${f.status === "published" ? `<button class="btn" id="close-btn">受付を終了</button>` : ""}
        ${f.status === "closed" ? `<button class="btn btn-ok" id="reopen-btn">受付を再開</button>` : ""}
        ${f.status !== "draft" ? `<button class="btn" id="newver-btn">新しい版を作る</button>` : ""}
        ${f.status === "draft" || isOwner() ? `<button class="btn btn-danger" id="delete-btn">削除</button>` : ""}
      </div>
    </div>
    ${f.contentHash ? `<div class="hashbox" style="margin-bottom:16px"><b>文書ハッシュ<br>SHA-256</b><span class="mono">${esc(fmtHash(f.contentHash))}</span></div>` : ""}
    ${forPublic && f.status !== "draft" ? `<section class="card" style="margin-bottom:16px"><div class="card-head"><h3>外部の方の署名用URL</h3></div>
      <div class="card-body share"><div class="qr" id="qr"></div>
        <div class="link"><input readonly value="${esc(signUrl(f.id))}" id="sign-url">
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" id="copy-btn">URLをコピー</button><a class="btn btn-sm" href="${esc(signUrl(f.id))}" target="_blank" rel="noopener">署名ページを開く ↗</a></div>
          <p class="muted small">このURLやQRコードを、メール・チラシなどでお知らせください。${f.status === "closed" ? "<b>（現在は受付終了中です）</b>" : ""}</p></div></div></section>` : ""}
    <div class="tabs" id="tabs">
      <button class="is-active" data-tab="sigs">署名一覧（${sigs.length}）</button>
      ${forMembers ? `<button data-tab="unsigned">未署名の会員（${unsigned.length}）</button>` : ""}
      <button data-tab="body">本文</button>
    </div>
    <div id="tab-sigs">
      <div class="toolbar"><input class="search" id="q" type="search" placeholder="署名者・メールで検索"><span class="spacer"></span>
        <button class="btn btn-sm" id="csv-btn"${sigs.length ? "" : " disabled"}>CSVで書き出す</button></div>
      <div class="card table-wrap"><table class="tbl cards" id="sig-tbl">
        <thead><tr><th>署名者</th><th>種別</th><th>メール</th><th>署名日時</th><th>封印</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>
    ${forMembers ? `<div id="tab-unsigned" hidden><div class="card table-wrap"><table class="tbl cards"><thead><tr><th>会員番号</th><th>お名前</th><th>メール</th></tr></thead><tbody>
      ${unsigned.length ? unsigned.map(m => `<tr><td data-label="会員番号">${esc(m.memberNo || "—")}</td><td>${esc(m.name)}</td><td><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></td></tr>`).join("") : '<tr><td colspan="3" class="empty">すべての有効会員が署名済みです。</td></tr>'}
      </tbody></table></div>
      ${unsigned.length ? `<p class="muted small">未署名の方へのお知らせには、メールアドレスをまとめてコピーできます。<button class="btn btn-sm" id="copy-emails">メールアドレスをコピー</button></p>` : ""}</div>` : ""}
    <div id="tab-body" hidden><div class="preview" id="body-view"></div></div>`;

  // タブ
  $("tabs").addEventListener("click", e => {
    const tab = e.target.dataset.tab;
    if (!tab) return;
    $("tabs").querySelectorAll("button").forEach(b => b.classList.toggle("is-active", b.dataset.tab === tab));
    ["sigs", "unsigned", "body"].forEach(t => { const el = $(`tab-${t}`); if (el) el.hidden = t !== tab; });
  });
  renderRich($("body-view"), { bodyHtml: f.bodyHtml, body: f.bodyText });

  // 署名一覧
  const drawSigs = () => {
    const q = $("q").value.trim().toLowerCase();
    const list = sigs.filter(s => !q || `${s.name} ${s.email}`.toLowerCase().includes(q));
    $("sig-tbl").querySelector("tbody").innerHTML = list.length ? list.map(s => `<tr>
      <td class="main"><b>${esc(s.name)}</b></td>
      <td data-label="種別">${pill(s.signerType === "member" ? "active" : s.signerType === "applicant" ? "gold" : "info", SIGNER_LABEL[s.signerType] || s.signerType)}</td>
      <td data-label="メール">${esc(s.email)}</td>
      <td data-label="署名日時">${fmtDT(sigTime(s))}</td>
      <td data-label="封印">${s.seal ? pill("ok", `封印済み #${s.seq ?? "?"}`) : pill("draft", "封印待ち")}</td>
      <td class="act"><button class="btn btn-sm" data-sig="${esc(s.id)}">詳細・検証</button></td></tr>`).join("")
      : '<tr><td colspan="6" class="empty">まだ署名はありません。</td></tr>';
  };
  drawSigs();
  $("q").addEventListener("input", drawSigs);
  $("sig-tbl").addEventListener("click", e => {
    const sid = e.target.dataset.sig;
    if (sid) openSignature(f, sigs.find(s => s.id === sid));
  });
  $("csv-btn").addEventListener("click", () => exportCsv(f, sigs));
  $("copy-emails")?.addEventListener("click", () => copy(unsigned.map(m => m.email).join(", "), "メールアドレスをコピーしました。"));

  // 公開用URL・QRコード
  if ($("qr")) {
    loadQr().then(() => { const qr = window.qrcode(0, "M"); qr.addData(signUrl(f.id)); qr.make(); $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); })
      .catch(() => { $("qr").textContent = "QRコードを表示できません"; });
    $("copy-btn").addEventListener("click", () => copy(signUrl(f.id), "URLをコピーしました。"));
  }

  // 状態の変更
  const update = async (data, msg) => {
    try { await updateDoc(doc(db, "consent_forms", f.id), { ...data, updatedAt: new Date() }); toast(msg); invalidate("consent_forms"); route(); }
    catch (err) { fail("更新に失敗しました")(err); }
  };
  $("edit-btn")?.addEventListener("click", () => openFormEditor(f));
  $("publish-btn")?.addEventListener("click", async () => {
    if (!f.title || !f.bodyHtml) return toast("タイトルと本文を入力してから公開してください。", "error");
    if (f.purpose === "membership") {
      const others = (await getRows("consent_forms", true)).filter(x => x.id !== f.id && x.purpose === "membership" && x.status === "published");
      if (others.length && !window.confirm(`公開中の入会規約（${others.map(x => `「${x.title}」第${x.version || 1}版`).join("、")}）があります。入会申込では新しく公開したものが使われます。続けますか？`)) return;
    }
    if (!window.confirm(`「${f.title}」（第${f.version || 1}版）を公開します。\n公開後は本文・対象などを変更できません。よろしいですか？`)) return;
    try {
      // 保存されている内容からハッシュを計算（署名する人が読む内容と同じ）
      const contentHash = await formContentHash(f.id, { title: f.title, bodyHtml: f.bodyHtml, version: f.version || 1 });
      await updateDoc(doc(db, "consent_forms", f.id), { status: "published", contentHash, publishedAt: new Date(), updatedAt: new Date() });
      invalidate("consent_forms");
      await route();
      openModal("公開しました", `<p>「${esc(f.title)}」を公開しました。この文書の SHA-256 ハッシュは次のとおりです。署名にはこの値が記録されます。</p><div class="hashbox"><b>SHA-256</b><span class="mono">${esc(fmtHash(contentHash))}</span></div>`);
    } catch (err) { fail("公開に失敗しました")(err); }
  });
  $("close-btn")?.addEventListener("click", () => window.confirm("署名の受付を終了しますか？（あとで再開できます）") && update({ status: "closed" }, "受付を終了しました。"));
  $("reopen-btn")?.addEventListener("click", () => update({ status: "published" }, "受付を再開しました。"));
  $("newver-btn")?.addEventListener("click", async () => {
    if (!window.confirm(`「${f.title}」の第${(f.version || 1) + 1}版を下書きとして作ります。よろしいですか？`)) return;
    try {
      const ref = await addDoc(collection(db, "consent_forms"), {
        title: f.title, bodyHtml: f.bodyHtml || "", bodyText: f.bodyText || "", purpose: f.purpose || "general",
        audience: f.audience || "members", extraFields: f.extraFields || [], deadline: f.deadline || "",
        status: "draft", version: (Number(f.version) || 1) + 1, previousId: f.id,
        createdAt: new Date(), updatedAt: new Date(), createdBy: currentAdmin.uid
      });
      if (f.status === "published" && window.confirm(`前の版（第${f.version || 1}版）の受付を終了しますか？\n（新しい版を公開するまで署名できなくなります）`)) {
        await updateDoc(doc(db, "consent_forms", f.id), { status: "closed", updatedAt: new Date() });
      }
      toast("新しい版の下書きを作りました。内容を修正して公開してください。");
      invalidate("consent_forms");
      location.hash = `#consent/${encodeURIComponent(ref.id)}`;
      const nf = await getDoc(ref);
      openFormEditor({ id: ref.id, ...nf.data() });
    } catch (err) { fail("作成に失敗しました")(err); }
  });
  $("delete-btn")?.addEventListener("click", async () => {
    const warn = f.status === "draft" ? "" : `\n※ この同意書には ${sigs.length} 件の署名があります（署名の記録は残ります）。`;
    if (!window.confirm(`「${f.title}」を削除します。よろしいですか？${warn}`)) return;
    try { await adminApi.remove("consent_forms", f.id); toast("削除しました。"); invalidate("consent_forms"); location.hash = "#consent"; }
    catch (err) { fail("削除に失敗しました")(err); }
  });
}

const copy = (text, msg) => navigator.clipboard.writeText(text).then(() => toast(msg), () => toast("コピーできませんでした。", "error"));

/** 署名の詳細（ハッシュ・封印・検証・証明書の印刷） */
function openSignature(f, s) {
  const extra = Object.entries(s.extra || {}).filter(([, v]) => v);
  const body = openModal(`署名の詳細：${s.name}`, `
    <img class="sig-img" alt="手書きの署名" id="sig-img">
    <dl class="dl" style="margin-top:14px">
      <dt>署名者</dt><dd>${esc(s.name)}（${esc(SIGNER_LABEL[s.signerType] || s.signerType)}）</dd>
      <dt>メール</dt><dd>${esc(s.email)}</dd>
      ${extra.map(([k, v]) => `<dt>${esc(EXTRA_FIELDS[k]?.label || k)}</dt><dd>${esc(v)}</dd>`).join("")}
      <dt>署名日時（サーバー）</dt><dd>${fmtDT(s.agreedAt)}</dd>
      <dt>署名日時（端末）</dt><dd>${esc(s.clientSignedAt || "—")}</dd>
      <dt>同意書</dt><dd>${esc(s.formTitle || f.title)}（第${esc(s.formVersion || 1)}版）</dd>
      <dt>署名ID</dt><dd class="mono">${esc(s.id)}</dd>
      <dt>文書ハッシュ</dt><dd class="mono">${esc(fmtHash(s.formHash))}</dd>
      <dt>署名画像ハッシュ</dt><dd class="mono">${esc(fmtHash(s.signatureHash))}</dd>
      <dt>記録ハッシュ</dt><dd class="mono">${esc(fmtHash(s.recordHash))}</dd>
      <dt>封印（HMAC）</dt><dd class="mono">${s.seal ? `#${esc(s.seq)}　${esc(fmtHash(s.seal))}` : "封印待ち"}</dd>
      <dt>前の封印</dt><dd class="mono">${esc(fmtHash(s.prevSeal || "—"))}</dd>
      <dt>封印日時</dt><dd>${esc(s.sealedAt ? fmtDT(s.sealedAt) : "—")}</dd>
      <dt>端末</dt><dd class="small muted">${esc(s.userAgent || "—")}</dd>
    </dl>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
      <button class="btn btn-primary" id="verify-btn">${icon("shield").replace("<svg", '<svg width="16" height="16"')} 検証する</button>
      <button class="btn" id="cert-btn">署名証明書を印刷</button>
    </div>
    <div id="verify-out"></div>`, { wide: true });
  body.querySelector("#sig-img").src = s.signatureImage || "";
  body.querySelector("#verify-btn").addEventListener("click", async (e) => {
    const out = body.querySelector("#verify-out");
    e.target.disabled = true;
    out.innerHTML = '<div class="loading"><span class="spin"></span> 検証中…</div>';
    try {
      const r = await verifySignature(s.id);
      const checks = Array.isArray(r?.checks) ? r.checks : [];
      out.innerHTML = `<div class="note ${r?.ok ? "success" : "error"}" style="margin-top:14px"><b>${r?.ok ? "✓ 改ざんは見つかりませんでした" : "✕ 検証で問題が見つかりました"}</b>${r?.summary ? `<br>${esc(r.summary)}` : ""}</div>
        <ul class="checks">${checks.map(c => `<li class="${c.ok ? "ok" : "ng"}"><span class="mk">${c.ok ? "✓" : "✕"}</span><div>${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</div></li>`).join("")}</ul>`;
    } catch (err) {
      console.error(err);
      out.innerHTML = `<div class="note error" style="margin-top:14px">検証できませんでした：${esc(err.message)}</div>`;
    } finally { e.target.disabled = false; }
  });
  body.querySelector("#cert-btn").addEventListener("click", () => printCertificate(f, s));
}

/** 署名証明書（A4）を印刷 */
function printCertificate(f, s) {
  const extra = Object.entries(s.extra || {}).filter(([, v]) => v);
  const area = $("print-area");
  area.innerHTML = `<div class="cert">
    <div class="cert-head"><img src="LOGO.png" alt=""><div><b>普賢アーカイブ運営委員会</b><span>Fugen Archive Development Committee</span></div><h1>署名証明書</h1></div>
    <p>下記の者が、下記の文書に電子的に署名（同意）したことを証明します。署名の記録は SHA-256 によりハッシュ化され、委員会のサーバーで封印されています。</p>
    <h2>文書</h2>
    <table><tr><th>標題</th><td>${esc(s.formTitle || f.title)}</td></tr>
      <tr><th>版</th><td>第${esc(s.formVersion || 1)}版</td></tr>
      <tr><th>文書ハッシュ</th><td class="mono">${esc(s.formHash)}</td></tr></table>
    <h2>署名者</h2>
    <table><tr><th>氏名</th><td>${esc(s.name)}</td></tr>
      <tr><th>区分</th><td>${esc(SIGNER_LABEL[s.signerType] || s.signerType)}</td></tr>
      <tr><th>メール</th><td>${esc(s.email)}</td></tr>
      ${extra.map(([k, v]) => `<tr><th>${esc(EXTRA_FIELDS[k]?.label || k)}</th><td>${esc(v)}</td></tr>`).join("")}
      <tr><th>署名日時</th><td>${fmtDT(s.agreedAt)}</td></tr>
      <tr><th>署名</th><td><img class="sig" src="${esc(s.signatureImage || "")}" alt=""></td></tr></table>
    <h2>改ざん防止の記録</h2>
    <table><tr><th>署名ID</th><td class="mono">${esc(s.id)}</td></tr>
      <tr><th>署名画像ハッシュ</th><td class="mono">${esc(s.signatureHash)}</td></tr>
      <tr><th>記録ハッシュ</th><td class="mono">${esc(s.recordHash)}</td></tr>
      <tr><th>封印番号</th><td>${s.seal ? `#${esc(s.seq)}` : "封印待ち"}</td></tr>
      <tr><th>封印（HMAC-SHA256）</th><td class="mono">${esc(s.seal || "—")}</td></tr>
      <tr><th>前の封印</th><td class="mono">${esc(s.prevSeal || "—")}</td></tr></table>
    <p class="cert-foot">発行日時 ${esc(new Date().toLocaleString("ja-JP"))}　／　発行者 ${esc(currentAdmin.email)}　／　普賢アーカイブ運営委員会 管理コンソール</p>
  </div>`;
  const img = area.querySelector(".sig");
  const go = () => { window.print(); };
  addEventListener("afterprint", () => { area.innerHTML = ""; }, { once: true });
  if (img && !img.complete) img.onload = img.onerror = go; else go();
}

/** 署名一覧を CSV で書き出す（Excel で開けるよう UTF-8 BOM つき） */
function exportCsv(f, sigs) {
  const extraKeys = [...new Set(sigs.flatMap(s => Object.keys(s.extra || {})))];
  const head = ["署名ID", "種別", "氏名", "メール", ...extraKeys.map(k => EXTRA_FIELDS[k]?.label || k), "署名日時", "端末の日時", "版",
    "文書ハッシュ", "署名画像ハッシュ", "記録ハッシュ", "封印番号", "封印", "前の封印"];
  const rows = sigs.map(s => [s.id, SIGNER_LABEL[s.signerType] || s.signerType, s.name, s.email, ...extraKeys.map(k => s.extra?.[k] || ""),
    fmtDT(s.agreedAt), s.clientSignedAt || "", s.formVersion || 1, s.formHash, s.signatureHash, s.recordHash, s.seq ?? "", s.seal || "", s.prevSeal || ""]);
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "﻿" + [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `署名一覧_${(f.title || "同意書").replace(/[\\/:*?"<>|]/g, "_")}_第${f.version || 1}版.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
