// ============================================================
//  データ取得・保存の共通処理（Firebase Firestore）
//  各ページの <script type="module"> から import して使います。
//
//  Firestore のコレクション構成
//    news     : お知らせ（title, date "YYYY-MM-DD", category "topics"|"kaikoku",
//                important(true/false), body, url）
//    events   : 行事（title, date, place, description, url）
//    contacts : お問い合わせ（name, email, subject, message, createdAt）※書き込みのみ
//    admins   : 管理者（ドキュメントID = UID。role: "owner"（オーナー） | "admin"（管理者））
//    counters/memberNo : 会員番号の連番カウンター（seq）
//    admin_invites : 管理者への招待（ドキュメントID = 小文字のメールアドレス）※オーナーのみ作成可
//
//  会員機能（assets/js/member-api.js で使用）
//    members     : 会員（ドキュメントID = 会員の UID）
//    member_news : 会員向けお知らせ（title, date, body, important）
//    member_docs : 会員限定資料（title, category, date, description, url）
//    rsvps       : 行事への参加登録（ID = 行事ID_UID）
//    student_ids : 学生証の画像（審査用。承認・否認で削除）
//
//  電子同意書（assets/js/consent-core.js・functions/consent.js）
//    consent_forms      : 同意書（title, bodyHtml, version, status, audience, purpose, contentHash …）
//    consent_signatures : 署名の記録（ハッシュ値つき。作成後は変更不可、サーバーが封印 seal を付与）
//    consent_chain/head : 封印の連鎖の先頭（サーバーのみ読み書き）
//
//  お知らせ・会員向けお知らせの本文：body（プレーンテキスト）と bodyHtml（装飾つき）
//  画像は Firebase Storage の content/ に保存（storage.rules）
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, orderBy, limit as qLimit, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  createUserWithEmailAndPassword, sendEmailVerification, GoogleAuthProvider, signInWithPopup,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { sampleData } from "./sample-data.js";

// Firebase が未設定ならサンプルデータで動かす
export const isDemo = !firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY";

export let app = null;
export let db = null;
export let auth = null;
if (!isDemo) {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
}

// ---------- ログインを保つ期間（ログイン画面の「1 週間ログインしたままにする」） ----------
//  ・選んだとき：ブラウザを閉じてもログインしたまま。1 週間たつと自動でログアウト。
//    2 段階認証も、この端末では 1 週間省略できる（mfa.js）
//  ・選ばないとき：ブラウザ（タブ）を閉じるとログアウト
const KEEP_KEY = "fa_keep_until", KEEP_PREF = "fa_keep_pref";
export const KEEP_DAYS = 7;
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できない環境 */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* 同上 */ } }
};
/** ログインの直前に呼ぶ（Google はポップアップがブロックされないよう、待たずにログインへ進んでよい） */
export function setKeepLogin(keep) {
  ls.set(KEEP_PREF, keep ? "1" : "0");
  if (keep) ls.set(KEEP_KEY, String(Date.now() + KEEP_DAYS * 86_400_000)); else ls.del(KEEP_KEY);
  return isDemo ? Promise.resolve() : setPersistence(auth, keep ? browserLocalPersistence : browserSessionPersistence);
}
/** 前回のチェックの状態（ログイン画面の初期値） */
export const keepLoginPref = () => ls.get(KEEP_PREF) === "1";
/** 「1 週間ログインしたまま」の期間中か */
export const keepLoginActive = () => Number(ls.get(KEEP_KEY) || 0) > Date.now();
/** 「1 週間ログインしたまま」の期限が過ぎたか（→ ログアウトする） */
export const keepLoginExpired = () => { const v = Number(ls.get(KEEP_KEY) || 0); return v > 0 && v <= Date.now(); };
export const clearKeepLogin = () => ls.del(KEEP_KEY);

/** Google アカウントでログイン（ポップアップ）。会員ページ・管理画面で共通 */
export function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, provider);
}

// ---------- 読み込み ----------
async function list(name, { order = "date", direction = "desc", max = 0 } = {}) {
  if (isDemo) {
    const rows = [...(sampleData[name] || [])];
    rows.sort((a, b) => String(b[order] || "").localeCompare(String(a[order] || "")) * (direction === "desc" ? 1 : -1));
    return max ? rows.slice(0, max) : rows;
  }
  const parts = [collection(db, name), orderBy(order, direction)];
  if (max) parts.push(qLimit(max));
  const snap = await getDocs(query(...parts));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** お知らせ一覧。category: "topics" | "kaikoku" | 省略で全件 */
export async function getNews({ category = "", max = 0 } = {}) {
  const rows = await list("news");
  const filtered = category ? rows.filter(r => r.category === category) : rows;
  return max ? filtered.slice(0, max) : filtered;
}

export async function getNewsById(id) {
  if (isDemo) return sampleData.news.find(n => n.id === id) || null;
  const snap = await getDoc(doc(db, "news", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** 行事一覧（日付の新しい順） */
export const getEvents = (max = 0) => list("events", { max });

// ---------- 書き込み ----------
export async function addContact(data) {
  if (isDemo) { console.info("[デモ] お問い合わせ送信:", data); return; }
  await addDoc(collection(db, "contacts"), { ...data, createdAt: serverTimestamp() });
}

// ---------- 管理画面用 ----------
export const adminApi = {
  list,
  async save(name, id, data) {
    if (isDemo) throw new Error("デモモードでは保存できません。firebase-config.js を設定してください。");
    if (id) { await updateDoc(doc(db, name, id), data); return id; }
    return (await addDoc(collection(db, name), data)).id;
  },
  async remove(name, id) {
    if (isDemo) throw new Error("デモモードでは削除できません。");
    await deleteDoc(doc(db, name, id));
  },
  /**
   * 会員番号の連番を 1 つ発行する（トランザクションで重複なし）
   * minSeq：既存の会員番号の最大値（カウンターが古い・未作成の場合の下限）
   */
  async issueMemberSeq(minSeq = 0) {
    const ref = doc(db, "counters", "memberNo");
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const seq = Math.max(snap.exists() ? Number(snap.data().seq) || 0 : 0, minSeq) + 1;
      tx.set(ref, { seq, updatedAt: serverTimestamp() });
      return seq;
    });
  },

  /** 管理者情報（role: "owner" | "admin"）。管理者でなければ null */
  async getAdmin(uid) {
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },
  /** 並び順を指定せずに全件取得（管理者・招待の一覧用） */
  async listAll(name) {
    const snap = await getDocs(collection(db, name));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  // ---- 管理者の招待（オーナーのみ） ----
  async invite(email, name, ownerUid) {
    const key = email.trim().toLowerCase();
    await setDoc(doc(db, "admin_invites", key), { email: key, name, invitedBy: ownerUid, createdAt: serverTimestamp() });
  },
  /** ログイン中の本人あての招待（なければ null） */
  async getMyInvite(user) {
    try {
      const snap = await getDoc(doc(db, "admin_invites", (user.email || "").toLowerCase()));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    } catch { return null; }
  },
  /** 招待を受けて管理者になる（メール確認済みが条件） */
  async acceptInvite(user, invite) {
    await setDoc(doc(db, "admins", user.uid), {
      role: "admin", email: invite.email, name: invite.name || "", invitedBy: invite.invitedBy, createdAt: serverTimestamp()
    });
    await deleteDoc(doc(db, "admin_invites", invite.id));
  },
  /** 招待された人のアカウント作成（確認メールは、確認待ちの画面を出すときに admin.js が送る） */
  async register(email, password) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    return cred.user;
  },
  sendVerification: (user) => sendEmailVerification(user),
  /** メール確認の状態を最新にする */
  async refresh(user) {
    await user.reload();
    await auth.currentUser.getIdToken(true);
    return auth.currentUser;
  },
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  loginWithGoogle: () => signInWithGoogle(),
  currentUser: () => auth.currentUser,
  logout: () => signOut(auth),
  resetPassword: (email) => sendPasswordResetEmail(auth, email),
  onAuth: (cb) => isDemo ? cb(null) : onAuthStateChanged(auth, cb)
};

// ---------- 表示用ユーティリティ ----------
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** "2026-10-01" → "2026.10.01" */
export function fmtDate(d) {
  if (!d) return "";
  if (d.toDate) d = d.toDate().toISOString().slice(0, 10);
  return String(d).replace(/-/g, ".");
}

// ============================================================
//  ★ お知らせの区分（ホームのタブ・お知らせ一覧の絞り込み・管理画面の選択肢に共通）
//    追加・名前変更・並べ替えはここだけで OK。key は Firestore に保存される値なので、
//    使用中の key は変更しないでください。color はラベルの色です。
// ============================================================
export const NEWS_CATEGORIES = [
  { key: "topics",  label: "トピックス",     color: "#0b3a6e" },
  { key: "kaikoku", label: "会告",           color: "#2e7d6b" },
  { key: "event",   label: "行事・イベント", color: "#b8862b" },
  { key: "archive", label: "アーカイブ更新", color: "#3a6ea5" },
  { key: "recruit", label: "募集",           color: "#a0522d" },
  { key: "report",  label: "活動報告",       color: "#5b6b7d" }
];
export const CATEGORY_LABEL = Object.fromEntries(NEWS_CATEGORIES.map(c => [c.key, c.label]));
const CATEGORY_COLOR = Object.fromEntries(NEWS_CATEGORIES.map(c => [c.key, c.color]));

/** 区分ラベル（色付き）の HTML */
export function categoryBadge(key) {
  const color = CATEGORY_COLOR[key];
  return `<span class="cat"${color ? ` style="background:${color}"` : ""}>${esc(CATEGORY_LABEL[key] || key || "その他")}</span>`;
}

/** お知らせ1件分の <li> を作る（トップ・一覧ページ共通） */
export function newsItemHtml(n) {
  const href = n.url ? esc(n.url) : `news.html?id=${encodeURIComponent(n.id)}`;
  return `<li class="news-item">
    <time>${esc(fmtDate(n.date))}</time>
    ${categoryBadge(n.category)}
    ${n.important ? '<span class="cat cat-important">重要</span>' : ""}
    <a href="${href}">${esc(n.title)}</a>
  </li>`;
}
