// ============================================================
//  Cloud Functions：申請・お問い合わせ時のメール送信、電子同意書の封印・検証
//  Firestore にデータが保存されると自動で動きます。
//
//  ・送信は Google Apps Script（apps-script/Code.gs）経由。
//    Apps Script を設置した Gmail アカウントから送信されます。
//  ・Secret Manager に次の 2 つを登録しておきます
//      MAIL_WEBAPP_URL … Apps Script のウェブアプリの URL
//      MAIL_TOKEN      … Apps Script の setup で表示された TOKEN
//      CONSENT_SEAL_KEY … 電子同意書の封印用の秘密鍵（ランダムな長い文字列。変更すると過去の封印を検証できなくなる）
//  ・メールの文面は mails.js で編集できます
// ============================================================
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("node:crypto");
const mails = require("./mails");

initializeApp();

const MAIL_WEBAPP_URL = defineSecret("MAIL_WEBAPP_URL");
const MAIL_TOKEN = defineSecret("MAIL_TOKEN");

// Firestore と同じ東京リージョンで動かす
setGlobalOptions({ region: "asia-northeast1", maxInstances: 3 });

const opts = { secrets: [MAIL_WEBAPP_URL, MAIL_TOKEN], retry: false };

/** Apps Script にまとめて送信を依頼する */
async function sendAll(list, context) {
  const targets = list.filter(m => m.to);
  if (!targets.length) return;
  try {
    const res = await fetch(MAIL_WEBAPP_URL.value().trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: MAIL_TOKEN.value().trim(), mails: targets }),
      redirect: "follow"
    });
    const text = await res.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error(`Apps Script の応答が不正です（HTTP ${res.status}）: ${text.slice(0, 200)}`); }
    if (!result.ok) throw new Error(`Apps Script エラー: ${result.error}`);
    for (const r of result.results) {
      if (r.ok) logger.info(`メール送信：${context}`, { to: r.to });
      else logger.error(`メール送信失敗：${context}`, { to: r.to, error: r.error });
    }
    if (typeof result.remaining === "number" && result.remaining < 20) {
      logger.warn(`本日の残り送信可能数が少なくなっています：${result.remaining} 通`);
    }
  } catch (e) {
    logger.error(`メール送信失敗：${context}`, { to: targets.map(m => m.to), error: e.message });
  }
}

const withDates = (data) => ({ ...data, createdAt: data.createdAt?.toDate?.() || new Date() });

// ---------- 電子同意書：署名の封印・控えのメール・検証（中身は consent.js） ----------
Object.assign(exports, require("./consent")({
  onDocumentCreated, onCall, HttpsError, defineSecret, getFirestore, FieldValue, logger, sendAll, mailOpts: opts, mails
}));

// ---------- 入会申込 → 委員会へ通知 ＋ 申込者へ受付確認 ----------
exports.mailOnMemberApplied = onDocumentCreated({ document: "members/{uid}", ...opts }, async (event) => {
  const m = event.data?.data();
  if (!m || m.status !== "pending") return;
  await sendAll(mails.memberApplied(withDates(m)), "入会申込");
});

// ---------- 審査結果 → 申込者へ承認／否認の通知 ----------
exports.mailOnMemberReviewed = onDocumentUpdated({ document: "members/{uid}", ...opts }, async (event) => {
  const before = event.data?.before.data(), after = event.data?.after.data();
  if (!before || !after) return;
  // 否認
  if (before.status === "pending" && after.status === "rejected") {
    await sendAll(mails.memberRejected(after), "入会否認");
    return;
  }
  // 承認：会員番号が付いた時点で送る
  //  ・管理画面で番号付きで承認した場合 … 審査中 → 有効 の更新で送信
  //  ・番号なしで承認され、サーバーが番号を付けた場合 … 番号が付いた更新で送信
  const approvedNow = before.status === "pending" && after.status === "active" && after.memberNo;
  const numberedAfterApproval = before.status === "active" && after.status === "active" && !before.memberNo && after.memberNo;
  if (approvedNow || numberedAfterApproval) {
    await sendAll(mails.memberApproved(after), "入会承認");
  }
});

// ---------- お問い合わせ → 委員会へ通知 ＋ 送信者へ自動返信 ----------
exports.mailOnContact = onDocumentCreated({ document: "contacts/{id}", ...opts }, async (event) => {
  const c = event.data?.data();
  if (!c) return;
  await sendAll(mails.contactReceived(withDates(c)), "お問い合わせ");
});

// ---------- 管理者の招待 → 招待された人へ案内 ----------
exports.mailOnAdminInvite = onDocumentCreated({ document: "admin_invites/{email}", ...opts }, async (event) => {
  const inv = event.data?.data();
  if (!inv) return;
  await sendAll(mails.adminInvited(inv), "管理者招待");
});

// ============================================================
//  会員証のQRコード用：確認ページ（verify.html）に表示する情報を作る
//  ・会員番号が付くと、推測できない番号（cardToken）を発行して会員データに保存
//  ・cards/{cardToken} に、会員証に書かれている範囲の情報だけを保存（メール・電話などは含めない）
//  ・状態（有効／停止など）や名前が変われば自動で更新、会員が削除されたら削除
// ============================================================
exports.syncMemberCard = onDocumentWritten({ document: "members/{uid}", retry: false }, async (event) => {
  const db = getFirestore();
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;

  // 会員が削除された
  if (!after) {
    if (before?.cardToken) await db.doc(`cards/${before.cardToken}`).delete();
    return;
  }
  // 有効な会員なのに会員番号がない → サーバーで自動採番（管理画面と同じカウンターを使うので重複しない）
  if (after.status === "active" && !after.memberNo) {
    const memberNo = await issueMemberNo(db);
    await event.data.after.ref.update({ memberNo });
    logger.info("会員番号を自動付与", { memberNo });
    return; // この更新で関数がもう一度呼ばれ、会員証の情報が作られる
  }
  // 会員番号がまだない（審査中など）
  if (!after.memberNo) return;

  // 初回：cardToken を発行（この更新で関数がもう一度呼ばれ、下の処理でカード情報が作られる）
  if (!after.cardToken) {
    const token = crypto.randomBytes(16).toString("hex");
    await event.data.after.ref.update({ cardToken: token });
    logger.info("会員証トークンを発行", { memberNo: after.memberNo });
    return;
  }

  const card = {
    memberNo: after.memberNo,
    name: after.name || "",
    type: after.type || "",
    status: after.status || "",
    approvedAt: after.approvedAt || null,
    validUntil: after.validUntil || "",
    updatedAt: FieldValue.serverTimestamp()
  };
  await db.doc(`cards/${after.cardToken}`).set(card);
});

// ============================================================
//  会員証のQRコード用の番号（cardToken）がまだ無い会員のために、会員サイトから呼び出して発行する
//  （この機能を入れる前に承認された会員は、会員データが更新されるまで番号が無いため）
//  発行すると syncMemberCard が動き、確認ページ用の情報（cards/）も作られる
// ============================================================
exports.ensureCardToken = onCall({ maxInstances: 3 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインしてください。");
  const db = getFirestore();
  const ref = db.doc(`members/${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const m = snap.exists ? snap.data() : null;
    if (!m || m.status !== "active" || !m.memberNo) throw new HttpsError("failed-precondition", "有効な会員のみ発行できます。");
    if (m.cardToken) return { cardToken: m.cardToken };
    const token = crypto.randomBytes(16).toString("hex");
    tx.update(ref, { cardToken: token });
    logger.info("会員証トークンを発行（会員サイトから）", { memberNo: m.memberNo });
    return { cardToken: token };
  });
});

// ============================================================
//  会員番号の採番（例：FA-2026-0001）
//  ★ 形式は admin.html の MEMBER_NO と揃えてください
// ============================================================
const MEMBER_NO = { prefix: "FA", digits: 4 };
async function issueMemberNo(db) {
  const ref = db.doc("counters/memberNo");
  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let current = snap.exists ? Number(snap.get("seq")) || 0 : 0;
    // カウンターがまだ無いときは、既存の会員番号の最大値から続ける
    if (!snap.exists) {
      const all = await tx.get(db.collection("members"));
      all.forEach(d => { const m = /-(\d+)$/.exec(d.get("memberNo") || ""); if (m) current = Math.max(current, +m[1]); });
    }
    const next = current + 1;
    tx.set(ref, { seq: next, updatedAt: FieldValue.serverTimestamp() });
    return next;
  });
  const year = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo", year: "numeric" });
  return `${MEMBER_NO.prefix}-${year}-${String(seq).padStart(MEMBER_NO.digits, "0")}`;
}
