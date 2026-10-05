// ============================================================
//  投票・アンケート（総会の議決権行使・アンケート）— 電子投票
//
//  ■ 改ざん防止（電子同意書と同じ考え方）
//   1. 公開時に、設問・選択肢・期間などを SHA-256 でハッシュ化（contentHash）。公開後は変更不可
//   2. 1 票ごとに、回答と投票日時・乱数を SHA-256 でハッシュ化（receipt＝投票者の控え）
//   3. サーバーの秘密鍵で HMAC-SHA256 の封印（seal）を付け、1 つ前の票の封印とつなげる（ハッシュチェーン）
//   4. 集計の確定時に、結果と全票の控えの一覧をまとめてハッシュ化（resultsHash）し、封印する
//      → 投票者は「自分の控えが集計に含まれているか」を確認できる
//  ■ 無記名投票（anonymous）
//   「誰が投票したか」（voters）と「何に投票したか」（ballots）を別々に保存し、結びつける情報を残さない
//  ・秘密鍵は電子同意書と同じ Secret Manager の CONSENT_SEAL_KEY
//  ・データの形は README の「投票・アンケート」を参照
// ============================================================
const crypto = require("node:crypto");

const sha256Hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
function stableStringify(v) {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const GENESIS = "GENESIS";
const TYPE_LABEL = { regular: "正会員", associate: "準会員", student: "学生会員" };

/** "YYYY-MM-DDTHH:mm"（日本時間）→ ミリ秒 */
const jstMs = (s) => s ? Date.parse(`${s}:00+09:00`) : NaN;
const nowJstStr = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 16).replace(" ", "T");

/** 公開時のハッシュの元（内容） */
const pollContent = (id, p) => ({
  id, title: p.title || "", bodyHtml: p.bodyHtml || "", kind: p.kind, audience: [...(p.audience || [])].sort(),
  anonymous: !!p.anonymous, questions: p.questions || [], opensAt: p.opensAt || "", closesAt: p.closesAt || "",
  showResults: p.showResults || "after_final", version: Number(p.version) || 1
});
const pollHash = (id, p) => sha256Hex(stableStringify(pollContent(id, p)));
/** 票の控え（receipt） */
const ballotPayload = (pollId, contentHash, b) => ({ pollId, contentHash, answers: b.answers, castAtIso: b.castAtIso, nonce: b.nonce, ...(b.uid ? { uid: b.uid } : {}) });
const ballotReceipt = (pollId, contentHash, b) => sha256Hex(stableStringify(ballotPayload(pollId, contentHash, b)));
const sealMessage = (pollId, ballotId, b) => [pollId, b.seq, ballotId, b.receipt, b.prevSeal, b.castAtIso].join("\n");
const makeSeal = (key, pollId, ballotId, b) => crypto.createHmac("sha256", key).update(sealMessage(pollId, ballotId, b), "utf8").digest("hex");

/** 設問の形式チェック（管理者が下書きを公開するとき） */
function validatePoll(p) {
  const errs = [];
  if (!p.title || p.title.length > 200) errs.push("タイトルを入力してください（200 文字まで）。");
  if (!["resolution", "survey"].includes(p.kind)) errs.push("種類が正しくありません。");
  if (!Array.isArray(p.audience) || !p.audience.length || p.audience.some(t => !TYPE_LABEL[t])) errs.push("対象の会員種別を選んでください。");
  if (!p.closesAt || isNaN(jstMs(p.closesAt))) errs.push("締切日時を入力してください。");
  if (p.opensAt && (isNaN(jstMs(p.opensAt)) || jstMs(p.opensAt) >= jstMs(p.closesAt))) errs.push("開始日時は締切より前にしてください。");
  if (jstMs(p.closesAt) <= Date.now()) errs.push("締切日時が過ぎています。");
  const qs = p.questions || [];
  if (!qs.length || qs.length > 50) errs.push("設問を 1〜50 個にしてください。");
  const ids = new Set();
  qs.forEach((q, i) => {
    const n = `設問${i + 1}`;
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(q.id || "") || ids.has(q.id)) errs.push(`${n}：ID が正しくありません。`);
    ids.add(q.id);
    if (!q.text || q.text.length > 1000) errs.push(`${n}：設問文を入力してください。`);
    if (!["single", "multi", "text"].includes(q.type)) errs.push(`${n}：形式が正しくありません。`);
    if (q.type !== "text") {
      const o = q.options || [];
      if (!o.length || o.length > 20 || o.some(x => !x || x.length > 100) || new Set(o).size !== o.length) errs.push(`${n}：選択肢を 1〜20 個（重複なし・100 文字まで）にしてください。`);
    }
  });
  return errs;
}

/** 回答の形式チェック（投票時） */
function cleanAnswers(poll, answers) {
  if (!answers || typeof answers !== "object") throw new Error("回答がありません。");
  const out = {};
  for (const q of poll.questions) {
    const a = answers[q.id];
    const empty = a === undefined || a === null || a === "" || (Array.isArray(a) && !a.length);
    if (empty) { if (q.required) throw new Error(`「${q.text.slice(0, 30)}」に回答してください。`); continue; }
    if (q.type === "single") {
      if (typeof a !== "string" || !q.options.includes(a)) throw new Error(`「${q.text.slice(0, 30)}」の回答が正しくありません。`);
      out[q.id] = a;
    } else if (q.type === "multi") {
      if (!Array.isArray(a) || a.some(x => !q.options.includes(x)) || new Set(a).size !== a.length) throw new Error(`「${q.text.slice(0, 30)}」の回答が正しくありません。`);
      if (q.maxChoices && a.length > q.maxChoices) throw new Error(`「${q.text.slice(0, 30)}」は ${q.maxChoices} つまで選べます。`);
      out[q.id] = q.options.filter(o => a.includes(o)); // 選択肢の順にそろえる
    } else {
      if (typeof a !== "string" || a.length > 1000) throw new Error(`「${q.text.slice(0, 30)}」は 1000 文字以内で入力してください。`);
      out[q.id] = a.trim();
    }
  }
  return out;
}

/** 集計 */
function tally(poll, ballots, eligible) {
  const tallies = {}, textCount = {};
  for (const q of poll.questions) {
    if (q.type === "text") textCount[q.id] = 0;
    else tallies[q.id] = Object.fromEntries(q.options.map(o => [o, 0]));
  }
  for (const b of ballots) {
    for (const q of poll.questions) {
      const a = b.answers?.[q.id];
      if (a === undefined) continue;
      if (q.type === "text") { if (a) textCount[q.id]++; }
      else for (const o of (Array.isArray(a) ? a : [a])) if (o in tallies[q.id]) tallies[q.id][o]++;
    }
  }
  const receipts = ballots.map(b => b.receipt).sort();
  return { tallies, textCount, total: ballots.length, eligible, receipts };
}
const resultsHashOf = (pollId, contentHash, r) => sha256Hex(stableStringify({ pollId, contentHash, tallies: r.tallies, textCount: r.textCount, total: r.total, eligible: r.eligible, receipts: r.receipts }));

module.exports = function polls({ onCall, HttpsError, getFirestore, FieldValue, logger, sendAll, mails, mailSecrets, SEAL_KEY }) {
  const fail = (code, msg) => { throw new HttpsError(code, msg); };

  async function requireAdmin(db, req) {
    const uid = req.auth?.uid;
    if (!uid || !(await db.doc(`admins/${uid}`).get()).exists) fail("permission-denied", "管理者のみ実行できます。");
    return uid;
  }
  async function eligibleMembers(db, poll) {
    const snap = await db.collection("members").where("status", "==", "active").get();
    return snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(m => (poll.audience || []).includes(m.type));
  }
  const isOpenNow = (p) => p.status === "open" && (!p.opensAt || jstMs(p.opensAt) <= Date.now()) && jstMs(p.closesAt) > Date.now();

  // ---------- 会員：投票 ----------
  const castVote = onCall({ secrets: [SEAL_KEY, ...mailSecrets], maxInstances: 10 }, async (req) => {
    const db = getFirestore();
    const uid = req.auth?.uid;
    if (!uid) fail("unauthenticated", "ログインしてください。");
    const { pollId, answers } = req.data || {};
    if (typeof pollId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(pollId)) fail("invalid-argument", "投票を指定してください。");
    const pollRef = db.doc(`polls/${pollId}`);
    const memberRef = db.doc(`members/${uid}`);
    const voterRef = pollRef.collection("voters").doc(uid);
    const headRef = pollRef.collection("private").doc("chain");
    const ballotRef = pollRef.collection("ballots").doc();
    const key = SEAL_KEY.value();

    const out = await db.runTransaction(async (tx) => {
      const [p, m, v, h] = await Promise.all([tx.get(pollRef), tx.get(memberRef), tx.get(voterRef), tx.get(headRef)]);
      if (!p.exists) fail("not-found", "投票が見つかりません。");
      const poll = p.data();
      if (!m.exists || m.get("status") !== "active") fail("permission-denied", "有効な会員のみ投票できます。");
      if (!(poll.audience || []).includes(m.get("type"))) fail("permission-denied", `この投票の対象は ${(poll.audience || []).map(t => TYPE_LABEL[t]).join("・")} です。`);
      if (!isOpenNow(poll)) fail("failed-precondition", poll.status === "draft" ? "この投票はまだ公開されていません。" : poll.status === "open" && poll.opensAt && jstMs(poll.opensAt) > Date.now() ? "まだ受付が始まっていません。" : "受付期間が終了しています。");
      if (v.exists) fail("already-exists", "すでに投票済みです（投票は 1 人 1 回です）。");
      let clean;
      try { clean = cleanAnswers(poll, answers); } catch (e) { fail("invalid-argument", e.message); }
      const castAtIso = new Date().toISOString();
      const b = { answers: clean, castAtIso, nonce: crypto.randomBytes(16).toString("hex"), ...(poll.anonymous ? {} : { uid }) };
      b.receipt = ballotReceipt(pollId, poll.contentHash, b);
      b.seq = (h.exists ? Number(h.get("seq")) || 0 : 0) + 1;
      b.prevSeal = h.exists ? h.get("lastSeal") : GENESIS;
      b.seal = makeSeal(key, pollId, ballotRef.id, b);
      tx.set(ballotRef, {
        answers: clean, receipt: b.receipt, seq: b.seq, prevSeal: b.prevSeal, seal: b.seal, castAtIso, nonce: b.nonce, castAt: FieldValue.serverTimestamp(),
        ...(poll.anonymous ? {} : { uid, name: m.get("name") || "", memberNo: m.get("memberNo") || "" })
      });
      // 無記名：誰が投票したかだけを記録（どの票かは結びつけない）
      tx.set(voterRef, { votedAt: FieldValue.serverTimestamp(), name: m.get("name") || "", memberNo: m.get("memberNo") || "", ...(poll.anonymous ? {} : { ballotId: ballotRef.id, receipt: b.receipt }) });
      tx.set(headRef, { seq: b.seq, lastSeal: b.seal, lastId: ballotRef.id, updatedAt: FieldValue.serverTimestamp() });
      tx.update(pollRef, { voteCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      return { poll, member: m.data(), b };
    });

    if (out.member.email) {
      await sendAll(mails.voteReceipt({ to: out.member.email, name: out.member.name, poll: { id: pollId, ...out.poll }, ballotId: ballotRef.id, receipt: out.b.receipt, seq: out.b.seq, castAtIso: out.b.castAtIso }), "投票の控え");
    }
    logger.info("投票", { pollId, seq: out.b.seq, anonymous: !!out.poll.anonymous });
    return { ballotId: ballotRef.id, receipt: out.b.receipt, seq: out.b.seq, castAt: out.b.castAtIso };
  });

  // ---------- 会員：自分の投票状況 ----------
  const myVote = onCall({ maxInstances: 10 }, async (req) => {
    const db = getFirestore();
    const uid = req.auth?.uid;
    if (!uid) fail("unauthenticated", "ログインしてください。");
    const { pollId } = req.data || {};
    if (typeof pollId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(pollId)) fail("invalid-argument", "投票を指定してください。");
    const v = await db.doc(`polls/${pollId}/voters/${uid}`).get();
    if (!v.exists) return { voted: false };
    return { voted: true, votedAt: v.get("votedAt")?.toDate?.().toISOString() || null, ...(v.get("ballotId") ? { ballotId: v.get("ballotId"), receipt: v.get("receipt") } : {}) };
  });

  // ---------- だれでも：控えで票を確認 ----------
  const verifyBallot = onCall({ secrets: [SEAL_KEY], maxInstances: 5 }, async (req) => {
    const db = getFirestore();
    const { pollId, ballotId, receipt } = req.data || {};
    const r = String(receipt || "").replace(/\s/g, "").toLowerCase();
    if (typeof pollId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(pollId) || typeof ballotId !== "string" || !/^[A-Za-z0-9]{10,40}$/.test(ballotId)) {
      return { ok: false, found: false, counted: false, checks: [], summary: "受付番号を確認できません。" };
    }
    const [p, b] = await Promise.all([db.doc(`polls/${pollId}`).get(), db.doc(`polls/${pollId}/ballots/${ballotId}`).get()]);
    if (!p.exists || !b.exists || !safeEqual(r, b.get("receipt"))) return { ok: false, found: false, counted: false, checks: [], summary: "該当する票が見つかりません。受付番号と受付ハッシュをご確認ください。" };
    const poll = p.data(), x = b.data();
    const key = SEAL_KEY.value();
    const checks = [];
    const add = (label, ok, detail = "") => checks.push({ label, ok: !!ok, detail });
    add("投票の内容（設問・期間など）が公開時から変わっていない", pollHash(pollId, poll) === poll.contentHash);
    add("票の控え（ハッシュ値）が投票内容と一致する", ballotReceipt(pollId, poll.contentHash, { ...x, ...(x.uid ? { uid: x.uid } : {}) }) === x.receipt, "回答が書き換えられていないか");
    add("サーバーの封印（HMAC-SHA256）が正しい", safeEqual(makeSeal(key, pollId, ballotId, x), x.seal), `連番 ${x.seq}`);
    let linkOk = x.seq === 1 && x.prevSeal === GENESIS;
    if (!linkOk) { const prev = await p.ref.collection("ballots").where("seq", "==", x.seq - 1).limit(1).get(); linkOk = !prev.empty && prev.docs[0].get("seal") === x.prevSeal; }
    add("1 つ前の票と正しくつながっている", linkOk);
    let counted = null;
    if (poll.status === "final") {
      const res = poll.results || (await p.ref.collection("private").doc("results").get()).data();
      counted = !!res?.receipts?.includes(x.receipt);
      add("確定した集計に、この票が含まれている", counted);
    }
    const ok = checks.every(c => c.ok);
    return { ok, found: true, counted, checks, summary: ok ? (poll.status === "final" ? "この票は有効で、確定した集計に含まれています。" : "この票は有効に受け付けられています（集計の確定前）。") : "検証で問題が見つかりました。" };
  });

  // ---------- 管理者：公開・終了・確定など ----------
  const pollAdmin = onCall({ secrets: [SEAL_KEY, ...mailSecrets], maxInstances: 3, timeoutSeconds: 300 }, async (req) => {
    const db = getFirestore();
    const adminUid = await requireAdmin(db, req);
    const { action, id, notify } = req.data || {};
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail("invalid-argument", "投票を指定してください。");
    const ref = db.doc(`polls/${id}`);
    const snap = await ref.get();
    if (!snap.exists) fail("not-found", "投票が見つかりません。");
    const poll = snap.data();
    const key = SEAL_KEY.value();
    const allBallots = async () => (await ref.collection("ballots").orderBy("seq").get()).docs.map(d => ({ id: d.id, ...d.data() }));

    if (action === "publish") {
      if (poll.status !== "draft") fail("failed-precondition", "下書きの投票だけ公開できます。");
      const errs = validatePoll(poll);
      if (errs.length) fail("invalid-argument", errs.join("\n"));
      const contentHash = pollHash(id, poll);
      await ref.update({ status: "open", contentHash, publishedAt: FieldValue.serverTimestamp(), publishedBy: adminUid, voteCount: 0, updatedAt: FieldValue.serverTimestamp() });
      let notified = 0;
      if (notify) {
        const to = (await eligibleMembers(db, poll)).filter(m => m.email && m.newsletter !== false);
        if (to.length) await sendAll(to.flatMap(m => mails.pollOpened({ to: m.email, name: m.name, poll: { id, ...poll } })), "投票の案内");
        notified = to.length;
      }
      logger.info("投票を公開", { id, notified });
      return { ok: true, contentHash, notified };
    }
    if (action === "close") {
      if (poll.status !== "open") fail("failed-precondition", "受付中の投票ではありません。");
      await ref.update({ status: "closed", closedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return { ok: true };
    }
    if (action === "reopen") {
      if (poll.status !== "closed") fail("failed-precondition", "受付終了（確定前）の投票だけ再開できます。");
      if (jstMs(poll.closesAt) <= Date.now()) fail("failed-precondition", "締切日時を過ぎているため再開できません。");
      await ref.update({ status: "open", closedAt: null, updatedAt: FieldValue.serverTimestamp() });
      return { ok: true };
    }
    if (action === "tally" || action === "finalize") {
      if (action === "finalize" && poll.status !== "closed") fail("failed-precondition", "受付を終了してから確定してください。");
      if (poll.status === "draft") fail("failed-precondition", "公開前の投票です。");
      const ballots = await allBallots();
      const eligible = (await eligibleMembers(db, poll)).length;
      const r = tally(poll, ballots, eligible);
      if (action === "tally") return { results: r };
      r.resultsHash = resultsHashOf(id, poll.contentHash, r);
      r.seal = crypto.createHmac("sha256", key).update(`${id}\nresults\n${r.resultsHash}`, "utf8").digest("hex");
      r.finalizedAtIso = new Date().toISOString();
      if (poll.showResults === "never") {
        await ref.collection("private").doc("results").set(r);
        await ref.update({ status: "final", finalizedAt: FieldValue.serverTimestamp(), finalizedBy: adminUid, updatedAt: FieldValue.serverTimestamp() });
      } else {
        await ref.update({ status: "final", results: r, finalizedAt: FieldValue.serverTimestamp(), finalizedBy: adminUid, updatedAt: FieldValue.serverTimestamp() });
      }
      logger.info("投票を確定", { id, total: r.total });
      return { ok: true, results: r };
    }
    if (action === "verify") {
      const ballots = await allBallots();
      const broken = [];
      let prev = GENESIS, expect = 1;
      for (const b of ballots) {
        const problems = [];
        if (b.seq !== expect) problems.push(`連番が ${expect} ではなく ${b.seq}（票の欠落の可能性）`);
        if (b.prevSeal !== prev) problems.push("1 つ前の票の封印とつながっていない");
        if (!safeEqual(makeSeal(key, id, b.id, b), b.seal)) problems.push("封印が一致しない（票が改ざんされた可能性）");
        if (ballotReceipt(id, poll.contentHash, b) !== b.receipt) problems.push("控え（ハッシュ値）が回答と一致しない");
        if (problems.length) broken.push({ ballotId: b.id, seq: b.seq, problems });
        prev = b.seal; expect = (b.seq || expect) + 1;
      }
      const head = await ref.collection("private").doc("chain").get();
      if (head.exists && head.get("lastSeal") !== prev) broken.push({ ballotId: head.get("lastId"), seq: head.get("seq"), problems: ["チェーンの末尾が記録と一致しない（最新の票が削除された可能性）"] });
      if (poll.contentHash && pollHash(id, poll) !== poll.contentHash) broken.push({ ballotId: "-", seq: 0, problems: ["投票の内容が公開時から変更されている"] });
      if ((Number(poll.voteCount) || 0) !== ballots.length) broken.push({ ballotId: "-", seq: 0, problems: [`投票数（${poll.voteCount}）と票の数（${ballots.length}）が一致しない`] });
      const ok = !broken.length;
      return { ok, total: ballots.length, broken, summary: ok ? `${ballots.length} 票すべてが正しくつながっています。` : `${broken.length} 件の問題が見つかりました。` };
    }
    if (action === "turnout") {
      const members = await eligibleMembers(db, poll);
      const voted = new Set((await ref.collection("voters").get()).docs.map(d => d.id));
      return { eligible: members.length, voted: members.filter(m => voted.has(m.uid)).length, notVoted: members.filter(m => !voted.has(m.uid)).map(m => ({ name: m.name || "", memberNo: m.memberNo || "", email: m.email || "" })) };
    }
    fail("invalid-argument", "不明な操作です。");
  });

  return { castVote, myVote, verifyBallot, pollAdmin };
};
module.exports.validatePoll = validatePoll;
module.exports.cleanAnswers = cleanAnswers;
module.exports.tally = tally;
