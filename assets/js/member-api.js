// ============================================================
//  会員機能のデータ処理（入会申込・ログイン・会員ポータル）
// ============================================================
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { db, auth, isDemo } from "./db.js";

// ★ 会員種別（入会金・年会費は無料）。変える場合はここと join.html の「会員種別」、
//    firestore.rules の type の一覧も合わせて編集してください。
export const MEMBER_TYPES = {
  regular: { label: "正会員" },
  student: { label: "学生会員" }
};

export const STATUS_LABEL = { pending: "審査中", active: "有効", suspended: "停止中", rejected: "否認" };

// 本人が後から編集できる項目（firestore.rules と揃えています）
export const EDITABLE_FIELDS = ["name", "kana", "affiliation", "phone", "address", "newsletter"];

function requireFirebase() {
  if (isDemo) throw new Error("Firebase が未設定です。assets/js/firebase-config.js を設定してください。");
}

// ---------- 認証 ----------
export const onAuth = (cb) => isDemo ? cb(null) : onAuthStateChanged(auth, cb);
export const login = (email, pw) => (requireFirebase(), signInWithEmailAndPassword(auth, email, pw));
export const logout = () => signOut(auth);
export const resetPassword = (email) => (requireFirebase(), sendPasswordResetEmail(auth, email));

/** 入会申込：アカウント作成 → members/{uid} に「審査中」で登録 */
export async function apply(form) {
  requireFirebase();
  const cred = await createUserWithEmailAndPassword(auth, form.email, form.password);
  await setDoc(doc(db, "members", cred.user.uid), {
    name: form.name, kana: form.kana, email: form.email, type: form.type,
    affiliation: form.affiliation || "", phone: form.phone || "", address: form.address || "",
    message: form.message || "", newsletter: !!form.newsletter,
    status: "pending", createdAt: serverTimestamp()
  });
  return cred.user;
}

// ---------- 会員情報 ----------
export async function getMember(uid) {
  const snap = await getDoc(doc(db, "members", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function updateProfile(uid, data) {
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => EDITABLE_FIELDS.includes(k)));
  await updateDoc(doc(db, "members", uid), clean);
}

// ---------- 会員向けコンテンツ ----------
async function list(name, order = "date") {
  const snap = await getDocs(query(collection(db, name), orderBy(order, "desc")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export const getMemberNews = () => list("member_news");
export const getMemberDocs = () => list("member_docs");
export const getEvents = () => list("events");

// ---------- 行事の参加登録 ----------
export async function getMyRsvps(uid) {
  const snap = await getDocs(query(collection(db, "rsvps"), where("uid", "==", uid)));
  return new Set(snap.docs.map(d => d.data().eventId));
}
export async function rsvp(eventId, member, join) {
  const ref = doc(db, "rsvps", `${eventId}_${member.id}`);
  if (join) await setDoc(ref, { eventId, uid: member.id, name: member.name, createdAt: serverTimestamp() });
  else await deleteDoc(ref);
}

/** Firebase のエラーコードを日本語に */
export function errorMessage(e) {
  const map = {
    "auth/email-already-in-use": "このメールアドレスは既に登録されています。会員ログインからお入りください。",
    "auth/invalid-email": "メールアドレスの形式が正しくありません。",
    "auth/weak-password": "パスワードは8文字以上で設定してください。",
    "auth/invalid-credential": "メールアドレスまたはパスワードが正しくありません。",
    "auth/wrong-password": "メールアドレスまたはパスワードが正しくありません。",
    "auth/user-not-found": "メールアドレスまたはパスワードが正しくありません。",
    "auth/too-many-requests": "試行回数が多すぎます。しばらく時間をおいてからお試しください。",
    "auth/network-request-failed": "ネットワークに接続できません。通信環境をご確認ください。",
    "permission-denied": "アクセス権限がありません。"
  };
  return map[e?.code] || e?.message || "エラーが発生しました。";
}
