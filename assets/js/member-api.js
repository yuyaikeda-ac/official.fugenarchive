// ============================================================
//  会員機能のデータ処理（入会申込・ログイン・会員ポータル）
// ============================================================
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, writeBatch, collection, getDocs, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail, verifyBeforeUpdateEmail, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { db, auth, isDemo, signInWithGoogle } from "./db.js";

// ★ 会員種別（入会金・年会費は無料）。変える場合はここと join.html の「会員種別」、
//    firestore.rules の type の一覧も合わせて編集してください。
//    closed: true の種別は新規の申込・種別変更では選べません（以前に登録した会員の表示用）
export const MEMBER_TYPES = {
  regular: { label: "正会員" },
  student: { label: "学生会員" },
  associate: { label: "準会員", closed: true }
};

// ★ 入会の理由（正会員の申込で 1 つ選ぶ）。保存されるのは表示名そのもの
export const JOIN_REASONS = [
  "普賢岳ネットワーク（普賢ネット）からの参加",
  "本会の目的（記録・資料の収集と継承）に賛同して",
  "普賢にゆかりがある・地元に住んでいる",
  "資料・写真・証言を提供したい",
  "研究・教育・報道のため",
  "会員・関係者からの紹介",
  "その他"
];

// ★ 現在の職業の選択肢。変える場合はここを編集してください（保存されるのは表示名そのもの）
export const OCCUPATIONS = [
  { group: "お勤めの方", items: ["会社員（正社員）", "会社員（契約・派遣）", "会社経営・役員", "公務員", "団体職員・NPO職員", "パート・アルバイト"] },
  { group: "専門・技術", items: ["教員・保育士・教育関係", "研究者・大学教員", "医療・看護・介護・福祉", "IT・エンジニア・技術職", "士業（弁護士・税理士など）", "建築・設計・土木", "報道・出版・メディア", "芸術・デザイン・クリエイター", "学芸員・図書館・文化財関係", "宗教関係"] },
  { group: "自営・一次産業", items: ["自営業・個人事業主", "商業・サービス業", "製造・建設・運輸", "農業・林業・漁業", "観光・宿泊・飲食"] },
  { group: "学生", items: ["大学生・大学院生", "短大・専門学校生", "高校生", "中学生以下"] },
  { group: "その他", items: ["主婦・主夫", "退職・年金生活", "求職中", "その他"] }
];

export const STATUS_LABEL = { pending: "審査中", active: "有効", suspended: "停止中", rejected: "否認" };

// 本人が後から編集できる項目（firestore.rules と揃えています）
export const EDITABLE_FIELDS = ["name", "kana", "occupation", "affiliation", "phone", "newsletter"];

function requireFirebase() {
  if (isDemo) throw new Error("Firebase が未設定です。assets/js/firebase-config.js を設定してください。");
}

// ---------- 認証 ----------
export const onAuth = (cb) => isDemo ? cb(null) : onAuthStateChanged(auth, cb);
export const login = (email, pw) => (requireFirebase(), signInWithEmailAndPassword(auth, email, pw));
export const loginWithGoogle = () => (requireFirebase(), signInWithGoogle());
export const logout = () => signOut(auth);
export const resetPassword = (email) => (requireFirebase(), sendPasswordResetEmail(auth, email));

/** 入会申込：アカウント作成 → members/{uid} に「審査中」で登録 */
export async function apply(form) {
  requireFirebase();
  const cred = await createUserWithEmailAndPassword(auth, form.email, form.password);
  await saveApplication(cred.user.uid, form, form.email);
  await saveStudentId(cred.user.uid, form.studentId);
  return cred.user;
}

/** Google アカウントで入会申込（メールアドレスは Google アカウントのものを登録） */
export async function applyWithGoogle(form) {
  requireFirebase();
  const cred = await signInWithGoogle();
  if (await getMember(cred.user.uid)) {
    const err = new Error("already"); err.code = "member/exists"; throw err;
  }
  await saveApplication(cred.user.uid, form, cred.user.email);
  await saveStudentId(cred.user.uid, form.studentId);
  return cred.user;
}

async function saveApplication(uid, form, email) {
  await setDoc(doc(db, "members", uid), {
    name: form.name, kana: form.kana, email, type: form.type,
    occupation: form.occupation || "", affiliation: form.affiliation || "",
    ...(form.studentNo ? { studentNo: form.studentNo } : {}),
    // 正会員のみ：本人確認のための項目
    ...(form.type === "regular" ? {
      birthDate: form.birthDate, phone: form.phone,
      joinReason: form.joinReason, ...(form.referrer ? { referrer: form.referrer } : {}), pledge: true
    } : {}),
    message: form.message || "", newsletter: !!form.newsletter,
    ...(form.cardSignature ? { cardSignature: form.cardSignature } : {}),
    status: "pending", createdAt: serverTimestamp()
  });
}

// ---------- 学生証（学生会員の申込時のみ・表面の画像） ----------
// 画像は Firestore の student_ids/{uid} に保存します（本人と管理者のみ閲覧可。firestore.rules 参照）
async function saveStudentId(uid, image) {
  if (!image) return;
  await setDoc(doc(db, "student_ids", uid), { image, createdAt: serverTimestamp() });
}

/**
 * 画像ファイルを縮小して JPEG の data URL にする（Firestore の 1 件あたりの上限 1MB に収める）
 * 読み込めない形式（HEIC など）のときはエラーを投げます
 */
export async function compressImage(file, { maxSide = 1600, maxBytes = 700_000 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = maxSide, quality = 0.85, out = "";
    for (let i = 0; i < 8; i++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      out = canvas.toDataURL("image/jpeg", quality);
      if (out.length <= maxBytes) return out;
      if (quality > 0.6) quality -= 0.1; else side = Math.round(side * 0.8);
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 学生証の画像（管理者・本人のみ）。無ければ null */
export async function getStudentId(uid) {
  const snap = await getDoc(doc(db, "student_ids", uid));
  return snap.exists() ? snap.data().image : null;
}

// ---------- 会員情報 ----------
export async function getMember(uid) {
  const snap = await getDoc(doc(db, "members", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * 会員証の裏面に印字する直筆の署名（PNG の data URL）を保存
 * 書き直し（管理者の許可あり）の場合は、許可を使い切る（signatureRewrite を消す）
 */
export async function saveCardSignature(uid, image, { rewrite = false } = {}) {
  await updateDoc(doc(db, "members", uid), rewrite
    ? { cardSignature: image, signatureRewrite: deleteField(), signatureRewriteAt: serverTimestamp() }
    : { cardSignature: image });
}
/** 署名の書き直しを管理者に申請 */
export async function requestSignatureRewrite(uid) {
  await updateDoc(doc(db, "members", uid), { signatureRewrite: "requested", signatureRewriteAt: serverTimestamp() });
}

// ---------- 会員種別の変更（申請 → 管理者が許可） ----------
/**
 * 種別の変更を申請。学生会員へ変更する場合は学生証（表面）の画像も一緒に提出
 * @param studentIdImage compressImage() で縮小した data URL（学生会員以外は不要）
 */
export async function requestTypeChange(uid, newType, reason, studentIdImage = "", studentNo = "") {
  const batch = writeBatch(db);
  batch.update(doc(db, "members", uid), { typeRequest: newType, typeRequestReason: reason, typeRequestAt: serverTimestamp(), ...(studentNo ? { typeRequestStudentNo: studentNo } : {}) });
  if (newType === "student" && studentIdImage) batch.set(doc(db, "student_ids", uid), { image: studentIdImage, createdAt: serverTimestamp() });
  await batch.commit();
}
/** 申請を取り消す（提出した学生証の画像も削除） */
export async function cancelTypeChange(uid, hadStudentId) {
  await updateDoc(doc(db, "members", uid), { typeRequest: deleteField(), typeRequestReason: deleteField(), typeRequestAt: deleteField(), typeRequestStudentNo: deleteField() });
  if (hadStudentId) await deleteDoc(doc(db, "student_ids", uid)).catch(() => {});
}

// ---------- メールアドレスの変更 ----------
/** ログイン方法がパスワードかどうか（Google だけの場合は変更不可） */
export const canChangeEmail = (user) => user.providerData.some(p => p.providerId === "password");
/**
 * 新しいメールアドレスに確認メールを送る（リンクを開いた時点でログイン用のアドレスが切り替わる）
 * 安全のため、現在のパスワードで本人確認してから送信
 */
export async function requestEmailChange(user, newEmail, password) {
  requireFirebase();
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  await verifyBeforeUpdateEmail(user, newEmail, { url: `${location.origin}/member-login.html` });
}
/** ログイン用のアドレスが変わっていたら、会員データのメールアドレスも合わせる */
export async function syncMemberEmail(user, member) {
  if (!user.email || !user.emailVerified || user.email === member.email) return false;
  await updateDoc(doc(db, "members", user.uid), { email: user.email });
  member.email = user.email;
  return true;
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
/**
 * 行事の参加登録・取り消し（サーバーで定員・締切を確認し、確認メールを送る）
 * @returns { joined, count, remaining }
 */
export async function rsvp(eventId, _member, join) {
  const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js");
  const { app } = await import("./db.js");
  return (await httpsCallable(getFunctions(app, "asia-northeast1"), "eventRsvp")({ eventId, join })).data;
}

/** 行事の受付状況（会員サイト・公開ページで共通） */
export function eventRsvpState(ev, today) {
  const count = Number(ev.rsvpCount) || 0, cap = Number(ev.capacity) || 0;
  const remaining = cap ? Math.max(0, cap - count) : null;
  if (ev.rsvpOpen === false) return { open: false, label: "", remaining, count, cap };
  if (ev.date < today) return { open: false, label: "終了", remaining, count, cap };
  if (ev.rsvpDeadline && ev.rsvpDeadline < today) return { open: false, label: "締切済み", remaining, count, cap };
  if (cap && remaining <= 0) return { open: false, label: "満員", remaining, count, cap };
  return { open: true, label: "受付中", remaining, count, cap };
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
    "permission-denied": "アクセス権限がありません。",
    "functions/resource-exhausted": "定員に達したため、参加登録できません。",
    "member/exists": "この Google アカウントは既にお申込み済みです。会員ログインから状況をご確認ください。",
    "auth/operation-not-allowed": "このログイン方法は現在ご利用いただけません。委員会までお問い合わせください。",
    "auth/popup-blocked": "ポップアップがブロックされました。ブラウザの設定でポップアップを許可してください。",
    "auth/requires-recent-login": "安全のため、もう一度ログインしてからお試しください。",
    "auth/missing-password": "現在のパスワードを入力してください。",
    "auth/account-exists-with-different-credential": "このメールアドレスは別の方法で登録されています。メールアドレスとパスワードでログインしてください。"
  };
  return map[e?.code] || e?.message || "エラーが発生しました。";
}
