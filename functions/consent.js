// ============================================================
//  電子同意書：署名の封印（seal）と検証
//
//  ・署名が保存されると sealConsentSignature が動き、
//      1. 文書・署名画像・署名記録のハッシュをサーバーで計算し直して一致を確認
//      2. 1 つ前の署名の封印（prevSeal）とつなげて、秘密鍵で HMAC-SHA256 の封印（seal）を作成
//         （consent_chain/head に最新の連番と封印を記録 → ハッシュチェーン）
//      3. 署名者へ控えのメールを送信
//  ・verifyConsent（呼び出し用の関数）で、1 件の検証・全件のチェーン検証ができる
//  ・秘密鍵は Secret Manager の CONSENT_SEAL_KEY（README 参照）
//  ※ ハッシュの計算方法は assets/js/consent-core.js と必ず同じにしてください
// ============================================================
const crypto = require("node:crypto");

/** キーを並べ替えた JSON（consent-core.js の stableStringify と同じ） */
function stableStringify(v) {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const formContentHash = (formId, f) =>
  sha256Hex(stableStringify({ formId, title: f.title || "", bodyHtml: f.bodyHtml || "", version: Number(f.version) || 1 }));

const recordPayload = (s) => ({
  formId: s.formId, formHash: s.formHash, formVersion: Number(s.formVersion) || 1,
  signerType: s.signerType, uid: s.uid || null, name: s.name, email: s.email,
  extra: s.extra || {}, signatureHash: s.signatureHash, clientSignedAt: s.clientSignedAt
});
const recordHash = (s) => sha256Hex(stableStringify(recordPayload(s)));

/** 封印の元になる文字列（並び・区切りを変えると過去の封印を検証できなくなるので変更しない） */
const sealMessage = (s, id) => [s.seq, id, s.recordHash, s.formHash, s.prevSeal, s.sealedAtIso].join("\n");
const makeSeal = (key, s, id) => crypto.createHmac("sha256", key).update(sealMessage(s, id), "utf8").digest("hex");
const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const GENESIS = "GENESIS";

/**
 * 署名の内容をサーバーで検証する（封印前・封印後の両方で使用）
 * @returns [{ label, ok, detail }]
 */
function checkRecord(s, form, formId) {
  const checks = [];
  const add = (label, ok, detail = "") => checks.push({ label, ok: !!ok, detail });
  add("同意書が存在する", !!form, form ? `${form.title}（第${form.version}版）` : "同意書が見つかりません");
  if (form) {
    const fh = formContentHash(formId, form);
    add("同意書の本文が公開時から変わっていない", fh === form.contentHash, `公開時 ${form.contentHash?.slice(0, 16)}… / 現在 ${fh.slice(0, 16)}…`);
    add("署名した文面のハッシュが同意書と一致する", s.formHash === form.contentHash);
  }
  add("署名画像のハッシュが一致する", sha256Hex(s.signatureImage || "") === s.signatureHash);
  add("署名記録のハッシュが一致する", recordHash(s) === s.recordHash, "氏名・メール・日時・署名画像などが改ざんされていないか");
  return checks;
}

module.exports = function consent({ onDocumentCreated, onCall, HttpsError, defineSecret, getFirestore, FieldValue, logger, sendAll, mailOpts, mails }) {
  const CONSENT_SEAL_KEY = defineSecret("CONSENT_SEAL_KEY");

  // ---------- 署名の封印 ＋ 控えのメール ----------
  const sealConsentSignature = onDocumentCreated(
    { document: "consent_signatures/{id}", ...mailOpts, secrets: [...mailOpts.secrets, CONSENT_SEAL_KEY] },
    async (event) => {
      const db = getFirestore();
      const id = event.params.id;
      const ref = event.data.ref;
      const s = event.data.data();
      const formSnap = await db.doc(`consent_forms/${s.formId}`).get();
      const form = formSnap.exists ? formSnap.data() : null;
      const checks = checkRecord(s, form, s.formId);
      const valid = checks.every(c => c.ok);

      // ハッシュチェーンにつなげて封印（同時に署名されても順番が崩れないようトランザクションで）
      const sealed = await db.runTransaction(async (tx) => {
        const headRef = db.doc("consent_chain/head");
        const head = await tx.get(headRef);
        const cur = await tx.get(ref);
        if (cur.get("seal")) return null; // すでに封印済み（再実行時）
        const seq = (head.exists ? Number(head.get("seq")) || 0 : 0) + 1;
        const rec = { seq, recordHash: s.recordHash, formHash: s.formHash, prevSeal: head.exists ? head.get("lastSeal") : GENESIS, sealedAtIso: new Date().toISOString() };
        rec.seal = makeSeal(CONSENT_SEAL_KEY.value(), rec, id);
        tx.update(ref, { seq, prevSeal: rec.prevSeal, seal: rec.seal, sealedAtIso: rec.sealedAtIso, sealedAt: FieldValue.serverTimestamp(), serverCheck: { ok: valid, checks } });
        tx.set(headRef, { seq, lastSeal: rec.seal, lastId: id, updatedAt: FieldValue.serverTimestamp() });
        return rec;
      });
      if (!sealed) return;
      if (!valid) logger.warn("署名の検証で不一致があります", { id, checks: checks.filter(c => !c.ok) });
      logger.info("署名を封印", { id, seq: sealed.seq });
      await sendAll(mails.consentSigned({ ...s, id, seal: sealed.seal, seq: sealed.seq, form }), "同意書の控え");
    }
  );

  // ---------- 検証 ----------
  //  { id }           … 管理者：1 件を詳細に検証
  //  { id, hash }     … だれでも：控えのハッシュ値と一致する場合のみ結果を返す（氏名は一部伏せ字）
  //  { mode: "chain" } … 管理者：全署名のハッシュチェーンを検証
  const verifyConsent = onCall({ secrets: [CONSENT_SEAL_KEY], maxInstances: 3 }, async (req) => {
    const db = getFirestore();
    const key = CONSENT_SEAL_KEY.value();
    const uid = req.auth?.uid;
    const isAdmin = uid ? (await db.doc(`admins/${uid}`).get()).exists : false;
    const { id, hash, mode } = req.data || {};

    if (mode === "chain") {
      if (!isAdmin) throw new HttpsError("permission-denied", "管理者のみ実行できます。");
      const snap = await db.collection("consent_signatures").orderBy("seq").get();
      const broken = [];
      let prev = GENESIS, expectSeq = 1;
      snap.forEach(d => {
        const s = d.data();
        const problems = [];
        if (s.seq !== expectSeq) problems.push(`連番が ${expectSeq} ではなく ${s.seq}（記録の欠落の可能性）`);
        if (s.prevSeal !== prev) problems.push("1 つ前の封印とつながっていない");
        if (!safeEqual(makeSeal(key, s, d.id), s.seal)) problems.push("封印が一致しない（記録が改ざんされた可能性）");
        if (recordHash(s) !== s.recordHash) problems.push("署名記録のハッシュが一致しない");
        if (problems.length) broken.push({ id: d.id, seq: s.seq, name: s.name, formTitle: s.formTitle, problems });
        prev = s.seal; expectSeq = (s.seq || expectSeq) + 1;
      });
      const head = await db.doc("consent_chain/head").get();
      if (head.exists && head.get("lastSeal") !== prev) broken.push({ id: head.get("lastId"), seq: head.get("seq"), problems: ["チェーンの末尾が記録と一致しない（最新の記録が削除された可能性）"] });
      const ok = broken.length === 0;
      return { ok, total: snap.size, broken, summary: ok ? `${snap.size} 件すべての署名が正しくつながっています。` : `${broken.length} 件に問題が見つかりました。` };
    }

    if (typeof id !== "string" || !id || id.length > 200) throw new HttpsError("invalid-argument", "署名IDを指定してください。");
    const snap = await db.doc(`consent_signatures/${id}`).get();
    const s = snap.exists ? snap.data() : null;
    // 管理者以外は、控えのハッシュ値が一致しない限り存在も明かさない
    if (!isAdmin && (!s || typeof hash !== "string" || !safeEqual(hash.replace(/\s/g, "").toLowerCase(), s.recordHash))) {
      return { ok: false, found: false, checks: [], summary: "該当する署名が見つかりません。署名IDとハッシュ値をご確認ください。" };
    }
    if (!s) throw new HttpsError("not-found", "署名が見つかりません。");

    const formSnap = await db.doc(`consent_forms/${s.formId}`).get();
    const checks = checkRecord(s, formSnap.exists ? formSnap.data() : null, s.formId);
    if (!s.seal) checks.push({ label: "サーバーの封印", ok: false, detail: "まだ封印されていません（数秒後に再度お試しください）" });
    else {
      checks.push({ label: "サーバーの封印（HMAC-SHA256）が正しい", ok: safeEqual(makeSeal(key, s, id), s.seal), detail: `連番 ${s.seq}` });
      // 1 つ前の記録とのつながり
      let linkOk = s.prevSeal === GENESIS && s.seq === 1;
      if (!linkOk) {
        const prev = await db.collection("consent_signatures").where("seq", "==", s.seq - 1).limit(1).get();
        linkOk = !prev.empty && prev.docs[0].get("seal") === s.prevSeal;
      }
      checks.push({ label: "1 つ前の署名と正しくつながっている", ok: linkOk });
    }
    const ok = checks.every(c => c.ok);
    const signedAt = s.agreedAt?.toDate?.().toISOString() || s.clientSignedAt;
    const mask = (n) => (n || "").length <= 1 ? "＊" : n[0] + "＊".repeat(Math.min(4, n.length - 1));
    const result = {
      ok, found: true, checks,
      summary: ok ? "この署名は有効です。署名後に内容が変更されていないことを確認しました。" : "検証で問題が見つかりました。",
      formTitle: s.formTitle, formVersion: s.formVersion, signedAt, seq: s.seq || null,
      name: isAdmin ? s.name : mask(s.name)
    };
    return result;
  });

  return { sealConsentSignature, verifyConsent };
};
