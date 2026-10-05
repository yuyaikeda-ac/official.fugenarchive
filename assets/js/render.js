// ============================================================
//  表示用パーツ（行事の行 など）
// ============================================================
import { esc } from "./db.js";

const todayJst = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

/**
 * 行事1件分
 * @param opts  { detail: true で内容（装飾つき）と参加登録の案内も表示（行事ページ用） }
 *              装飾つきの内容は [data-ev-body] に入るので、表示後に renderEventBodies() を呼ぶ
 */
export function eventItemHtml(ev, { detail = false } = {}) {
  const [y = "", m = "", d = ""] = String(ev.date || "").split("-");
  const today = todayJst();
  const past = ev.date && ev.date < today;
  const title = ev.url ? `<a href="${esc(ev.url)}">${esc(ev.title)}</a>` : esc(ev.title);
  const week = ev.date ? "日月火水木金土"[new Date(ev.date + "T00:00:00+09:00").getDay()] : "";
  const time = ev.startTime ? `　${esc(ev.startTime)}${ev.endTime ? "〜" + esc(ev.endTime) : ""}` : "";
  // 会員の参加登録（受付中・満員・締切）
  let rsvp = "";
  if (detail && !past && ev.rsvpOpen !== false) {
    const count = Number(ev.rsvpCount) || 0, cap = Number(ev.capacity) || 0, remaining = cap ? Math.max(0, cap - count) : null;
    const closed = (ev.rsvpDeadline && ev.rsvpDeadline < today) ? "締切済み" : (cap && remaining <= 0) ? "満員" : "";
    rsvp = `<div class="ev-rsvp">
      <span class="ev-rsvp-badge ${closed ? "ng" : "ok"}">${closed || "会員の参加登録 受付中"}</span>
      ${cap ? `<span>定員 ${cap} 名・残り <b>${remaining}</b> 名</span>` : ""}${ev.rsvpDeadline ? `<span>締切 ${esc(ev.rsvpDeadline.replace(/-/g, "/"))}</span>` : ""}
      ${closed ? "" : `<a class="ev-rsvp-btn" href="member.html#events"><span class="pc">会員サイトで</span>ワンクリック参加登録 →</a>`}
    </div>`;
  }
  return `<li class="event-item${past ? " is-past" : ""}">
    <div class="event-date"><div class="y">${esc(y)}</div><div class="md">${esc(Number(m) || "")}/${esc(Number(d) || "")}</div>${week ? `<div class="w">（${week}）</div>` : ""}</div>
    <div>
      <h3>${title}</h3>
      ${time ? `<p>時間：${time.trim()}</p>` : ""}
      ${ev.place ? `<p>会場：${esc(ev.place)}</p>` : ""}
      ${detail && ev.bodyHtml ? `<div class="ev-body" data-ev-body="${esc(ev.id)}"></div>` : ev.description ? `<p>${esc(detail ? ev.description : ev.description.slice(0, 120))}</p>` : ""}
      ${rsvp}
    </div>
  </li>`;
}

/** 行事の装飾つきの内容を表示（安全な形にしてから） */
export async function renderEventBodies(root, rows) {
  const { renderRich } = await import("./rich-view.js");
  root.querySelectorAll("[data-ev-body]").forEach(el => {
    const ev = rows.find(r => r.id === el.dataset.evBody);
    if (ev) renderRich(el, ev);
  });
}

/** Firebase 未設定時の注意表示 */
export function showDemoBanner() {
  const div = document.createElement("div");
  div.className = "demo-banner";
  div.textContent = "デモ表示中：assets/js/firebase-config.js に Firebase の設定を入力すると、実データが表示されます。";
  document.body.prepend(div);
}
