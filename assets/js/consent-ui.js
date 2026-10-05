// ============================================================
//  電子同意書の画面パーツ（署名ページ sign.html・会員サイト・入会申込で共通）
//   docBoxHtml / fillDoc … 同意書の本文（タイトル・版・文書のハッシュ値つき）
//   padHtml / mountPad   … 手書きの署名欄
//   signFormHtml / bindSignForm … 氏名・メール・同意・署名の入力と送信
//   receiptHtml / printReceipt  … 署名の控え（画面表示・印刷）
//  ※ ハッシュ計算・保存は consent-core.js、見た目は member.css の「電子同意書」
// ============================================================
import { SignaturePad, submitSignature, fmtHash, EXTRA_FIELDS } from "./consent-core.js";
import { renderRich } from "./rich-view.js";
import { esc } from "./db.js";

const toDate = (v) => v?.toDate ? v.toDate() : v ? new Date(v) : null;
export const fmtDateTime = (v) => {
  const d = toDate(v);
  return d && !isNaN(d) ? d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
};
const todayStr = () => new Date().toISOString().slice(0, 10);
/** 署名期限を過ぎているか（deadline: "YYYY-MM-DD"） */
export const isPastDeadline = (form) => !!form?.deadline && form.deadline < todayStr();

/** 署名の確認ページの URL */
export const verifyPageUrl = (id, hash) => `${location.origin}/consent-verify.html?id=${encodeURIComponent(id)}&h=${encodeURIComponent(hash)}`;

/** 署名を保存できなかったときのメッセージ */
export function signErrorMessage(e) {
  if (e?.code === "permission-denied") return "署名を保存できませんでした。受付が終了している可能性があります。";
  if (e?.code === "unavailable" || e?.code === "auth/network-request-failed") return "通信できませんでした。通信環境をご確認のうえ、もう一度お試しください。";
  return e?.message || "署名を保存できませんでした。";
}

// ---------- 同意書の本文 ----------
export function docBoxHtml(form, { scroll = false } = {}) {
  return `<section class="cdoc">
    <header class="cdoc-head">
      <p class="eyebrow">Consent Form</p>
      <h2>${esc(form.title)}</h2>
      <div class="cdoc-meta">
        <span>第 ${esc(form.version || 1)} 版</span>
        ${form.publishedAt ? `<span>公開日 ${esc(fmtDateTime(form.publishedAt).slice(0, 10))}</span>` : ""}
        ${form.deadline ? `<span class="${isPastDeadline(form) ? "is-late" : ""}">署名期限 ${esc(form.deadline.replace(/-/g, "."))}</span>` : ""}
      </div>
    </header>
    <div class="cdoc-body${scroll ? " is-scroll" : ""}" data-cdoc-body tabindex="0" aria-label="同意書の本文"></div>
    <div class="cdoc-hash"><span>文書のハッシュ値（SHA-256）</span><code>${esc(fmtHash(form.contentHash))}</code></div>
  </section>`;
}
export const fillDoc = (root, form) => renderRich(root.querySelector("[data-cdoc-body]"), form);

// ---------- 署名欄 ----------
export function padHtml() {
  return `<div class="sigpad" data-sigpad>
    <canvas aria-label="署名欄（指・マウス・ペンで署名）"></canvas>
    <span class="sigpad-ph" aria-hidden="true">ここに署名してください</span>
    <span class="sigpad-line" aria-hidden="true"></span>
    <div class="sigpad-tools">
      <button type="button" data-sig-undo>1つ戻す</button>
      <button type="button" data-sig-clear>消す</button>
    </div>
  </div>`;
}
/** 署名欄を動かす。描くと .is-drawn が付き、案内文が消える */
export function mountPad(root, onChange) {
  const box = root.querySelector("[data-sigpad]");
  const pad = new SignaturePad(box.querySelector("canvas"), {
    onChange: () => { box.classList.toggle("is-drawn", !pad.isEmpty()); onChange?.(pad); }
  });
  box.querySelector("canvas").addEventListener("pointerdown", () => box.classList.add("is-drawn"));
  box.querySelector("[data-sig-undo]").addEventListener("click", () => pad.undo());
  box.querySelector("[data-sig-clear]").addEventListener("click", () => pad.clear());
  return pad;
}

// ---------- 署名フォーム ----------
/**
 * @param form  同意書
 * @param mode  "public"（外部の方）| "member"（会員：氏名・メールは登録内容で固定）
 * @param member 会員データ（mode が member のとき）
 */
export function signFormHtml(form, { mode = "public", member = null } = {}) {
  const fixed = mode === "member";
  const extras = fixed ? [] : (form.extraFields || []).filter(k => EXTRA_FIELDS[k]);
  return `<form class="sign-form" novalidate>
    <h3 class="sign-title">署名者の情報</h3>
    <div class="grid-2">
      <div class="field"><label for="sg-name">お名前<span class="req">必須</span></label>
        <input id="sg-name" name="name" autocomplete="name" maxlength="100" required value="${esc(member?.name || "")}"${fixed ? " readonly" : ""}>
        <p class="err">お名前を入力してください</p></div>
      <div class="field"><label for="sg-email">メールアドレス<span class="req">必須</span></label>
        <input id="sg-email" name="email" type="email" autocomplete="email" maxlength="200" required value="${esc(member?.email || "")}"${fixed ? " readonly" : ""}>
        <p class="hint">署名の控えをお送りします</p><p class="err">正しいメールアドレスを入力してください</p></div>
    </div>
    ${fixed ? "" : `<div class="field"><label for="sg-email2">メールアドレス（確認）<span class="req">必須</span></label>
        <input id="sg-email2" name="email2" type="email" autocomplete="off" maxlength="200" required>
        <p class="err">メールアドレスが一致しません</p></div>`}
    ${extras.length ? `<div class="grid-2">${extras.map(k => `<div class="field"><label for="sg-${k}">${esc(EXTRA_FIELDS[k].label)}<span class="req">必須</span></label>
        <input id="sg-${k}" name="x-${k}" maxlength="${EXTRA_FIELDS[k].max}" required${k === "phone" ? ' type="tel" autocomplete="tel"' : k === "address" ? ' autocomplete="street-address"' : ' autocomplete="organization"'}>
        <p class="err">入力してください</p></div>`).join("")}</div>` : ""}
    <div class="field sign-field">
      <label>署名<span class="req">必須</span></label>
      ${padHtml()}
      <p class="hint">枠の中に、指・マウス・ペンでお名前を手書きしてください。</p>
      <p class="err">署名欄に署名してください</p>
    </div>
    <div class="field"><label class="check"><input type="checkbox" name="agree" required> <span>上記の内容を確認し、同意します</span></label><p class="err">同意が必要です</p></div>
    <div class="sign-alert"></div>
    <button class="lux-btn sign-submit" type="submit">同意して署名する</button>
    <p class="sign-fine">「同意して署名する」を押すと、署名の内容から計算したハッシュ値（SHA-256）とともに記録され、後から変更・削除できない形で保存されます。</p>
  </form>`;
}

/**
 * 署名フォームの入力チェックと送信
 * @param onDone  保存できたら呼ばれる（引数：保存した記録）
 */
export function bindSignForm(root, form, { mode = "public", member = null, onDone } = {}) {
  const f = root.querySelector(".sign-form");
  const E = f.elements;
  const sigField = f.querySelector(".sign-field");
  const pad = mountPad(f, p => { if (sigField.classList.contains("is-invalid")) sigField.classList.toggle("is-invalid", p.isEmpty()); });
  const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  const rules = {
    name: el => el.value.trim().length > 0,
    email: el => emailOk(el.value),
    email2: el => el.value.trim().toLowerCase() === E.email.value.trim().toLowerCase() && el.value.trim() !== "",
    agree: el => el.checked
  };
  const check = (el) => {
    const rule = el.name.startsWith("x-") ? (x => x.value.trim().length > 0) : rules[el.name];
    if (!rule) return true;
    const ok = rule(el);
    el.closest(".field")?.classList.toggle("is-invalid", !ok);
    return ok;
  };
  f.addEventListener("input", e => { if (e.target.closest(".field")?.classList.contains("is-invalid")) check(e.target); });
  f.addEventListener("focusout", e => { if (e.target.value && e.target.type !== "checkbox") check(e.target); });

  let busy = false;
  const btn = f.querySelector(".sign-submit");
  f.addEventListener("submit", async e => {
    e.preventDefault();
    if (busy) return;
    const els = [...f.querySelectorAll("input")].filter(el => !el.readOnly || el.name === "name" || el.name === "email");
    const results = els.map(check);
    const padOk = !pad.isEmpty();
    sigField.classList.toggle("is-invalid", !padOk);
    const firstBad = els[results.indexOf(false)];
    if (firstBad || !padOk) {
      (firstBad || sigField).scrollIntoView({ behavior: "smooth", block: "center" });
      firstBad?.focus({ preventScroll: true });
      return;
    }
    busy = true; btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 署名を記録しています…';
    f.querySelector(".sign-alert").innerHTML = "";
    try {
      const extra = {};
      [...f.querySelectorAll('input[name^="x-"]')].forEach(el => { extra[el.name.slice(2)] = el.value.trim(); });
      const rec = await submitSignature(form, {
        signerType: mode, uid: mode === "member" ? member.id : null,
        name: E.name.value, email: E.email.value, extra
      }, pad.toDataURL());
      onDone?.(rec);
    } catch (err) {
      console.error(err);
      f.querySelector(".sign-alert").innerHTML = `<div class="alert error">${esc(signErrorMessage(err))}</div>`;
      busy = false; btn.disabled = false; btn.textContent = "同意して署名する";
    }
  });
  return pad;
}

// ---------- 控え ----------
/**
 * @param rec  署名の記録（submitSignature の戻り値、または consent_signatures の文書）
 *             { id, formTitle, formVersion, formHash, name, email, clientSignedAt|agreedAt, recordHash, signatureImage, seal? }
 */
export function receiptHtml(rec, { print = false } = {}) {
  const signedAt = rec.agreedAt || rec.clientSignedAt;
  return `<section class="receipt${print ? " is-print" : ""}">
    <div class="receipt-head">
      <img src="LOGO.png" alt="">
      <div><b>普賢アーカイブ運営委員会</b><span>電子同意書　署名の控え</span></div>
      <span class="receipt-ok">✓ 署名済み</span>
    </div>
    <dl class="receipt-list">
      <div><dt>同意書</dt><dd>${esc(rec.formTitle)}（第 ${esc(rec.formVersion || 1)} 版）</dd></div>
      <div><dt>署名者</dt><dd>${esc(rec.name)} 様</dd></div>
      <div><dt>メールアドレス</dt><dd>${esc(rec.email)}</dd></div>
      <div><dt>署名日時</dt><dd>${esc(fmtDateTime(signedAt))}</dd></div>
      <div><dt>署名ID</dt><dd><code>${esc(rec.id)}</code></dd></div>
      <div><dt>記録のハッシュ値</dt><dd><code>${esc(fmtHash(rec.recordHash))}</code></dd></div>
      <div><dt>文書のハッシュ値</dt><dd><code>${esc(fmtHash(rec.formHash))}</code></dd></div>
      ${rec.seal ? `<div><dt>サーバーの封印</dt><dd><code>${esc(fmtHash(rec.seal))}</code>${rec.seq ? `<small>（通し番号 ${esc(rec.seq)}）</small>` : ""}</dd></div>` : ""}
    </dl>
    ${rec.signatureImage ? `<figure class="receipt-sig"><img src="${esc(rec.signatureImage)}" alt="署名"><figcaption>署名</figcaption></figure>` : ""}
    <p class="receipt-note">ハッシュ値は署名の内容から計算した固有の値です。記録が 1 文字でも書き換えられると値が変わるため、
      確認ページで照合すると改ざんされていないことを確かめられます。${print ? `<br>確認ページ：${esc(verifyPageUrl(rec.id, rec.recordHash))}` : "控えはメールでもお送りします（届くまで数分かかる場合があります）。"}</p>
    ${print ? "" : `<div class="receipt-actions">
      <button type="button" class="lux-btn ghost sm" data-print-receipt>控えを印刷</button>
      <a class="lux-btn ghost sm" href="${esc(verifyPageUrl(rec.id, rec.recordHash))}" target="_blank" rel="noopener">この署名を検証する ↗</a>
    </div>`}
  </section>`;
}

/** 控えを印刷（#print-sheet を作って印刷し、終わったら消す。member.css の印刷設定を使用） */
export function printReceipt(rec) {
  document.getElementById("print-sheet")?.remove();
  const sheet = document.createElement("div");
  sheet.id = "print-sheet";
  sheet.innerHTML = receiptHtml(rec, { print: true });
  document.body.appendChild(sheet);
  addEventListener("afterprint", () => sheet.remove(), { once: true });
  Promise.all([...sheet.querySelectorAll("img")].map(img => img.decode().catch(() => {}))).then(() => window.print());
}
/** 控えの「印刷」ボタンを有効にする */
export function bindReceipt(root, rec) {
  root.querySelector("[data-print-receipt]")?.addEventListener("click", () => printReceipt(rec));
}
