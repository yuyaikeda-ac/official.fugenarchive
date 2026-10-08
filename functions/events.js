// ============================================================
//  行事へのワンクリック参加登録
//
//  ・eventRsvp（呼び出し用の関数）：会員サイトのボタンから { eventId, join } で登録・取り消し
//      有効な会員か／受付中か（rsvpOpen）／締切（rsvpDeadline）／定員（capacity）をサーバーで確認し、
//      トランザクションで rsvps/{行事ID_UID} と events/{id}.rsvpCount を同時に更新（定員を超えない）
//  ・登録・取り消しのたびに、会員へ確認メール
//  ・ブラウザから rsvps へ直接書き込むことはできない（firestore.rules）
//
//  ・eventCheckin（管理者のみ）：当日の受付（入室の記録）。管理画面の「受付」で使う
//      { eventId, token }      … デジタル会員証の QR コード（verify.html?t=…）の cardToken で受付
//      { eventId, memberNo }   … 会員番号を手入力して受付
//      { eventId, guestName, guestAffiliation } … 会員以外の参加者（一般・来賓など）を名前で記録
//      { eventId, undo: 受付ID } … 受付の取り消し
//    checkins/{行事ID_UID}（会員）または checkins/{自動ID}（会員以外）に保存。同じ会員の二重受付はしない
//    （複数のスマホで同時に受付してもトランザクションで 1 件だけ）
// ============================================================
const todayJst = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

/** 受付の状態（会員サイト・公開ページと同じ判定） */
function rsvpState(ev) {
  if (ev.rsvpOpen === false) return { ok: false, reason: "この行事は参加登録を受け付けていません。" };
  if (ev.date && ev.date < todayJst()) return { ok: false, reason: "この行事は終了しました。" };
  if (ev.rsvpDeadline && ev.rsvpDeadline < todayJst()) return { ok: false, reason: "参加登録の締切を過ぎました。" };
  return { ok: true };
}

module.exports = function events({ onCall, HttpsError, getFirestore, FieldValue, logger, sendAll, mails, mailSecrets }) {
  const eventRsvp = onCall({ secrets: mailSecrets, maxInstances: 5 }, async (req) => {
    const db = getFirestore();
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "ログインしてください。");
    const { eventId, join } = req.data || {};
    if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(eventId)) throw new HttpsError("invalid-argument", "行事を指定してください。");

    const memberRef = db.doc(`members/${uid}`);
    const eventRef = db.doc(`events/${eventId}`);
    const rsvpRef = db.doc(`rsvps/${eventId}_${uid}`);

    const result = await db.runTransaction(async (tx) => {
      const [m, e, r] = await Promise.all([tx.get(memberRef), tx.get(eventRef), tx.get(rsvpRef)]);
      if (!m.exists || m.get("status") !== "active") throw new HttpsError("permission-denied", "有効な会員のみ参加登録できます。");
      if (!e.exists) throw new HttpsError("not-found", "行事が見つかりません。");
      const ev = e.data();
      const count = Number(ev.rsvpCount) || 0;
      const cap = Number(ev.capacity) || 0;
      if (join) {
        if (r.exists) return { changed: false, ev, count };
        const st = rsvpState(ev);
        if (!st.ok) throw new HttpsError("failed-precondition", st.reason);
        if (cap && count >= cap) throw new HttpsError("resource-exhausted", "定員に達したため、参加登録できません。");
        tx.set(rsvpRef, { eventId, uid, name: m.get("name") || "", memberNo: m.get("memberNo") || "", email: m.get("email") || "", createdAt: FieldValue.serverTimestamp() });
        tx.update(eventRef, { rsvpCount: count + 1 });
        return { changed: true, ev, count: count + 1, member: m.data() };
      }
      if (!r.exists) return { changed: false, ev, count };
      if (ev.date && ev.date < todayJst()) throw new HttpsError("failed-precondition", "終了した行事の参加登録は取り消せません。");
      tx.delete(rsvpRef);
      tx.update(eventRef, { rsvpCount: Math.max(0, count - 1) });
      return { changed: true, ev, count: Math.max(0, count - 1), member: m.data() };
    });

    if (result.changed && result.member?.email) {
      await sendAll(mails.eventRsvpMail({ member: result.member, event: { id: eventId, ...result.ev }, join: !!join }), join ? "行事：参加登録" : "行事：参加取り消し");
    }
    logger.info("行事の参加登録", { eventId, join: !!join, changed: result.changed, count: result.count });
    const cap = Number(result.ev.capacity) || 0;
    return { joined: !!join, count: result.count, remaining: cap ? Math.max(0, cap - result.count) : null };
  });

  const TYPE_LABEL = { regular: "正会員", associate: "準会員", student: "学生会員" };
  const STATUS_LABEL = { pending: "審査中", suspended: "停止中", rejected: "否認" };

  const eventCheckin = onCall({ maxInstances: 10 }, async (req) => {
    const db = getFirestore();
    const adminUid = req.auth?.uid;
    if (!adminUid || !(await db.doc(`admins/${adminUid}`).get()).exists) throw new HttpsError("permission-denied", "管理者のみ実行できます。");
    const { eventId, token, memberNo, guestName, guestAffiliation, undo } = req.data || {};
    if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(eventId)) throw new HttpsError("invalid-argument", "行事を指定してください。");
    if (!(await db.doc(`events/${eventId}`).get()).exists) throw new HttpsError("not-found", "行事が見つかりません。");
    const by = { byUid: adminUid, byEmail: req.auth.token.email || "" };

    // 受付の取り消し
    if (undo !== undefined) {
      if (typeof undo !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(undo)) throw new HttpsError("invalid-argument", "取り消す受付を指定してください。");
      const ref = db.doc(`checkins/${undo}`);
      const snap = await ref.get();
      if (!snap.exists || snap.get("eventId") !== eventId) throw new HttpsError("not-found", "受付の記録が見つかりません。");
      await ref.delete();
      logger.info("行事の受付を取り消し", { eventId, id: undo, ...by });
      return { result: "undone" };
    }

    // 会員以外の参加者（一般・来賓など）
    if (guestName !== undefined) {
      const name = String(guestName || "").trim().slice(0, 100);
      if (!name) throw new HttpsError("invalid-argument", "お名前を入力してください。");
      const ref = await db.collection("checkins").add({ eventId, guest: true, name, affiliation: String(guestAffiliation || "").trim().slice(0, 100),
        memberNo: "", type: "会員以外", method: "guest", rsvp: false, at: FieldValue.serverTimestamp(), ...by });
      logger.info("行事の受付（会員以外）", { eventId, id: ref.id });
      return { result: "ok", guest: true, id: ref.id, name };
    }

    // 会員を探す（QR コードの cardToken、または会員番号）
    let q;
    if (typeof token === "string" && /^[0-9a-f]{32}$/.test(token)) q = db.collection("members").where("cardToken", "==", token);
    else if (typeof memberNo === "string" && memberNo.trim() && memberNo.length <= 40) q = db.collection("members").where("memberNo", "==", memberNo.trim().toUpperCase());
    else return { result: "unknown", reason: "会員証のQRコードではありません。" };
    const found = await q.limit(1).get();
    if (found.empty) return { result: "unknown", reason: token ? "登録されていない会員証です。" : "この会員番号の会員はいません。" };
    const mDoc = found.docs[0];
    const m = mDoc.data();
    const who = { name: m.name || "", memberNo: m.memberNo || "", type: TYPE_LABEL[m.type] || "" };
    if (m.status !== "active") return { result: "invalid", ...who, reason: `会員資格が有効ではありません（${STATUS_LABEL[m.status] || m.status || "不明"}）。` };
    if (m.validUntil && m.validUntil < todayJst()) return { result: "invalid", ...who, reason: `会員資格の有効期限（${m.validUntil}）が切れています。` };

    const uid = mDoc.id;
    const ref = db.doc(`checkins/${eventId}_${uid}`);
    const out = await db.runTransaction(async (tx) => {
      const [c, r] = await Promise.all([tx.get(ref), tx.get(db.doc(`rsvps/${eventId}_${uid}`))]);
      if (c.exists) return { result: "already", id: ref.id, ...who, rsvp: !!c.get("rsvp"), at: c.get("at")?.toDate?.().toISOString() || "" };
      tx.set(ref, { eventId, uid, ...who, rsvp: r.exists, method: token ? "qr" : "manual", at: FieldValue.serverTimestamp(), ...by });
      return { result: "ok", id: ref.id, ...who, rsvp: r.exists };
    });
    logger.info("行事の受付", { eventId, result: out.result, memberNo: who.memberNo });
    return out;
  });

  return { eventRsvp, eventCheckin };
};
