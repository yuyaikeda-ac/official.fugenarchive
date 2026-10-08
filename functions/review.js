// ============================================================
//  理事会による入会審査
//
//  ・管理画面の「理事会」で、審査を担当する理事会（board_groups）を選んでおく（settings/review）
//  ・入会申込があると、その理事会の全員に「承認依頼メール」を送信（理事ごとに専用のリンク）
//      リンク：review.html?r=会員UID&v=理事キー&t=秘密の番号
//      秘密の番号はハッシュ（SHA-256）だけを保存し、本体は保存しない
//  ・理事は review.html で 承認／非承認 を選び、理由（必須）を入力
//      理由は reviews/{会員UID} に保存され、申込者には表示されない（閲覧は管理者・理事会のみ）
//  ・全員が承認 → 自動で入会承認（会員番号を付与）→ 申込者へ承認メール（mailOnMemberReviewed）
//    1 人でも非承認 → その時点で自動で否認 → 申込者へ否認メール
//    どちらの場合も、理事会の全員へ結果（各理事の判断と理由）をメールで共有
//  ・管理者が管理画面で承認・否認した場合は、審査を「終了（closed）」にする
// ============================================================
const crypto = require("node:crypto");

const sha256Hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const voterKeyOf = (email) => sha256Hex(email.trim().toLowerCase()).slice(0, 16);
const newToken = () => crypto.randomBytes(32).toString("base64url");
const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

module.exports = function review({ onDocumentCreated, onDocumentUpdated, onCall, HttpsError, getFirestore, FieldValue, logger, sendAll, mailOpts, mails, issueMemberNo }) {
  const siteUrl = mails.CONFIG.siteUrl;
  const linkOf = (memberId, key, token) => `${siteUrl}/review.html?r=${encodeURIComponent(memberId)}&v=${key}&t=${token}`;

  /** 審査を作成して理事全員に依頼メールを送る（既に審査中なら何もしない） */
  async function startReview(db, memberId, member) {
    const setting = await db.doc("settings/review").get();
    const groupId = setting.exists ? setting.get("groupId") : "";
    if (!groupId) return { started: false, reason: "審査を担当する理事会が設定されていません。管理画面の「理事会」で選んでください。" };
    const groupSnap = await db.doc(`board_groups/${groupId}`).get();
    const group = groupSnap.exists ? groupSnap.data() : null;
    const directors = [];
    const seen = new Set();
    for (const d of group?.members || []) {
      const email = String(d.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email)) continue;
      seen.add(email);
      directors.push({ name: String(d.name || "").trim(), email });
    }
    if (!directors.length) return { started: false, reason: "審査を担当する理事会に理事が登録されていません。" };

    const ref = db.doc(`reviews/${memberId}`);
    const tokens = {};
    const created = await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (cur.exists && cur.get("status") === "open") return false;
      const voters = {};
      for (const d of directors) {
        const key = voterKeyOf(d.email);
        tokens[key] = newToken();
        voters[key] = { name: d.name, email: d.email, tokenHash: sha256Hex(tokens[key]), decision: null, reason: "", decidedAt: null, sentAt: FieldValue.serverTimestamp() };
      }
      tx.set(ref, {
        memberId, memberName: member.name || "", memberEmail: member.email || "", memberType: member.type || "",
        groupId, groupName: group.name || "", status: "open",
        total: directors.length, approveCount: 0, rejectCount: 0, voters,
        createdAt: FieldValue.serverTimestamp(), decidedAt: null
      });
      return true;
    });
    if (!created) return { started: false, reason: "すでに理事会の審査中です。" };

    await sendAll(directors.map(d => {
      const key = voterKeyOf(d.email);
      return mails.reviewRequest({ director: d, member, groupName: group.name || "", total: directors.length, link: linkOf(memberId, key, tokens[key]) });
    }).flat(), "理事会への承認依頼");
    logger.info("理事会審査を開始", { memberId, directors: directors.length });
    return { started: true, sent: directors.length };
  }

  // ---------- 入会申込 → 理事会の審査を開始 ----------
  const startBoardReview = onDocumentCreated({ document: "members/{uid}", ...mailOpts }, async (event) => {
    const m = event.data?.data();
    if (!m || m.status !== "pending") return;
    const res = await startReview(getFirestore(), event.params.uid, m);
    if (!res.started) logger.info("理事会審査は開始しませんでした", { reason: res.reason });
  });

  // ---------- 管理者が手動で承認・否認した → 審査を終了 ----------
  const closeReviewOnManualDecision = onDocumentUpdated({ document: "members/{uid}", retry: false }, async (event) => {
    const before = event.data?.before.data(), after = event.data?.after.data();
    if (!before || !after || before.status !== "pending" || after.status === "pending") return;
    const ref = getFirestore().doc(`reviews/${event.params.uid}`);
    await getFirestore().runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists || r.get("status") !== "open") return;
      tx.update(ref, { status: "closed", closedReason: `管理者が「${after.status === "active" ? "承認" : "否認"}」で確定`, decidedAt: FieldValue.serverTimestamp() });
    });
  });

  /** リンクの番号を確認して、審査と自分（理事）の情報を返す */
  async function authVoter(db, data) {
    const { r, v, t } = data || {};
    if (typeof r !== "string" || typeof v !== "string" || typeof t !== "string" || r.length > 128 || v.length > 32 || t.length > 100) {
      throw new HttpsError("invalid-argument", "リンクが正しくありません。メールのリンクをそのまま開いてください。");
    }
    const ref = db.doc(`reviews/${r}`);
    const snap = await ref.get();
    const voter = snap.exists ? snap.get("voters")?.[v] : null;
    if (!voter || !safeEqual(sha256Hex(t), voter.tokenHash)) {
      throw new HttpsError("permission-denied", "このリンクは無効です。新しい依頼メールが届いている場合は、そちらのリンクを開いてください。");
    }
    return { ref, review: snap.data(), voter };
  }

  const ts = (v) => v?.toDate?.().toISOString() || null;

  // ---------- 理事：審査ページの表示内容 ----------
  const getReview = onCall({ maxInstances: 3 }, async (req) => {
    const db = getFirestore();
    const { review: rv, voter } = await authVoter(db, req.data);
    const [mSnap, sidSnap] = await Promise.all([db.doc(`members/${rv.memberId}`).get(), db.doc(`student_ids/${rv.memberId}`).get()]);
    const m = mSnap.exists ? mSnap.data() : null;
    return {
      review: {
        status: rv.status, groupName: rv.groupName, total: rv.total, approveCount: rv.approveCount, rejectCount: rv.rejectCount,
        closedReason: rv.closedReason || "", createdAt: ts(rv.createdAt), decidedAt: ts(rv.decidedAt),
        // 他の理事は「回答済みかどうか」だけ（判断・理由は見せない）
        voters: Object.entries(rv.voters).map(([k, x]) => ({ name: x.name || x.email.replace(/@.*/, ""), voted: !!x.decision, isMe: k === req.data.v }))
      },
      me: { name: voter.name, email: voter.email, decision: voter.decision, reason: voter.reason, decidedAt: ts(voter.decidedAt) },
      member: m && {
        name: m.name, kana: m.kana, email: m.email, type: m.type, occupation: m.occupation || "", affiliation: m.affiliation || "", studentNo: m.studentNo || "",
        message: m.message || "", status: m.status, createdAt: ts(m.createdAt)
      },
      studentIdImage: sidSnap.exists ? sidSnap.get("image") : null
    };
  });

  // ---------- 理事：承認／非承認 ----------
  const submitReview = onCall({ maxInstances: 3, secrets: mailOpts.secrets }, async (req) => {
    const db = getFirestore();
    const { decision } = req.data || {};
    const reason = String(req.data?.reason || "").trim();
    if (!["approve", "reject"].includes(decision)) throw new HttpsError("invalid-argument", "承認か非承認を選んでください。");
    if (!reason) throw new HttpsError("invalid-argument", `${decision === "approve" ? "承認" : "非承認"}の理由を入力してください。`);
    if (reason.length > 2000) throw new HttpsError("invalid-argument", "理由は 2000 文字以内で入力してください。");
    const { ref } = await authVoter(db, req.data);
    const key = req.data.v;
    const memberRef = db.doc(`members/${(await ref.get()).get("memberId")}`);

    // 会員番号は先に確保しておく（全員承認になった場合のみ使用。使わなければ番号が 1 つ飛ぶだけ）
    const result = await db.runTransaction(async (tx) => {
      const [snap, mSnap] = await Promise.all([tx.get(ref), tx.get(memberRef)]);
      const rv = snap.data();
      const me = rv.voters[key];
      if (rv.status !== "open") throw new HttpsError("failed-precondition", "この審査はすでに終了しています。");
      if (me.decision) throw new HttpsError("already-exists", "すでに回答済みです。");
      if (!mSnap.exists || mSnap.get("status") !== "pending") throw new HttpsError("failed-precondition", "この申込はすでに審査が終わっているか、取り消されています。");

      const approveCount = rv.approveCount + (decision === "approve" ? 1 : 0);
      const rejectCount = rv.rejectCount + (decision === "reject" ? 1 : 0);
      const outcome = rejectCount > 0 ? "rejected" : approveCount >= rv.total ? "approved" : "open";
      const now = FieldValue.serverTimestamp();
      tx.update(ref, {
        [`voters.${key}.decision`]: decision, [`voters.${key}.reason`]: reason, [`voters.${key}.decidedAt`]: now,
        approveCount, rejectCount, status: outcome, ...(outcome !== "open" ? { decidedAt: now } : {})
      });
      return { outcome, member: mSnap.data() };
    });

    if (result.outcome === "open") return { ok: true, outcome: "open" };

    // 確定：会員の状態を更新（→ mailOnMemberReviewed が申込者へ承認／否認メールを送る）
    if (result.outcome === "approved") {
      const memberNo = result.member.memberNo || await issueMemberNo(db);
      await memberRef.update({ status: "active", memberNo, approvedAt: FieldValue.serverTimestamp(), approvedBy: "board" });
    } else {
      await memberRef.update({ status: "rejected", rejectedAt: FieldValue.serverTimestamp(), rejectedBy: "board" });
    }
    // 学生証の画像は審査にのみ使うので削除
    await db.doc(`student_ids/${memberRef.id}`).delete().catch(() => {});
    // 理事会へ結果を共有（各理事の判断と理由）
    const fin = (await ref.get()).data();
    await sendAll(mails.reviewResult({ review: fin, member: result.member }), "理事会審査の結果");
    logger.info("理事会審査が確定", { memberId: memberRef.id, outcome: result.outcome });
    return { ok: true, outcome: result.outcome };
  });

  // ---------- 管理者：審査の開始・未回答者への再送 ----------
  const adminReview = onCall({ maxInstances: 3, secrets: mailOpts.secrets }, async (req) => {
    const db = getFirestore();
    const uid = req.auth?.uid;
    if (!uid || !(await db.doc(`admins/${uid}`).get()).exists) throw new HttpsError("permission-denied", "管理者のみ実行できます。");
    const { action, memberId } = req.data || {};
    if (typeof memberId !== "string" || !memberId) throw new HttpsError("invalid-argument", "会員を指定してください。");
    const mSnap = await db.doc(`members/${memberId}`).get();
    if (!mSnap.exists) throw new HttpsError("not-found", "会員が見つかりません。");
    const m = mSnap.data();

    if (action === "start") {
      if (m.status !== "pending") throw new HttpsError("failed-precondition", "審査中（未承認）の申込のみ開始できます。");
      const res = await startReview(db, memberId, m);
      if (!res.started) throw new HttpsError("failed-precondition", res.reason);
      return { ok: true, sent: res.sent };
    }
    if (action === "resend") {
      const ref = db.doc(`reviews/${memberId}`);
      const tokens = {};
      const targets = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.get("status") !== "open") throw new HttpsError("failed-precondition", "審査中ではありません。");
        const voters = snap.get("voters");
        const list = Object.entries(voters).filter(([, x]) => !x.decision);
        const upd = {};
        for (const [k] of list) {
          tokens[k] = newToken(); // 新しいリンクを発行（以前のリンクは無効になる）
          upd[`voters.${k}.tokenHash`] = sha256Hex(tokens[k]);
          upd[`voters.${k}.sentAt`] = FieldValue.serverTimestamp();
        }
        if (list.length) tx.update(ref, upd);
        return list.map(([k, x]) => ({ key: k, name: x.name, email: x.email, groupName: snap.get("groupName"), total: snap.get("total") }));
      });
      await sendAll(targets.map(d => mails.reviewRequest({ director: d, member: m, groupName: d.groupName, total: d.total, link: linkOf(memberId, d.key, tokens[d.key]), reminder: true })).flat(), "理事会への承認依頼（再送）");
      return { ok: true, sent: targets.length };
    }
    throw new HttpsError("invalid-argument", "不明な操作です。");
  });

  return { startBoardReview, closeReviewOnManualDecision, getReview, submitReview, adminReview };
};
