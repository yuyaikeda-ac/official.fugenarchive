// ============================================================
//  全ページ共通：ヘッダー・フッター・メニュー・スライダー・タブ
//  ★ メニュー項目やフッターの文言を変えるときは、このファイルの
//    SITE / NAV / HEADER_HTML / FOOTER_HTML を編集してください。
//    （全ページに反映されます）
// ============================================================

const SITE = {
  name: "普賢アーカイブ運営委員会",
  nameEn: "Fugen Archive Development Committee",
  address: "〒000-0000 ○○県○○市 ○○○ 0-0-0",
  email: "fugen.archive.info@gmail.com",
  // ★ 普賢アーカイブ（別サイト）のURL。ここを変えると全ページのリンクが変わります。
  archiveUrl: "https://archive.example.jp/"
};

// グローバルナビゲーション（表示名, リンク先）
const NAV = [
  ["ホーム", "index.html"],
  ["委員会について", "about.html"],
  ["お知らせ", "news.html"],
  ["普賢アーカイブについて", "archive.html"],
  ["行事・イベント", "events.html"],
  ["入会案内", "join.html"],
  ["お問い合わせ", "contact.html"]
];

const HEADER_HTML = `
<div class="util-bar">
  <div class="inner">
    <ul>
      <li><a href="sitemap.html">サイトマップ</a></li>
      <li><a href="join.html">入会案内</a></li>
      <li><a href="member-login.html">会員ログイン</a></li>
      <li><a href="admin.html">管理者ログイン</a></li>
    </ul>
  </div>
</div>
<div class="header-main">
  <div class="inner">
    <a class="logo" href="index.html">
      <img class="logo-mark" src="LOGO.png" alt="" width="64" height="64">
      <span class="logo-text">
        <span class="logo-ja">${SITE.name}</span>
        <span class="logo-en">${SITE.nameEn}</span>
      </span>
    </a>
    <div class="header-actions">
      <a class="header-member-btn" href="member-login.html">会員ログイン</a>
      <a class="header-archive-btn" data-archive-link>普賢アーカイブを見る<span aria-hidden="true">↗</span></a>
    </div>
    <button class="menu-toggle" aria-label="メニュー" aria-expanded="false"><span></span><span></span><span></span></button>
  </div>
</div>
<nav class="global-nav" aria-label="グローバルナビゲーション">
  <ul class="inner">
    ${NAV.map(([label, href]) => `<li><a href="${href}">${label}</a></li>`).join("")}
    <li class="sp-only"><a href="member-login.html">会員ログイン</a></li>
  </ul>
</nav>`;

const FOOTER_HTML = `
<div class="footer-main">
  <div class="inner">
    <p class="footer-name">${SITE.name}</p>
    <p>E-mail：${SITE.email}</p>
    <p class="copyright">Copyright &copy; ${new Date().getFullYear()} ${SITE.nameEn}. All Rights Reserved.</p>
  </div>
</div>
<a href="#" class="pagetop" aria-label="ページトップへ">▲</a>`;

document.addEventListener("DOMContentLoaded", () => {
  // ---- ヘッダー・フッター挿入 ----
  const header = document.getElementById("site-header");
  const footer = document.getElementById("site-footer");
  if (header) header.innerHTML = HEADER_HTML;
  if (footer) footer.innerHTML = FOOTER_HTML;

  // ---- 普賢アーカイブ（別サイト）へのリンク：data-archive-link を付けた <a> に URL を設定 ----
  document.querySelectorAll("[data-archive-link]").forEach(a => {
    a.href = SITE.archiveUrl;
    a.target = "_blank";
    a.rel = "noopener";
  });

  // ---- 現在のページのメニューを強調 ----
  const current = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".global-nav a").forEach(a => {
    if (a.getAttribute("href") === current) a.classList.add("is-current");
  });

  // ---- スマホ用メニュー開閉 ----
  const toggle = document.querySelector(".menu-toggle");
  if (toggle) toggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", open);
  });

  // ---- ページトップ ----
  const pagetop = document.querySelector(".pagetop");
  if (pagetop) {
    pagetop.addEventListener("click", e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); });
    window.addEventListener("scroll", () => pagetop.classList.toggle("is-show", window.scrollY > 400));
  }

  // ---- タブ切り替え（data-tab="パネルのid"） ----
  document.querySelectorAll(".tabs").forEach(tabs => {
    tabs.querySelectorAll("[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        tabs.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("is-active", b === btn));
        const panels = document.querySelectorAll(`[data-tab-group="${tabs.dataset.group}"]`);
        panels.forEach(p => p.classList.toggle("is-show", p.id === btn.dataset.tab));
      });
    });
  });

  // ---- スライダー（.slider 内の .slide を自動で切り替え） ----
  document.querySelectorAll(".slider").forEach(initSlider);
});

function initSlider(slider) {
  const slides = [...slider.querySelectorAll(".slide")];
  if (slides.length < 2) { slides[0]?.classList.add("is-active"); return; }
  const dots = document.createElement("div");
  dots.className = "slider-dots";
  slides.forEach((_, i) => {
    const b = document.createElement("button");
    b.setAttribute("aria-label", `スライド${i + 1}`);
    b.addEventListener("click", () => { show(i); restart(); });
    dots.appendChild(b);
  });
  slider.appendChild(dots);
  const prev = slider.querySelector(".slider-prev");
  const next = slider.querySelector(".slider-next");
  if (prev) prev.addEventListener("click", () => { show(idx - 1); restart(); });
  if (next) next.addEventListener("click", () => { show(idx + 1); restart(); });

  let idx = 0, timer;
  function show(i) {
    idx = (i + slides.length) % slides.length;
    slides.forEach((s, n) => s.classList.toggle("is-active", n === idx));
    [...dots.children].forEach((d, n) => d.classList.toggle("is-active", n === idx));
  }
  function restart() { clearInterval(timer); timer = setInterval(() => show(idx + 1), 6000); }
  show(0); restart();
}
