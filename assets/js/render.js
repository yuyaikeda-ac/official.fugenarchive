// ============================================================
//  表示用パーツ（行事の行 など）
// ============================================================
import { esc } from "./db.js";

/** 行事1件分 */
export function eventItemHtml(ev) {
  const [y = "", m = "", d = ""] = String(ev.date || "").split("-");
  const past = ev.date && ev.date < new Date().toISOString().slice(0, 10);
  const title = ev.url ? `<a href="${esc(ev.url)}">${esc(ev.title)}</a>` : esc(ev.title);
  return `<li class="event-item${past ? " is-past" : ""}">
    <div class="event-date"><div class="y">${esc(y)}</div><div class="md">${esc(Number(m) || "")}/${esc(Number(d) || "")}</div></div>
    <div>
      <h3>${title}</h3>
      ${ev.place ? `<p>会場：${esc(ev.place)}</p>` : ""}
      ${ev.description ? `<p>${esc(ev.description)}</p>` : ""}
    </div>
  </li>`;
}

/** Firebase 未設定時の注意表示 */
export function showDemoBanner() {
  const div = document.createElement("div");
  div.className = "demo-banner";
  div.textContent = "デモ表示中：assets/js/firebase-config.js に Firebase の設定を入力すると、実データが表示されます。";
  document.body.prepend(div);
}
