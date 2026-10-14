// ============================================================
//  管理者の操作ログ（admin_logs）と、管理者への正会員の自動付与
//  ・閲覧はオーナーのみ（管理画面の「操作ログ」）。書き込みは Cloud Functions のみで、管理者は消せない
//  ・記録するもの
//      login  … 管理画面へのログイン（日時・ログイン方法・2段階認証・IPアドレス・ブラウザ）
//      create / update / delete … 管理者が管理画面から Firestore を書き換えた（変更前と変更後の値）
//      call   … 管理者が Cloud Functions 経由で行った操作（返信・審査・投票の確定など。成功・失敗とも）
//      system … 管理者に関する自動処理（正会員の自動付与など）
//  ・管理者は会員と同じメールアドレスで二重に登録できないため、管理者には正会員の登録を自動で付与する
//    （管理者になったとき＋ログインのたびに確認。すでに有効な会員ならそのまま）
// ============================================================
module.exports = function audit({ onDocumentCreated, onDocumentWrittenWithAuthContext, onCall, HttpsError, getFirestore, FieldValue, logger }) {
  const LOGS = "admin_logs";

  // ★ 記録しないコレクション（ログ自身・関数だけが書くもの）
  const SKIP_COLLECTIONS = new Set([LOGS, "cards", "mfa", "consent_chain", "ai_actions"]);

  // ★ 管理者が Cloud Functions 経由で行う操作（関数名 → 表示名）。ここにある関数だけ記録する
  const ADMIN_CALLS = {
    replyContact: "お問い合わせへ返信",
    adminReview: "理事会審査の操作",
    pollAdmin: "投票・アンケートの操作",
    notifyMembers: "会員へお知らせメールを送信",
    eventCheckin: "行事の当日受付",
    ticketStaffReply: "お問い合わせチャットへ返信",
    ticketSetStatus: "お問い合わせチャットの状態を変更",
    ticketTransfer: "お問い合わせチャットを転送",
    mfaReset: "2段階認証を解除（オーナー）"
  };

  /** 値を保存できる形に（画像は省略・長い文字は切り詰め） */
  const MAX = 500;
  function plain(v, depth = 0) {
    if (v === undefined) return null;
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (/^data:image\//.test(v)) return `［画像 ${Math.round(v.length / 1024)}KB］`;
      return v.length > MAX ? v.slice(0, MAX) + `…（全${v.length}文字）` : v;
    }
    if (v?.toDate) return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (v?.path && v?.firestore) return v.path;            // DocumentReference
    if (depth >= 3) return "…";
    if (Array.isArray(v)) return v.slice(0, 30).map(x => plain(x, depth + 1));
    if (typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v).slice(0, 40)) o[k] = /password|secret|token|code$/i.test(k) ? "［非表示］" : plain(x, depth + 1);
      return o;
    }
    return String(v);
  }
  const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

  /** 変更された項目の一覧（[{ key, before, after }]） */
  function diffOf(before, after) {
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
    return keys.filter(k => !same(before?.[k], after?.[k])).slice(0, 60)
      .map(k => ({ key: k, before: plain(before?.[k] ?? null), after: plain(after?.[k] ?? null) }));
  }
  const labelOf = (d) => String(d?.title || d?.name || d?.subject || d?.email || "").slice(0, 200);

  async function adminOf(db, uid) {
    if (!uid) return null;
    const snap = await db.doc(`admins/${uid}`).get();
    return snap.exists ? snap.data() : null;
  }
  async function write(db, entry, id) {
    const data = { ...entry, at: FieldValue.serverTimestamp() };
    if (id) await db.doc(`${LOGS}/${id}`).create(data);
    else await db.collection(LOGS).add(data);
  }
  const who = (uid, a, email = "") => ({ uid, email: a?.email || email || "", name: a?.name || "" });

  // ---------- 管理者による Firestore の書き換え ----------
  // 認証情報つきのトリガーで、だれが書き換えたかをサーバー側で確認する（画面からは改ざんできない）
  const auditWrites = onDocumentWrittenWithAuthContext({ document: "{col}/{docId}", retry: false }, async (event) => {
    const { col, docId } = event.params;
    if (SKIP_COLLECTIONS.has(col) || event.authType !== "app_user" || !event.authId) return;
    const db = getFirestore();
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    // 管理者以外（会員・招待を受けた本人など）の書き込みは記録しない。ただし管理者の登録・解除は常に記録
    let a = await adminOf(db, event.authId);
    if (!a && col === "admins") a = before || after;
    if (!a) return;
    const action = !before ? "create" : !after ? "delete" : "update";
    const changes = diffOf(before, after);
    if (action === "update" && !changes.length) return;
    try {
      await write(db, {
        type: action, ...who(event.authId, a), col, docId, label: labelOf(after || before), changes
      }, `w_${event.id}`);   // 同じイベントが二度届いても 1 件だけ
    } catch (e) {
      if (e.code !== 6) logger.error("操作ログの記録に失敗", { col, docId, error: e.message });   // 6 = ALREADY_EXISTS
    }
  });

  /** Cloud Functions の呼び出しを記録するラッパー（index.js の onCall に重ねる） */
  const fnName = () => process.env.FUNCTION_TARGET || process.env.K_SERVICE || "";
  function withAudit(onCallFn) {
    return (o, handler) => onCallFn(o, async (req, res) => {
      const name = Object.keys(ADMIN_CALLS).find(k => k.toLowerCase() === fnName().toLowerCase().replace(/-/g, ""));
      if (!name || !req.auth?.uid) return handler(req, res);
      const started = Date.now();
      let ok = true, error = "";
      try { return await handler(req, res); }
      catch (e) { ok = false; error = String(e.message || e).slice(0, 300); throw e; }
      finally {
        try {
          const db = getFirestore();
          const a = await adminOf(db, req.auth.uid);
          if (a) await write(db, {
            type: "call", ...who(req.auth.uid, a, req.auth.token?.email), fn: name, label: ADMIN_CALLS[name],
            data: plain(req.data || {}), ok, error, ms: Date.now() - started,
            ip: ipOf(req), ua: uaOf(req)
          });
        } catch (e) { logger.error("操作ログの記録に失敗", { fn: name, error: e.message }); }
      }
    });
  }
  const ipOf = (req) => String(req.rawRequest?.headers?.["x-forwarded-for"] || req.rawRequest?.ip || "").split(",")[0].trim().slice(0, 64);
  const uaOf = (req) => String(req.rawRequest?.headers?.["user-agent"] || "").slice(0, 300);

  // ---------- 管理者に正会員の登録を付与 ----------
  async function ensureAdminMember(db, uid, a) {
    const ref = db.doc(`members/${uid}`);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = new Date();
      if (!snap.exists) {
        tx.set(ref, {
          name: a.name || a.email || "", kana: "", email: String(a.email || "").toLowerCase(),
          type: "regular", status: "active", occupation: "", affiliation: "",
          message: "管理者として登録されたため、正会員の登録を自動で付与しました。", newsletter: true,
          createdAt: now, approvedAt: now, approvedBy: "system:admin", adminAuto: true
        });
        return "created";
      }
      // 申込中なら正会員で承認（会員番号は syncMemberCard が付ける）
      if (snap.get("status") === "pending") {
        tx.update(ref, { status: "active", type: "regular", approvedAt: now, approvedBy: "system:admin", adminAuto: true });
        return "approved";
      }
      return null;   // すでに有効・停止中などの会員はそのまま
    });
    if (result) {
      await write(db, {
        type: "system", ...who(uid, a), col: "members", docId: uid, label: a.name || a.email || "",
        detail: result === "created" ? "管理者のため、正会員の登録を自動で付与しました。" : "管理者のため、審査中の入会申込を正会員として承認しました。"
      });
      logger.info("管理者に正会員を付与", { uid, result });
    }
    return result;
  }

  const adminMemberOnCreate = onDocumentCreated({ document: "admins/{uid}", retry: false }, async (event) => {
    const a = event.data?.data();
    if (a) await ensureAdminMember(getFirestore(), event.params.uid, a);
  });

  // ---------- 管理画面へのログイン（画面を開くたびに呼ぶ。同じログインは 1 件だけ記録） ----------
  const adminSignedIn = onCall({ maxInstances: 5 }, async (req) => {
    const uid = req.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "ログインしてください。");
    const db = getFirestore();
    const a = await adminOf(db, uid);
    if (!a) throw new HttpsError("permission-denied", "管理者のみ実行できます。");
    const t = req.auth.token || {};
    try {
      await write(db, {
        type: "login", ...who(uid, a, t.email),
        provider: t.firebase?.sign_in_provider || "", mfa: t.mfa === true, keep: req.data?.keep === true,
        authTime: t.auth_time ? new Date(t.auth_time * 1000) : null,
        ip: ipOf(req), ua: uaOf(req)
      }, `login_${uid}_${t.auth_time || Date.now()}`);
      await db.doc(`admins/${uid}`).update({ lastLoginAt: FieldValue.serverTimestamp() });
    } catch (e) { if (e.code !== 6) throw e; }
    let member = null;
    try { member = await ensureAdminMember(db, uid, a); }
    catch (e) { logger.error("管理者への正会員の付与に失敗", { uid, error: e.message }); }
    return { ok: true, member };
  });

  return { exports: { auditWrites, adminMemberOnCreate, adminSignedIn }, withAudit };
};
