// ============================================================
//  データ取得・保存の共通処理（Firebase Firestore）
//  各ページの <script type="module"> から import して使います。
//
//  Firestore のコレクション構成
//    news     : お知らせ（title, date "YYYY-MM-DD", category "topics"|"kaikoku",
//                important(true/false), body, url）
//    events   : 行事（title, date, place, description, url）
//    contacts : お問い合わせ（name, email, subject, message, createdAt）※書き込みのみ
//    admins   : 管理者（ドキュメントID = 管理者ユーザーの UID）
//
//  会員機能（assets/js/member-api.js で使用）
//    members     : 会員（ドキュメントID = 会員の UID）
//    member_news : 会員向けお知らせ（title, date, body, important）
//    member_docs : 会員限定資料（title, category, date, description, url）
//    rsvps       : 行事への参加登録（ID = 行事ID_UID）
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy, limit as qLimit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { sampleData } from "./sample-data.js";

// Firebase が未設定ならサンプルデータで動かす
export const isDemo = !firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY";

export let db = null;
export let auth = null;
if (!isDemo) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
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
    if (id) await updateDoc(doc(db, name, id), data);
    else await addDoc(collection(db, name), data);
  },
  async remove(name, id) {
    if (isDemo) throw new Error("デモモードでは削除できません。");
    await deleteDoc(doc(db, name, id));
  },
  async isAdmin(uid) {
    const snap = await getDoc(doc(db, "admins", uid));
    return snap.exists();
  },
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
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

export const CATEGORY_LABEL = { topics: "トピックス", kaikoku: "会告" };

/** お知らせ1件分の <li> を作る（トップ・一覧ページ共通） */
export function newsItemHtml(n) {
  const href = n.url ? esc(n.url) : `news.html?id=${encodeURIComponent(n.id)}`;
  return `<li class="news-item">
    <time>${esc(fmtDate(n.date))}</time>
    <span class="cat cat-${esc(n.category)}">${esc(CATEGORY_LABEL[n.category] || n.category)}</span>
    ${n.important ? '<span class="cat cat-important">重要</span>' : ""}
    <a href="${href}">${esc(n.title)}</a>
  </li>`;
}
