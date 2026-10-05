// ============================================================
//  2 段階認証（管理者・会員のすべてのログインで使える。本人が「認証アプリ」か「メール」を選ぶ）
//
//  しくみ
//  ・設定した人のアカウントには、カスタムクレーム mfa: true を付ける
//  ・ログインのたびに 6 桁のコードを確認し、確認できたら mfaAt にそのログインの時刻（auth_time）を入れる
//    → Firestore / Storage のルールと Cloud Functions は「mfa が true なら mfaAt == auth_time」のときだけ
//      ログイン済みとして扱う（ログインし直すと auth_time が変わるので、毎回コードが必要）
//  ・認証アプリ：TOTP（RFC 6238。30 秒ごと・6 桁）。Google Authenticator / Microsoft Authenticator など
//  ・メール：ログインのたびに、登録したメールアドレスへ 6 桁のコードを送る（10 分間有効）
//  ・どちらも、スマホをなくしたときなどのための「予備コード」（1 回ずつ使える 10 個）を発行する
//  ・オーナーは、ほかの人の 2 段階認証を解除できる（管理画面）
//  データ
//    mfa/{uid} … 方式・秘密鍵・予備コード（ハッシュ）・送信したコード（ハッシュ）など。ブラウザからは読めない
// ============================================================
const crypto = require("node:crypto");

const MFA = {
  issuer: "普賢アーカイブ",
  emailCodeMin: 10,       // メールのコードの有効期限（分）
  emailCooldownSec: 60,   // メールのコードを送り直せるまでの秒数
  emailPerHour: 8,        // 1 時間に送れるメールのコードの数
  maxFails: 5,            // 続けて間違えられる回数（超えたら一時停止）
  lockMin: 15,            // 一時停止の時間（分）
  backupCount: 10         // 予備コードの数
};

/** このログイン（ID トークン）で 2 段階認証が済んでいるか（設定していない人は常に true） */
const sessionOk = (token) => !token || token.mfa !== true || token.mfaAt === token.auth_time;

// ---------- TOTP ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(buf) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) {
    val = ((val << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    val = ((val << 5) | B32.indexOf(c)) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
/** 合っていれば、そのコードの時間枠（step）を返す。前後 30 秒のずれまで許す。同じコードの使い回しは不可 */
function verifyTotp(secret, code, lastStep = 0) {
  const key = b32decode(secret), step = Math.floor(Date.now() / 30_000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (s > lastStep && safeEq(hotp(key, s), code)) return s;
  }
  return null;
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const digits6 = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const cleanCode = (c) => String(c || "").replace(/[\s-]/g, "").toLowerCase();
const backupCodes = () => Array.from({ length: MFA.backupCount }, () => {
  const s = crypto.randomBytes(5).toString("hex");   // 10 文字（0-9a-f）
  return `${s.slice(0, 5)}-${s.slice(5)}`;
});
const maskEmail = (e) => String(e || "").replace(/^(.{1,2})[^@]*(@.*)$/, "$1***$2");

module.exports = function mfa({ onCall, HttpsError, getFirestore, getAuth, FieldValue, logger, sendAll, mails, mailSecrets }) {
  const ref = (uid) => getFirestore().doc(`mfa/${uid}`);

  function requireUser(req) {
    if (!req.auth?.uid) throw new HttpsError("unauthenticated", "ログインしてください。");
    return req.auth;
  }
  /** 設定の変更は、このログインで 2 段階認証が済んでいるときだけ */
  function requireSession(req) {
    const a = requireUser(req);
    if (!sessionOk(a.token)) throw new HttpsError("permission-denied", "先に 2 段階認証のコードを入力してください。");
    return a;
  }
  /** カスタムクレームを更新（ほかのクレームは残す） */
  async function setClaims(uid, patch) {
    const auth = getAuth();
    const u = await auth.getUser(uid);
    const c = { ...(u.customClaims || {}) };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete c[k]; else c[k] = v; }
    await auth.setCustomUserClaims(uid, c);
  }
  /** 間違いが続いたら一時停止 */
  function checkLock(d) {
    const until = d?.lockUntil?.toMillis?.() || 0;
    if (until > Date.now()) {
      throw new HttpsError("resource-exhausted", `コードを続けて間違えたため、一時的に停止しています。${Math.ceil((until - Date.now()) / 60_000)} 分ほどしてからお試しください。`);
    }
  }
  async function recordFail(r, d) {
    const fails = (d?.fails || 0) + 1;
    const lock = fails >= MFA.maxFails;
    await r.set({ fails: lock ? 0 : fails, ...(lock ? { lockUntil: new Date(Date.now() + MFA.lockMin * 60_000) } : {}) }, { merge: true });
    throw new HttpsError("invalid-argument", lock
      ? `コードを続けて間違えたため、${MFA.lockMin} 分間停止します。`
      : `コードが正しくありません（あと ${MFA.maxFails - fails} 回まで）。`);
  }
  /** メールでコードを送る（送り直しの間隔・1 時間の回数を制限） */
  async function sendEmailCode(r, d, to, field, purpose) {
    const now = Date.now();
    const sent = (d?.emailSends || []).filter(t => now - t < 3_600_000);
    if (sent.length && now - sent[sent.length - 1] < MFA.emailCooldownSec * 1000) {
      throw new HttpsError("resource-exhausted", `少し前にコードを送信しました。${MFA.emailCooldownSec} 秒ほどしてから送り直してください。`);
    }
    if (sent.length >= MFA.emailPerHour) throw new HttpsError("resource-exhausted", "コードの送信が多すぎます。しばらくしてからお試しください。");
    const code = digits6();
    await r.set({ [field]: { hash: sha(code), exp: now + MFA.emailCodeMin * 60_000 }, emailSends: [...sent, now] }, { merge: true });
    await sendAll(mails.mfaCode({ to, code, minutes: MFA.emailCodeMin, purpose }), "2 段階認証のコード");
  }
  const emailCodeOk = (slot, code) => slot && slot.exp > Date.now() && safeEq(slot.hash, sha(code));

  /** 登録済みの方式でコードを確かめる（予備コードも可）。合えば更新内容を返す */
  function checkCode(d, code) {
    const c = cleanCode(code);
    if (/^\d{6}$/.test(c)) {
      if (d.method === "totp") {
        const step = verifyTotp(d.secret, c, d.lastStep || 0);
        if (step) return { lastStep: step };
      } else if (d.method === "email" && emailCodeOk(d.loginCode, c)) {
        return { loginCode: FieldValue.delete() };
      }
      return null;
    }
    if (/^[0-9a-f]{10}$/.test(c)) {
      const h = sha(c), left = d.backup || [];
      if (left.includes(h)) return { backup: left.filter(x => x !== h), usedBackup: true };
    }
    return null;
  }

  // ---------- 状態 ----------
  const mfaStatus = onCall({ maxInstances: 5 }, async (req) => {
    const a = requireUser(req);
    const d = (await ref(a.uid).get()).data();
    const on = !!d?.method;
    return {
      enabled: on, method: on ? d.method : "", email: on && d.method === "email" ? maskEmail(d.email) : "",
      backupLeft: on ? (d.backup || []).length : 0, verified: sessionOk(a.token),
      accountEmail: a.token.email || ""
    };
  });

  // ---------- ログイン時：コードを確かめる ----------
  const mfaSendLoginCode = onCall({ secrets: mailSecrets, maxInstances: 5 }, async (req) => {
    const a = requireUser(req);
    const r = ref(a.uid), d = (await r.get()).data();
    if (d?.method !== "email") throw new HttpsError("failed-precondition", "メールでの 2 段階認証は設定されていません。");
    checkLock(d);
    await sendEmailCode(r, d, d.email, "loginCode", "login");
    return { ok: true, email: maskEmail(d.email) };
  });

  const mfaVerify = onCall({ maxInstances: 5 }, async (req) => {
    const a = requireUser(req);
    const r = ref(a.uid), d = (await r.get()).data();
    if (!d?.method) { await setClaims(a.uid, { mfa: undefined, mfaAt: undefined }); return { ok: true }; }
    checkLock(d);
    const patch = checkCode(d, req.data?.code);
    if (!patch) await recordFail(r, d);
    const { usedBackup, ...rest } = patch;
    await r.set({ ...rest, fails: 0, lastLoginAt: FieldValue.serverTimestamp() }, { merge: true });
    await setClaims(a.uid, { mfa: true, mfaAt: a.token.auth_time });
    if (usedBackup) logger.info("2 段階認証：予備コードでログイン", { uid: a.uid });
    return { ok: true, backupLeft: usedBackup ? rest.backup.length : undefined };
  });

  // ---------- 設定する ----------
  const mfaEnrollStart = onCall({ secrets: mailSecrets, maxInstances: 5 }, async (req) => {
    const a = requireSession(req);
    const method = req.data?.method;
    const r = ref(a.uid), d = (await r.get()).data() || {};
    if (d.method) throw new HttpsError("failed-precondition", "2 段階認証はすでに設定されています。方式を変えるときは、いったん解除してください。");
    checkLock(d);
    if (method === "totp") {
      const secret = b32encode(crypto.randomBytes(20));
      await r.set({ pending: { method, secret, at: Date.now() } }, { merge: true });
      const label = encodeURIComponent(`${MFA.issuer}:${a.token.email || a.uid}`);
      return { method, secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(MFA.issuer)}&algorithm=SHA1&digits=6&period=30` };
    }
    if (method === "email") {
      const email = String(a.token.email || "").toLowerCase();
      if (!email) throw new HttpsError("failed-precondition", "このアカウントにはメールアドレスがありません。認証アプリを選んでください。");
      await r.set({ pending: { method, email, at: Date.now() } }, { merge: true });
      await sendEmailCode(r, d, email, "pendingCode", "enroll");
      return { method, email: maskEmail(email) };
    }
    throw new HttpsError("invalid-argument", "方式を選んでください。");
  });

  const mfaEnrollConfirm = onCall({ maxInstances: 5 }, async (req) => {
    const a = requireSession(req);
    const r = ref(a.uid), d = (await r.get()).data() || {};
    const p = d.pending;
    if (!p || Date.now() - p.at > 30 * 60_000) throw new HttpsError("failed-precondition", "設定の有効期限が切れました。はじめからやり直してください。");
    checkLock(d);
    const c = cleanCode(req.data?.code);
    const step = p.method === "totp" ? verifyTotp(p.secret, c) : null;
    const ok = p.method === "totp" ? !!step : emailCodeOk(d.pendingCode, c);
    if (!ok) await recordFail(r, d);
    const codes = backupCodes();
    await r.set({
      method: p.method, ...(p.method === "totp" ? { secret: p.secret, lastStep: step } : { email: p.email }),
      backup: codes.map(x => sha(cleanCode(x))), enrolledAt: FieldValue.serverTimestamp(), fails: 0,
      pending: FieldValue.delete(), pendingCode: FieldValue.delete()
    }, { merge: true });
    // 設定した今のログインは、確認済みとして扱う
    await setClaims(a.uid, { mfa: true, mfaAt: a.token.auth_time });
    logger.info("2 段階認証を設定", { uid: a.uid, method: p.method });
    return { ok: true, backupCodes: codes };
  });

  // ---------- 予備コードの作り直し・解除（本人。コードの確認が必要） ----------
  const mfaRegenerateBackup = onCall({ maxInstances: 5 }, async (req) => {
    const a = requireSession(req);
    const r = ref(a.uid), d = (await r.get()).data();
    if (!d?.method) throw new HttpsError("failed-precondition", "2 段階認証は設定されていません。");
    const codes = backupCodes();
    await r.set({ backup: codes.map(x => sha(cleanCode(x))) }, { merge: true });
    return { backupCodes: codes };
  });

  const mfaDisable = onCall({ maxInstances: 5 }, async (req) => {
    const a = requireSession(req);
    const r = ref(a.uid), d = (await r.get()).data();
    if (!d?.method) return { ok: true };
    checkLock(d);
    if (!checkCode(d, req.data?.code)) await recordFail(r, d);
    await r.delete();
    await setClaims(a.uid, { mfa: undefined, mfaAt: undefined });
    logger.info("2 段階認証を解除（本人）", { uid: a.uid });
    return { ok: true };
  });

  // ---------- オーナーが解除（スマホをなくして予備コードもない場合など） ----------
  const mfaReset = onCall({ maxInstances: 3 }, async (req) => {
    const a = requireSession(req);
    const db = getFirestore();
    if ((await db.doc(`admins/${a.uid}`).get()).get("role") !== "owner") throw new HttpsError("permission-denied", "オーナーのみ実行できます。");
    const uid = req.data?.uid;
    if (typeof uid !== "string" || !uid) throw new HttpsError("invalid-argument", "対象を指定してください。");
    const had = (await ref(uid).get()).exists;
    await ref(uid).delete();
    try { await setClaims(uid, { mfa: undefined, mfaAt: undefined }); }
    catch (e) { if (e.code !== "auth/user-not-found") throw e; }
    logger.info("2 段階認証を解除（オーナー）", { uid, by: a.uid, had });
    return { ok: true, had };
  });

  return { mfaStatus, mfaSendLoginCode, mfaVerify, mfaEnrollStart, mfaEnrollConfirm, mfaRegenerateBackup, mfaDisable, mfaReset };
};

module.exports.sessionOk = sessionOk;
module.exports._test = { b32encode, b32decode, hotp, verifyTotp };
