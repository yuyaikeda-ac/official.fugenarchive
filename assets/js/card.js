// ============================================================
//  デジタル会員証（表・裏）とQRコード
//  member.html の会員証画面・ダッシュボードで使います。
//  QRコードには会員証の確認ページ（verify.html）のURLが入ります。
//  ※ QRコードの描画には qrcode-generator（member.html で読み込み）を使います
//  ★ デザインは assets/css/member.css の「会員証」で変更できます
// ============================================================

const TYPE_LABEL = { regular: "正会員", associate: "準会員", student: "学生会員" };
const TYPE_EN = { regular: "Regular Member", associate: "Associate Member", student: "Student Member" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toDate = (v) => v?.toDate ? v.toDate() : v ? new Date(v) : null;
const ym = (v) => { const d = toDate(v); return d && !isNaN(d) ? `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}` : "—"; };

/** 確認ページのURL（会員ごとの推測できない番号 cardToken を使う） */
export function verifyUrl(m) {
  return m.cardToken ? `${location.origin}/verify.html?t=${encodeURIComponent(m.cardToken)}` : "";
}

/** QRコード（SVG）。ライブラリが無い・URLが無いときは空文字 */
export function qrSvg(text) {
  if (!text || typeof window.qrcode !== "function") return "";
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

/**
 * 会員証の HTML
 * @param m     会員データ
 * @param opts  { mini: true でダッシュボード用の小さい表示（裏面なし） }
 */
export function memberCardHtml(m, { mini = false } = {}) {
  // 小さい会員証（ダッシュボード）は読み取りにくいので QR コードを出さない
  const qr = mini ? "" : qrSvg(verifyUrl(m));
  const term = m.validUntil ? { k: "Valid thru", v: ym(m.validUntil) } : { k: "Member since", v: ym(m.approvedAt) };

  const front = `
      <div class="mcard-face mcard-front">
        <div class="mc-art">
          <img src="LOGO.png" alt="">
          <div class="mc-art-top">
            <div class="mc-org">
              <span class="ja">普賢アーカイブ運営委員会</span>
              <span class="en">Fugen Archive Development Committee</span>
            </div>
            <span class="mc-type">${esc(TYPE_LABEL[m.type] || "")}</span>
          </div>
        </div>
        <div class="mc-main">
          <div class="mc-info">
            <div class="mc-kicker">Membership Card<i></i>${esc(TYPE_EN[m.type] || "")}</div>
            <div class="mc-name">${esc(m.name)}</div>
            <div class="mc-meta">
              <div><span>Member No.</span><b>${esc(m.memberNo || "—")}</b></div>
              <div><span>${term.k}</span><b>${esc(term.v)}</b></div>
            </div>
          </div>
          ${mini ? "" : `<div class="mc-qr">${qr || '<span class="mc-qr-wait">準備中</span>'}</div>`}
        </div>
        <div class="mc-shine" aria-hidden="true"></div>
      </div>`;

  const back = mini ? "" : `
      <div class="mcard-face mcard-back">
        <div class="mb-body">
          <div class="mb-head">
            <img src="LOGO.png" alt="">
            <div><b>普賢アーカイブ運営委員会</b><span>Fugen Archive Development Committee</span></div>
          </div>
          <div class="mb-sign">
            <span class="mb-sign-line">${esc(m.name)}</span>
            <span class="mb-sign-label">Signature</span>
          </div>
          <ul class="mb-terms">
            <li>本カードは、普賢アーカイブ運営委員会の会員であることを証明するものです。</li>
            <li>表面のQRコードから、会員資格の有効性を確認できます。</li>
            <li>本カードは本人のみ使用でき、譲渡・貸与はできません。</li>
          </ul>
        </div>
        <div class="mb-art"><img src="LOGO.png" alt=""></div>
      </div>`;

  return `<div class="mcard${mini ? " is-mini" : ""}"${mini ? "" : ' id="mcard" tabindex="0" role="button" aria-label="会員証（クリック・Enterで裏面を表示）"'}>
    <div class="mcard-tilt">${front}${back}
    </div>
  </div>`;
}

/** 傾き・光の反射・裏返しの動き */
export function bindCard(card) {
  if (!card) return;
  const tilt = card.querySelector(".mcard-tilt");
  const flip = () => card.classList.toggle("is-flipped");
  card.addEventListener("click", flip);
  card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  card.addEventListener("pointermove", e => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    tilt.style.transform = `rotateY(${(x - .5) * 12}deg) rotateX(${(.5 - y) * 12}deg)`;
    card.style.setProperty("--mx", `${x * 100}%`);
    card.style.setProperty("--my", `${y * 100}%`);
    card.classList.add("is-hover");
  });
  card.addEventListener("pointerleave", () => { tilt.style.transform = ""; card.classList.remove("is-hover"); });
}
