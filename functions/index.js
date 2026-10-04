// ============================================================
//  Cloud Functions：申請・お問い合わせ時のメール送信
//  Firestore にデータが保存されると自動で動きます。
//
//  ・送信は Google Apps Script（apps-script/Code.gs）経由。
//    Apps Script を設置した Gmail アカウントから送信されます。
//  ・Secret Manager に次の 2 つを登録しておきます
//      MAIL_WEBAPP_URL … Apps Script のウェブアプリの URL
//      MAIL_TOKEN      … Apps Script の setup で表示された TOKEN
//  ・メールの文面は mails.js で編集できます
// ============================================================
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const mails = require("./mails");

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

// ---------- 入会申込 → 委員会へ通知 ＋ 申込者へ受付確認 ----------
exports.mailOnMemberApplied = onDocumentCreated({ document: "members/{uid}", ...opts }, async (event) => {
  const m = event.data?.data();
  if (!m || m.status !== "pending") return;
  await sendAll(mails.memberApplied(withDates(m)), "入会申込");
});

// ---------- 審査結果 → 申込者へ承認／否認の通知 ----------
exports.mailOnMemberReviewed = onDocumentUpdated({ document: "members/{uid}", ...opts }, async (event) => {
  const before = event.data?.before.data(), after = event.data?.after.data();
  if (!before || !after || before.status !== "pending") return;
  if (after.status === "active") await sendAll(mails.memberApproved(after), "入会承認");
  else if (after.status === "rejected") await sendAll(mails.memberRejected(after), "入会否認");
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
