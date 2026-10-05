// ============================================================
//  2 段階認証の画面（管理画面・会員サイトで共通。サーバー側は functions/mfa.js）
//  ・mfaGate(user)      … ログイン直後に呼ぶ。設定している人にはコードの入力画面を出し、確認できたら true
//  ・openMfaSettings()  … 本人の設定画面（認証アプリ／メールを選んで設定・予備コード・解除）
//  ・mfaReset(uid)      … オーナーが、ほかの人の 2 段階認証を解除する
//  画面は <dialog> で出す（どちらのページの CSS にも依存しないよう、スタイルはここに持つ）
// ============================================================
import { app, auth, esc } from "./db.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const call = (name, data) => httpsCallable(getFunctions(app, "asia-northeast1"), name)(data).then(r => r.data);
const errText = (e) => String(e?.message || e).replace(/^Firebase:\s*/, "");
const METHOD_LABEL = { totp: "認証アプリ", email: "メール" };

// ---------- 見た目 ----------
const CSS = `
.mfa-dlg { width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; border: 0; border-radius: 16px; box-shadow: 0 24px 60px -16px rgba(0,0,0,.45); color: #1f2937; background: #fff; font: 14px/1.75 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
.mfa-dlg::backdrop { background: rgba(10,20,40,.55); }
.mfa-in { padding: 22px 22px 20px; overflow-y: auto; max-height: calc(100dvh - 32px); box-sizing: border-box; }
.mfa-in h2 { margin: 0 0 6px; font-size: 18px; color: #0f2a4f; }
.mfa-in p { margin: 0 0 12px; }
.mfa-muted { color: #64748b; font-size: 13px; }
.mfa-code { display: block; width: 100%; box-sizing: border-box; margin: 6px 0 10px; padding: 12px 14px; border: 1px solid #cbd5e1; border-radius: 10px; font: 600 22px/1.2 ui-monospace, Consolas, monospace !important; letter-spacing: .18em; text-align: center; }
.mfa-code:focus { outline: 2px solid #2563eb; outline-offset: 1px; }
.mfa-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.mfa-row > .mfa-btn { flex: 1 1 140px; }
.mfa-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 0 16px; border: 1px solid #cbd5e1; border-radius: 10px; background: #fff; color: #0f2a4f; font: 600 14px/1.2 inherit; cursor: pointer; }
.mfa-btn.primary { background: #0f2a4f; border-color: #0f2a4f; color: #fff; }
.mfa-btn.danger { color: #b42318; border-color: #f0c8c3; }
.mfa-btn:disabled { opacity: .6; cursor: default; }
.mfa-link { padding: 0; border: 0; background: none; color: #2563eb; font: inherit; text-decoration: underline; cursor: pointer; }
.mfa-msg { margin: 8px 0 0; padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.mfa-msg:empty { display: none; }
.mfa-msg.error { background: #fdecec; color: #9b1c1c; }
.mfa-msg.ok { background: #e9f7ee; color: #1e6b3a; }
.mfa-choice { display: grid; gap: 10px; margin: 12px 0 4px; }
.mfa-choice button { display: block; width: 100%; padding: 14px 16px; border: 1px solid #cbd5e1; border-radius: 12px; background: #f8fafc; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.mfa-choice button:hover { border-color: #0f2a4f; background: #f1f5fb; }
.mfa-choice b { display: block; color: #0f2a4f; font-size: 15px; }
.mfa-choice span { color: #64748b; font-size: 12.5px; }
.mfa-qr { width: 190px; height: 190px; margin: 6px auto 10px; padding: 8px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; }
.mfa-qr svg { display: block; width: 100%; height: 100%; }
.mfa-secret { display: block; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; background: #f1f5f9; font: 13px ui-monospace, Consolas, monospace; word-break: break-all; text-align: center; user-select: all; }
.mfa-backup { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 12px; margin: 10px 0; padding: 12px 14px; border-radius: 10px; background: #f8fafc; border: 1px dashed #94a3b8; font: 15px ui-monospace, Consolas, monospace; text-align: center; }
.mfa-status { padding: 12px 14px; border-radius: 10px; background: #e9f7ee; color: #1e6b3a; margin-bottom: 12px; }
.mfa-status.off { background: #f1f5f9; color: #475569; }
.mfa-steps { margin: 0 0 10px; padding-left: 20px; font-size: 13.5px; }
`;
function ensureStyle() {
  if (document.getElementById("mfa-style")) return;
  const s = document.createElement("style");
  s.id = "mfa-style"; s.textContent = CSS;
  document.head.appendChild(s);
}
/** ダイアログを開く（中身は render で差し替え）。Esc では閉じない（ログイン時の確認を飛ばせないように） */
function dialog({ closable = true } = {}) {
  ensureStyle();
  const d = document.createElement("dialog");
  d.className = "mfa-dlg";
  d.innerHTML = '<div class="mfa-in"></div>';
  d.addEventListener("cancel", (e) => { if (!closable) e.preventDefault(); });
  d.addEventListener("close", () => d.remove());
  document.body.appendChild(d);
  d.showModal();
  const box = d.querySelector(".mfa-in");
  return {
    d, box,
    render(html) { box.innerHTML = html; const f = box.querySelector(".mfa-code"); if (f) setTimeout(() => f.focus(), 50); },
    msg(text, type = "error") { const m = box.querySelector(".mfa-msg"); if (m) { m.className = `mfa-msg ${text ? type : ""}`; m.textContent = text || ""; } },
    $: (sel) => box.querySelector(sel)
  };
}
const codeInput = (ph = "6 桁のコード") =>
  `<input class="mfa-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="${ph}" aria-label="確認コード">`;
async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}
let qrLoading = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve();
  return qrLoading ??= new Promise((ok, ng) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
    s.onload = ok; s.onerror = () => { qrLoading = null; ng(new Error("QR コードを表示できませんでした")); };
    document.head.appendChild(s);
  });
}

// ============================================================
//  ログイン直後の確認
// ============================================================
/** このログインで確認が必要か（トークンを最新にして判定） */
export async function mfaNeeded(user) {
  const r = await user.getIdTokenResult(true);
  return r.claims.mfa === true && Number(r.claims.mfaAt) !== Number(r.claims.auth_time);
}

/** 設定している人にはコードの入力画面を出す。確認できたら true、ログアウトを選んだら false */
export async function mfaGate(user, { onLogout } = {}) {
  if (!user || !(await mfaNeeded(user))) return true;
  let st;
  try { st = await call("mfaStatus"); } catch (e) { console.error(e); st = { method: "" }; }
  return new Promise((resolve0) => {
    const ui = dialog({ closable: false });
    // 確認せずに閉じられた（ブラウザの操作など）ときは、ログアウトする
    let done = false;
    const resolve = (v) => { done = true; resolve0(v); };
    ui.d.addEventListener("close", () => { if (!done) { done = true; Promise.resolve(onLogout ? onLogout() : auth.signOut()).finally(() => resolve0(false)); } });
    const isMail = st.method === "email";
    ui.render(`
      <h2>2 段階認証</h2>
      ${isMail
        ? `<p>登録したメールアドレス（<b class="mfa-to">${esc(st.email || "")}</b>）に届いた 6 桁のコードを入力してください。</p>`
        : `<p>認証アプリ（Google Authenticator など）に表示されている 6 桁のコードを入力してください。</p>`}
      <form class="mfa-form">${codeInput()}
        <p class="mfa-muted">スマホをなくした・メールが届かないときは、設定時に控えた予備コード（例：1a2b3-c4d5e）も使えます。</p>
        <div class="mfa-msg"></div>
        <div class="mfa-row"><button type="submit" class="mfa-btn primary">確認する</button></div>
      </form>
      <div class="mfa-row">
        ${isMail ? '<button type="button" class="mfa-btn mfa-resend">コードを送り直す</button>' : ""}
        <button type="button" class="mfa-btn mfa-out">ログアウト</button>
      </div>`);
    const send = async (btn) => {
      try {
        const r = await call("mfaSendLoginCode");
        ui.msg(`${r.email} にコードを送信しました（迷惑メールフォルダもご確認ください）。`, "ok");
      } catch (e) { ui.msg(errText(e)); }
      if (btn) { btn.disabled = true; setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, 60_000); }
    };
    if (isMail) { send(ui.$(".mfa-resend")); ui.$(".mfa-resend").addEventListener("click", (e) => send(e.currentTarget)); }
    ui.$(".mfa-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = ui.$(".mfa-code").value.trim();
      if (!code) return ui.msg("コードを入力してください。");
      await busy(e.submitter || ui.$(".mfa-form .primary"), "確認中…", async () => {
        try {
          const r = await call("mfaVerify", { code });
          await user.getIdToken(true);
          done = true;
          ui.d.close();
          if (r.backupLeft !== undefined && r.backupLeft <= 3) {
            setTimeout(() => alertBox(`予備コードを使いました。残りは ${r.backupLeft} 個です。設定画面で予備コードを作り直してください。`), 300);
          }
          resolve(true);
        } catch (err) { ui.msg(errText(err)); ui.$(".mfa-code").select(); }
      });
    });
    ui.$(".mfa-out").addEventListener("click", () => ui.d.close());
  });
}
function alertBox(text) {
  const ui = dialog();
  ui.render(`<h2>お知らせ</h2><p>${esc(text)}</p><div class="mfa-row"><button class="mfa-btn primary mfa-ok">閉じる</button></div>`);
  ui.$(".mfa-ok").addEventListener("click", () => ui.d.close());
}

// ============================================================
//  本人の設定
// ============================================================
/** 本人の設定の状態（設定画面の外に表示する用） */
export const getMfaStatus = () => call("mfaStatus");
export const MFA_METHOD_LABEL = METHOD_LABEL;

/** 本人の設定画面。onClose は画面を閉じたときに呼ぶ（状態の表示を更新するため） */
export async function openMfaSettings({ onClose } = {}) {
  const ui = dialog();
  if (onClose) ui.d.addEventListener("close", onClose);
  ui.render('<p class="mfa-muted">読み込み中…</p>');
  const user = auth.currentUser;
  const close = '<button type="button" class="mfa-btn mfa-close">閉じる</button>';
  ui.box.addEventListener("click", (e) => { if (e.target.closest(".mfa-close")) ui.d.close(); });

  const showStatus = async () => {
    let st;
    try { st = await call("mfaStatus"); } catch (e) { return ui.render(`<h2>2 段階認証</h2><div class="mfa-msg error">${esc(errText(e))}</div><div class="mfa-row">${close}</div>`); }
    if (!st.enabled) {
      ui.render(`
        <h2>2 段階認証</h2>
        <div class="mfa-status off">まだ設定していません。</div>
        <p>ログインのとき、パスワード（または Google）に加えて 6 桁のコードを入力するようにします。パスワードが他人に知られても、ログインされにくくなります。</p>
        <p><b>方式を選んでください</b></p>
        <div class="mfa-choice">
          <button type="button" data-m="totp"><b>認証アプリ（おすすめ）</b><span>Google Authenticator・Microsoft Authenticator などのアプリに表示されるコードを入力します。電波がなくても使えます。</span></button>
          <button type="button" data-m="email"><b>メール</b><span>ログインのたびに、${st.accountEmail ? esc(st.accountEmail) : "登録したメールアドレス"} にコードを送ります。アプリの準備がいりません。</span></button>
        </div>
        <div class="mfa-msg"></div>
        <div class="mfa-row">${close}</div>`);
      ui.box.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => enroll(b.dataset.m, b)));
      return;
    }
    ui.render(`
      <h2>2 段階認証</h2>
      <div class="mfa-status"><b>設定済み：${METHOD_LABEL[st.method] || st.method}</b>${st.email ? `（${esc(st.email)}）` : ""}<br>予備コードの残り：${st.backupLeft} 個</div>
      <div class="mfa-row">
        <button type="button" class="mfa-btn mfa-regen">予備コードを作り直す</button>
        <button type="button" class="mfa-btn danger mfa-off">解除する</button>
      </div>
      <p class="mfa-muted" style="margin-top:12px">方式を変えるときは、いったん解除してから設定し直してください。</p>
      <div class="mfa-msg"></div>
      <div class="mfa-row">${close}</div>`);
    ui.$(".mfa-regen").addEventListener("click", async (e) => {
      if (!window.confirm("予備コードを作り直します。これまでの予備コードは使えなくなります。よろしいですか？")) return;
      await busy(e.currentTarget, "作成中…", async () => {
        try { showBackup((await call("mfaRegenerateBackup")).backupCodes, "新しい予備コード"); } catch (err) { ui.msg(errText(err)); }
      });
    });
    ui.$(".mfa-off").addEventListener("click", () => disable(st));
  };

  const enroll = async (method, btn) => {
    await busy(btn, "準備中…", async () => {
      let r;
      try { r = await call("mfaEnrollStart", { method }); } catch (e) { return ui.msg(errText(e)); }
      if (method === "totp") {
        ui.render(`
          <h2>認証アプリで設定</h2>
          <ol class="mfa-steps">
            <li>スマホに認証アプリ（Google Authenticator など）を入れます</li>
            <li>アプリで「＋」→「QR コードをスキャン」を選び、下の QR コードを読み取ります（このスマホで設定するときは、下の英数字を「セットアップキー」として入力）</li>
            <li>アプリに表示された 6 桁のコードを入力します</li>
          </ol>
          <div class="mfa-qr"></div>
          <code class="mfa-secret">${esc(r.secret.replace(/(.{4})/g, "$1 ").trim())}</code>
          <form class="mfa-form">${codeInput()}<div class="mfa-msg"></div>
            <div class="mfa-row"><button type="submit" class="mfa-btn primary">設定する</button></div></form>
          <div class="mfa-row">${close}</div>`);
        loadQr().then(() => {
          const qr = window.qrcode(0, "M"); qr.addData(r.uri); qr.make();
          ui.$(".mfa-qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
        }).catch(e => { ui.$(".mfa-qr").remove(); ui.msg(errText(e) + "。英数字を入力して設定してください。"); });
      } else {
        ui.render(`
          <h2>メールで設定</h2>
          <p><b>${esc(r.email)}</b> に確認コードを送りました。届いた 6 桁のコードを入力してください（迷惑メールフォルダもご確認ください）。</p>
          <form class="mfa-form">${codeInput()}<div class="mfa-msg"></div>
            <div class="mfa-row"><button type="submit" class="mfa-btn primary">設定する</button></div></form>
          <div class="mfa-row">${close}</div>`);
      }
      ui.$(".mfa-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = ui.$(".mfa-code").value.trim();
        if (!code) return ui.msg("コードを入力してください。");
        await busy(ui.$(".mfa-form .primary"), "確認中…", async () => {
          try {
            const res = await call("mfaEnrollConfirm", { code });
            await user.getIdToken(true);
            showBackup(res.backupCodes, "設定しました");
          } catch (err) { ui.msg(errText(err)); }
        });
      });
    });
  };

  const showBackup = (codes, title) => {
    ui.render(`
      <h2>${esc(title)}</h2>
      <p><b>予備コードを控えてください。</b>スマホをなくした・メールが届かないときに、コードの代わりに使えます（1 つにつき 1 回）。この画面を閉じると、もう表示できません。</p>
      <div class="mfa-backup">${codes.map(c => `<span>${esc(c)}</span>`).join("")}</div>
      <div class="mfa-row">
        <button type="button" class="mfa-btn mfa-copy">コピー</button>
        <button type="button" class="mfa-btn mfa-dl">ファイルに保存</button>
      </div>
      <div class="mfa-msg"></div>
      <div class="mfa-row"><button type="button" class="mfa-btn primary mfa-done">控えました</button></div>`);
    const text = `普賢アーカイブ 2 段階認証の予備コード（${new Date().toLocaleDateString("ja-JP")} 作成・各 1 回のみ）\n\n${codes.join("\n")}\n`;
    ui.$(".mfa-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(text); ui.msg("コピーしました。", "ok"); } catch { ui.msg("コピーできませんでした。書き写してください。"); }
    });
    ui.$(".mfa-dl").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = "fugen-archive-backup-codes.txt"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    ui.$(".mfa-done").addEventListener("click", showStatus);
  };

  const disable = (st) => {
    const isMail = st.method === "email";
    ui.render(`
      <h2>2 段階認証を解除</h2>
      <p>${isMail ? "「コードを送る」を押し、メールに届いた 6 桁のコードを" : "認証アプリの 6 桁のコードを"}入力してください（予備コードも使えます）。</p>
      ${isMail ? '<div class="mfa-row"><button type="button" class="mfa-btn mfa-send">コードを送る</button></div>' : ""}
      <form class="mfa-form">${codeInput()}<div class="mfa-msg"></div>
        <div class="mfa-row"><button type="button" class="mfa-btn mfa-back">戻る</button><button type="submit" class="mfa-btn danger">解除する</button></div></form>`);
    ui.$(".mfa-back").addEventListener("click", showStatus);
    ui.$(".mfa-send")?.addEventListener("click", async (e) => {
      const b = e.currentTarget;
      try { const r = await call("mfaSendLoginCode"); ui.msg(`${r.email} にコードを送信しました。`, "ok"); b.disabled = true; setTimeout(() => { if (b.isConnected) b.disabled = false; }, 60_000); }
      catch (err) { ui.msg(errText(err)); }
    });
    ui.$(".mfa-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = ui.$(".mfa-code").value.trim();
      if (!code) return ui.msg("コードを入力してください。");
      await busy(ui.$(".mfa-form .danger"), "解除中…", async () => {
        try { await call("mfaDisable", { code }); await user.getIdToken(true); await showStatus(); ui.msg("2 段階認証を解除しました。", "ok"); }
        catch (err) { ui.msg(errText(err)); }
      });
    });
  };

  await showStatus();
}

// ============================================================
//  オーナーが解除
// ============================================================
export const mfaReset = (uid) => call("mfaReset", { uid });
