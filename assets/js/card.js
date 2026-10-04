// ============================================================
//  デジタル会員証（表・裏）とQRコード
//  member.html の会員証画面・ダッシュボードで使います。
//  QRコードには会員証の確認ページ（verify.html）のURLが入ります。
//  ※ QRコードの描画には qrcode-generator（member.html で読み込み）を使います
// ============================================================

const TYPE_LABEL = { regular: "正会員", associate: "準会員", student: "学生会員" };
const TYPE_EN = { regular: "REGULAR MEMBER", associate: "ASSOCIATE MEMBER", student: "STUDENT MEMBER" };

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
  const url = verifyUrl(m);
  const qr = qrSvg(url);
  const type = TYPE_LABEL[m.type] || "";
  const typeEn = TYPE_EN[m.type] || "MEMBER";
  const term = m.validUntil ? { k: "VALID THRU", v: ym(m.validUntil) } : { k: "MEMBER SINCE", v: ym(m.approvedAt) };

  const front = `
      <div class="mcard-face mcard-front">
        <div class="mc-guilloche" aria-hidden="true"></div>
        <img class="mc-watermark" src="LOGO.png" alt="" aria-hidden="true">
        <div class="mc-holo" aria-hidden="true"></div>
        <div class="mc-frame" aria-hidden="true"></div>

        <div class="mc-head">
          <img class="mc-logo" src="LOGO.png" alt="">
          <div class="mc-org">
            <span class="ja">普賢アーカイブ運営委員会</span>
            <span class="en">FUGEN ARCHIVE DEVELOPMENT COMMITTEE</span>
          </div>
          <span class="mc-type">${esc(type)}</span>
        </div>

        <div class="mc-body">
          <div class="mc-info">
            <div class="mc-kicker">${esc(typeEn)}</div>
            <div class="mc-name">${esc(m.name)}</div>
            <div class="mc-kana">${esc(m.kana || "")}</div>
            <dl class="mc-meta">
              <div><dt>MEMBER NO.</dt><dd>${esc(m.memberNo || "—")}</dd></div>
              <div><dt>${term.k}</dt><dd>${esc(term.v)}</dd></div>
            </dl>
          </div>
          <div class="mc-qr">
            <div class="mc-qr-code">${qr || '<span class="mc-qr-wait">準備中</span>'}</div>
            <span class="mc-qr-cap">SCAN TO VERIFY</span>
          </div>
        </div>
      </div>`;

  const back = mini ? "" : `
      <div class="mcard-face mcard-back">
        <div class="mb-band">
          <span>MEMBERSHIP CARD</span>
          <img src="LOGO.png" alt="">
        </div>
        <div class="mb-body">
          <div class="mb-sign">
            <span class="mb-sign-label">会員署名 / SIGNATURE</span>
            <span class="mb-sign-line">${esc(m.name)}</span>
          </div>
          <ul class="mb-terms">
            <li>本カードは、普賢アーカイブ運営委員会の会員であることを証明するものです。</li>
            <li>表面のQRコードから、会員資格の有効性を確認できます。</li>
            <li>本カードは本人のみ使用でき、譲渡・貸与はできません。</li>
          </ul>
          <div class="mb-foot">
            <span>会員番号 ${esc(m.memberNo || "—")}</span>
            <span>発行：普賢アーカイブ運営委員会</span>
          </div>
        </div>
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
    tilt.style.transform = `rotateY(${(x - .5) * 14}deg) rotateX(${(.5 - y) * 14}deg)`;
    card.style.setProperty("--mx", `${x * 100}%`);
    card.style.setProperty("--my", `${y * 100}%`);
    card.classList.add("is-hover");
  });
  card.addEventListener("pointerleave", () => { tilt.style.transform = ""; card.classList.remove("is-hover"); });
}
