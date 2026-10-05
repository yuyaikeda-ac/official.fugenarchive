// ============================================================
//  電子同意書・電子署名の共通処理
//
//  ■ 改ざん防止の仕組み（3 段階）
//   1. 文書のハッシュ（formHash）
//      公開時に「ID・タイトル・本文・版」を SHA-256 でハッシュ化。公開後は本文を変更できない
//      （firestore.rules）。署名にはこのハッシュ値が記録されるので、どの文面に同意したかが確定する
//   2. 署名記録のハッシュ（recordHash）
//      手書きサインの画像のハッシュ（signatureHash）と、氏名・メール・文書ハッシュ・署名日時などを
//      まとめて SHA-256 でハッシュ化。1 文字でも変われば値が変わる
//   3. サーバーの封印（seal）
//      Cloud Functions が秘密鍵で HMAC-SHA256 の封印を付け、さらに 1 つ前の署名の封印とつなげる
//      （ハッシュチェーン）。途中の記録を消したり書き換えたりすると検証で検出できる
//  ※ 計算方法は functions/consent.js と必ず同じにしてください（stableStringify・各 hash 関数）
// ============================================================
import {
  doc, getDoc, setDoc, addDoc, collection, getDocs, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { app, db, isDemo } from "./db.js";

// ★ 公開署名で追加で入力してもらえる項目（同意書ごとに管理画面で選択）
export const EXTRA_FIELDS = {
  organization: { label: "ご所属（勤務先・学校名など）", max: 200 },
  phone: { label: "電話番号", max: 30 },
  address: { label: "ご住所", max: 300 }
};
export const AUDIENCE_LABEL = { members: "会員のみ", public: "外部の方（URLで署名）", both: "会員と外部の方" };
export const PURPOSE_LABEL = { general: "一般の同意書", membership: "入会時の規約同意" };
export const FORM_STATUS_LABEL = { draft: "下書き", published: "公開中", closed: "受付終了" };
export const SIGNER_LABEL = { member: "会員", public: "外部", applicant: "入会申込者" };

// ---------- ハッシュ ----------
/** キーを並べ替えた JSON（同じ内容なら必ず同じ文字列になる） */
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** SHA-256（16進数 64 文字） */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 文書のハッシュ（公開時に計算して contentHash に保存） */
export const formContentHash = (formId, f) =>
  sha256Hex(stableStringify({ formId, title: f.title || "", bodyHtml: f.bodyHtml || "", version: Number(f.version) || 1 }));

/** 署名記録のハッシュの元になる項目 */
export const recordPayload = (s) => ({
  formId: s.formId, formHash: s.formHash, formVersion: Number(s.formVersion) || 1,
  signerType: s.signerType, uid: s.uid || null, name: s.name, email: s.email,
  extra: s.extra || {}, signatureHash: s.signatureHash, clientSignedAt: s.clientSignedAt
});
export const recordHash = (s) => sha256Hex(stableStringify(recordPayload(s)));

/** 長いハッシュを読みやすく区切る（表示用） */
export const fmtHash = (h) => (h || "").replace(/(.{8})/g, "$1 ").trim();

// ---------- 読み込み ----------
export async function getForm(id) {
  if (isDemo) return null;
  const snap = await getDoc(doc(db, "consent_forms", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** 会員向けに公開中の同意書 */
export async function listMemberForms() {
  const snap = await getDocs(query(collection(db, "consent_forms"), where("status", "==", "published"), where("audience", "in", ["members", "both"])));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** 入会申込で署名してもらう規約（公開中のうち版が最新のもの。無ければ null） */
export async function getMembershipForm() {
  if (isDemo) return null;
  try {
    const snap = await getDocs(query(collection(db, "consent_forms"),
      where("status", "==", "published"), where("purpose", "==", "membership"), where("audience", "in", ["public", "both"])));
    const forms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    forms.sort((a, b) => (b.publishedAt?.toMillis?.() || 0) - (a.publishedAt?.toMillis?.() || 0));
    return forms[0] || null;
  } catch (e) { console.error(e); return null; }
}

/** 自分の署名（会員サイト用） */
export async function listMySignatures(uid) {
  const snap = await getDocs(query(collection(db, "consent_signatures"), where("uid", "==", uid)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---------- 署名 ----------
/**
 * 署名を保存する
 * @param form   同意書（getForm の戻り値）
 * @param signer { signerType: "member"|"public"|"applicant", uid?, name, email, extra? }
 * @param signatureImage  手書きサインの PNG（data URL）
 * @returns 保存した記録（id・recordHash など。控えの表示に使う）
 */
export async function submitSignature(form, signer, signatureImage) {
  if (isDemo) throw new Error("デモモードでは署名できません。");
  if (form.status !== "published") throw new Error("この同意書は現在受け付けていません。");
  // 公開時のハッシュと、今読み込んだ文面のハッシュが一致することを確認（念のため）
  const nowHash = await formContentHash(form.id, form);
  if (nowHash !== form.contentHash) throw new Error("同意書の内容を確認できませんでした（ハッシュ不一致）。ページを再読み込みしてください。");

  const rec = {
    formId: form.id, formTitle: form.title, formVersion: Number(form.version) || 1, formHash: form.contentHash,
    signerType: signer.signerType, uid: signer.uid || null,
    name: signer.name.trim(), email: signer.email.trim().toLowerCase(), extra: signer.extra || {},
    signatureImage, signatureHash: await sha256Hex(signatureImage),
    clientSignedAt: new Date().toISOString(),
    userAgent: navigator.userAgent.slice(0, 300)
  };
  rec.recordHash = await recordHash(rec);
  const data = { ...rec, agreedAt: serverTimestamp() };
  // 会員・入会申込者は 1 つの同意書に 1 回だけ（ID = 同意書ID_UID）
  let id;
  if (rec.uid) { id = `${form.id}_${rec.uid}`; await setDoc(doc(db, "consent_signatures", id), data); }
  else id = (await addDoc(collection(db, "consent_signatures"), data)).id;
  return { id, ...rec };
}

// ---------- 検証（Cloud Functions） ----------
/**
 * 署名の検証。管理者は id だけで詳細を、それ以外は id と recordHash（控えの値）で結果を取得
 * @returns { ok, checks: [{ label, ok, detail }], summary }
 */
export async function verifySignature(id, hash = "") {
  const fn = httpsCallable(getFunctions(app, "asia-northeast1"), "verifyConsent");
  return (await fn({ id, hash })).data;
}
/** すべての署名のハッシュチェーンを検証（管理者のみ） */
export async function verifyChain() {
  const fn = httpsCallable(getFunctions(app, "asia-northeast1"), "verifyConsent");
  return (await fn({ mode: "chain" })).data;
}

// ============================================================
//  手書きサインの入力欄
//  const pad = new SignaturePad(canvas);  pad.isEmpty() / pad.clear() / pad.undo() / pad.toDataURL()
//  ・マウス・指・ペンに対応。筆圧（ペン）と速さで線の太さが変わります
// ============================================================
export class SignaturePad {
  constructor(canvas, { color = "#14233a", onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = color;
    this.onChange = onChange;
    this.strokes = [];
    this.resize = this.resize.bind(this);
    this.resize();
    new ResizeObserver(this.resize).observe(canvas);
    canvas.style.touchAction = "none";
    let cur = null;
    // スマホで署名中にページの文字が選択されたり（青い範囲）、長押しメニュー・拡大鏡が出たりしないようにする
    const stop = e => e.preventDefault();
    canvas.addEventListener("touchstart", stop, { passive: false });
    canvas.addEventListener("touchmove", stop, { passive: false });
    canvas.addEventListener("contextmenu", stop);
    canvas.addEventListener("selectstart", stop);
    document.addEventListener("selectstart", e => { if (cur) e.preventDefault(); });
    canvas.addEventListener("pointerdown", e => {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      canvas.setPointerCapture(e.pointerId);
      cur = [this.point(e)];
      this.strokes.push(cur);
      this.draw();
    });
    canvas.addEventListener("pointermove", e => {
      if (!cur) return;
      const list = e.getCoalescedEvents?.();
      for (const ev of list?.length ? list : [e]) cur.push(this.point(ev));
      this.draw();
    });
    const end = () => { if (cur) { cur = null; this.onChange?.(); } };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }
  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, p: e.pointerType === "pen" && e.pressure ? e.pressure : 0.5, t: e.timeStamp };
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.draw();
  }
  draw(ctx = this.ctx, w = this.canvas.width, h = this.canvas.height) {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = ctx.fillStyle = this.color;
    const base = Math.max(1.6, w / 260);
    for (const s of this.strokes) {
      if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x * w, s[0].y * h, base * 0.8, 0, Math.PI * 2); ctx.fill(); continue; }
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1], b = s[i];
        const dist = Math.hypot((b.x - a.x) * w, (b.y - a.y) * h), dt = Math.max(1, b.t - a.t);
        const speed = Math.min(1, dist / dt / 3);
        ctx.lineWidth = base * (0.7 + b.p) * (1.25 - speed * 0.6);
        ctx.beginPath();
        const m0 = i > 1 ? { x: (s[i - 2].x + a.x) / 2, y: (s[i - 2].y + a.y) / 2 } : a;
        const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        ctx.moveTo(m0.x * w, m0.y * h);
        ctx.quadraticCurveTo(a.x * w, a.y * h, m1.x * w, m1.y * h);
        ctx.stroke();
      }
    }
  }
  /** 線（3 点以上）が 1 本も無ければ空とみなす（点を打っただけの署名は不可） */
  isEmpty() { return !this.strokes.some(s => s.length > 2); }
  clear() { this.strokes = []; this.draw(); this.onChange?.(); }
  undo() { this.strokes.pop(); this.draw(); this.onChange?.(); }
  /** 余白を切り取った PNG（幅 最大 600px）の data URL */
  toDataURL() {
    const W = 600, H = Math.round(600 * this.canvas.height / this.canvas.width);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    this.draw(c.getContext("2d"), W, H);
    const pts = this.strokes.flat();
    const pad = 12;
    const x0 = Math.max(0, Math.min(...pts.map(p => p.x)) * W - pad), x1 = Math.min(W, Math.max(...pts.map(p => p.x)) * W + pad);
    const y0 = Math.max(0, Math.min(...pts.map(p => p.y)) * H - pad), y1 = Math.min(H, Math.max(...pts.map(p => p.y)) * H + pad);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(x1 - x0)); out.height = Math.max(1, Math.round(y1 - y0));
    out.getContext("2d").drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }
}
