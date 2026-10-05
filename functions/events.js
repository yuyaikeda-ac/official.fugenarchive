// ============================================================
//  行事へのワンクリック参加登録
//
//  ・eventRsvp（呼び出し用の関数）：会員サイトのボタンから { eventId, join } で登録・取り消し
//      有効な会員か／受付中か（rsvpOpen）／締切（rsvpDeadline）／定員（capacity）をサーバーで確認し、
//      トランザクションで rsvps/{行事ID_UID} と events/{id}.rsvpCount を同時に更新（定員を超えない）
//  ・登録・取り消しのたびに、会員へ確認メール
//  ・ブラウザから rsvps へ直接書き込むことはできない（firestore.rules）
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

  return { eventRsvp };
};
