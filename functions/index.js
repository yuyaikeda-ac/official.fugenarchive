// ============================================================
//  Cloud Functions：申請・お問い合わせ時のメール送信
//  Firestore にデータが保存されると自動で動きます。
//
//  ・送信元：Gmail（SENDER のアカウント）
//  ・Gmail のアプリパスワードは Secret Manager に「GMAIL_APP_PASSWORD」として保存
//    （登録：firebase functions:secrets:set GMAIL_APP_PASSWORD）
//  ・メールの文面は mails.js で編集できます
// ============================================================
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const nodemailer = require("nodemailer");
const mails = require("./mails");

// ★ 送信に使う Gmail アカウント
const SENDER = "yuya.ikr@gmail.com";
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

// Firestore と同じ東京リージョンで動かす
setGlobalOptions({ region: "asia-northeast1", maxInstances: 3 });

const opts = { secrets: [GMAIL_APP_PASSWORD], retry: false };

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: SENDER, pass: GMAIL_APP_PASSWORD.value().replace(/\s/g, "") }
    });
  }
  return transporter;
}

/** メールを順に送信（1通失敗しても他は送る） */
async function sendAll(list, context) {
  for (const m of list) {
    if (!m.to) continue;
    try {
      await getTransporter().sendMail({
        from: `"${mails.CONFIG.orgName}" <${SENDER}>`,
        to: m.to,
        replyTo: m.replyTo,
        subject: m.subject,
        text: m.text
      });
      logger.info(`メール送信：${context}`, { to: m.to, subject: m.subject });
    } catch (e) {
      logger.error(`メール送信失敗：${context}`, { to: m.to, error: e.message });
    }
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
