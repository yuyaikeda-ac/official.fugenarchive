// ============================================================
//  会員へのお知らせメール（管理画面の「会員にメールで知らせる」）
//
//  ・notifyMembers（呼び出し用の関数・管理者のみ）：{ collection, id } の記事を、
//    有効な会員のうち「会員向けのお知らせをメールで受け取る」（newsletter）にしている人へ送る
//  ・対象：member_news（会員向けお知らせ）／events（行事）／member_docs（会員限定資料）
//  ・送ったら記事に notifiedAt・notifiedCount を記録（管理画面に「メール送信済み」と表示）
//  ★ メールの文面は mails.js の memberNotice
// ============================================================
const TARGETS = { member_news: "会員向けお知らせ", events: "行事", member_docs: "会員限定資料" };

module.exports = function notify({ onCall, HttpsError, getFirestore, FieldValue, logger, sendAll, mails, mailSecrets }) {
  const notifyMembers = onCall({ secrets: mailSecrets, maxInstances: 3, timeoutSeconds: 300 }, async (req) => {
    const db = getFirestore();
    const uid = req.auth?.uid;
    if (!uid || !(await db.doc(`admins/${uid}`).get()).exists) throw new HttpsError("permission-denied", "管理者のみ実行できます。");
    const { collection, id } = req.data || {};
    if (!TARGETS[collection]) throw new HttpsError("invalid-argument", "メールで知らせられない種類です。");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpsError("invalid-argument", "記事を指定してください。");
    const snap = await db.doc(`${collection}/${id}`).get();
    if (!snap.exists) throw new HttpsError("not-found", "記事が見つかりません。");
    const item = { id, ...snap.data() };

    // 送り先：有効な会員で、お知らせメールを受け取る人
    const ms = await db.collection("members").where("status", "==", "active").get();
    const to = [];
    const seen = new Set();
    ms.forEach(d => {
      const m = d.data();
      const email = String(m.email || "").trim().toLowerCase();
      if (m.newsletter === false || !email || seen.has(email)) return;
      seen.add(email);
      to.push({ email, name: m.name || "" });
    });
    if (!to.length) return { sent: 0, message: "お知らせメールを受け取る有効な会員がいません。" };

    await sendAll(to.flatMap(r => mails.memberNotice({ to: r.email, name: r.name, kind: collection, item })), `会員へのお知らせ：${TARGETS[collection]}`);
    await snap.ref.update({ notifiedAt: FieldValue.serverTimestamp(), notifiedCount: to.length, notifiedBy: uid });
    logger.info("会員へのお知らせメール", { collection, id, count: to.length });
    return { sent: to.length };
  });
  return { notifyMembers };
};
