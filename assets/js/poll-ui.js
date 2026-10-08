// ============================================================
//  投票・アンケート（会員サイトの「投票・アンケート」画面）
//   #votes            … 一覧（受付中／終了・結果）
//   #votes/<ID>       … 内容の確認と投票（入力 → 確認 → 送信）
//   #votes/<ID>/receipt … 投票の控え（受付番号・受付ハッシュ・確認）
//   #votes/<ID>/results … 確定した結果（グラフ・結果のハッシュ・自分の票の確認）
//  ・投票・控えの確認はすべて Cloud Functions（castVote / myVote / verifyBallot）
//  ・無記名投票の控え（受付ハッシュ）は投票直後の画面とメールにだけ表示（ブラウザには保存しない）
//  ※ 見た目は member.css の「投票・アンケート」
// ============================================================
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app, esc } from "./db.js";
import { renderRich } from "./rich-view.js";
import { fmtHash } from "./consent-core.js";

export const KIND_LABEL = { resolution: "総会の議決", survey: "アンケート" };
export const POLL_STATUS = { draft: "下書き", open: "受付中", closed: "受付終了（集計前）", final: "確定" };

const call = (name, data) => httpsCallable(getFunctions(app, "asia-northeast1"), name)(data).then(r => r.data);

// ---------- 日時（"YYYY-MM-DDTHH:mm" は日本時間） ----------
export const parseJst = (s) => {
  if (!s) return null;
  if (s?.toDate) return s.toDate();
  const str = String(s);
  const d = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str) ? `${str}:00+09:00` : str);
  return isNaN(d) ? null : d;
};
export const fmtJst = (s, withYear = true) => {
  const d = parseJst(s);
  return d ? d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", ...(withYear ? { year: "numeric" } : {}), month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }) : "—";
};

/** 受付の段階：before 受付前 / open 受付中 / ended 受付終了 / final 確定 */
export function phase(p, now = Date.now()) {
  if (p.status === "final") return "final";
  if (p.status === "closed") return "ended";
  const opens = parseJst(p.opensAt), closes = parseJst(p.closesAt);
  if (closes && now >= closes.getTime()) return "ended";
  if (opens && now < opens.getTime()) return "before";
  return "open";
}
const PHASE_LABEL = { before: "受付前", open: "受付中", ended: "受付終了", final: "結果確定" };
const PHASE_PILL = { before: "", open: "new", ended: "", final: "ok" };

// ---------- 読み込み ----------
/** 自分が対象の投票（公開中・受付終了・確定）。対象の会員種別も条件に入れる（firestore.rules がそれを確認するため） */
export async function loadPolls(member) {
  const snap = await getDocs(query(collection(db, "polls"),
    where("status", "in", ["open", "closed", "final"]), where("audience", "array-contains", member.type)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.closesAt || "").localeCompare(String(a.closesAt || "")));
}
/** 投票済みかどうか（記名のときは控えも） */
export async function loadMyVotes(polls) {
  const out = {};
  await Promise.all(polls.map(async p => {
    try { out[p.id] = await call("myVote", { pollId: p.id }); }
    catch (e) { console.warn("投票の状況を確認できませんでした", p.id, e); out[p.id] = { voted: false, error: true }; }
  }));
  return out;
}
/** 未投票で受付中の件数（バッジ・ダッシュボード用） */
export const todoCount = (st) => (st.polls || []).filter(p => phase(p) === "open" && st.pollVotes?.[p.id] && !st.pollVotes[p.id].voted).length;

// ---------- 画面 ----------
let tab = null;                // "open" | "done"
const drafts = {};             // 入力途中の回答（画面の行き来で消えないように。メモリのみ）
const steps = {};              // "form" | "confirm"
let verifyResult = null;       // 控えの確認結果（表示用）
let sending = false;

const pill = (cls, text) => `<span class="pill${cls ? " " + cls : ""}">${esc(text)}</span>`;
const period = (p) => `${p.opensAt ? fmtJst(p.opensAt) : "公開時"} 〜 ${fmtJst(p.closesAt)}`;
const back = `<a class="consent-back" href="#votes">← 投票・アンケートの一覧へ</a>`;

export function render(ctx) {
  const { state, icon, emptyState } = ctx;
  if (!state.polls) return `<div class="consent-list">${Array.from({ length: 3 }, () => '<div class="skel" style="height:96px;border-radius:16px"></div>').join("")}</div>`;
  if (state.errors.votes) return emptyState(state.errors.votes);
  const [, id, sub] = location.hash.slice(1).split("/");
  if (id) {
    const p = state.polls.find(x => x.id === id);
    if (!p) return back + emptyState("この投票・アンケートは見つかりませんでした（対象外か、公開が終了した可能性があります）");
    if (sub === "receipt") return receiptView(ctx, p);
    if (sub === "results") return resultsView(ctx, p);
    return pollView(ctx, p);
  }
  return listView(ctx);
}

function listView({ state, icon, emptyState }) {
  const groups = { open: [], done: [] };
  state.polls.forEach(p => (["open", "before"].includes(phase(p)) ? groups.open : groups.done).push(p));
  if (!tab) tab = groups.open.length || !groups.done.length ? "open" : "done";
  const t = (k, l) => `<button type="button" role="tab" data-ptab="${k}" aria-selected="${tab === k}" class="${tab === k ? "is-active" : ""}">${l}<span>${groups[k].length}</span></button>`;
  const rows = groups[tab];
  return `<p class="pl-lead">委員会からの投票・アンケートです。総会の議決も、ここからオンラインで投票できます。投票は改ざんを検出できる形（ハッシュ値と封印）で記録され、控えで自分の票を確認できます。</p>
  <div class="ev-tabs pl-tabs" role="tablist" aria-label="投票・アンケートの絞り込み">${t("open", "受付中")}${t("done", "終了・結果")}</div>
  ${rows.length ? `<div class="consent-list">${rows.map(p => itemHtml(p, state.pollVotes?.[p.id], icon)).join("")}</div>`
    : emptyState(tab === "open" ? "受付中の投票・アンケートはありません" : "終了した投票・アンケートはありません", "sign")}`;
}

function itemHtml(p, v, icon) {
  const ph = phase(p);
  const voted = !!v?.voted;
  const todo = ph === "open" && v && !voted;
  let btn;
  if (ph === "final" && p.results) btn = `<a class="lux-btn ghost sm" href="#votes/${esc(p.id)}/results">結果を見る</a>`;
  else if (voted) btn = `<a class="lux-btn ghost sm" href="#votes/${esc(p.id)}/receipt">投票済み（控えを見る）</a>`;
  else if (ph === "open") btn = `<a class="lux-btn sm" href="#votes/${esc(p.id)}">投票する</a>`;
  else btn = `<a class="lux-btn ghost sm" href="#votes/${esc(p.id)}">内容を見る</a>`;
  return `<div class="cf-item pl-item${todo ? " is-todo" : ""}">
    <span class="ico">${icon("vote")}</span>
    <div class="t">
      <div class="pl-tags">${pill(p.kind === "resolution" ? "kind-res" : "kind-sur", KIND_LABEL[p.kind] || "アンケート")}${p.anonymous ? pill("anon", "無記名") : pill("", "記名")}${pill(PHASE_PILL[ph], PHASE_LABEL[ph])}${voted ? pill("ok", "投票済み") : todo ? pill("imp", "未投票") : ""}</div>
      <h4>${esc(p.title)}</h4>
      <p>受付期間 ${esc(period(p))}</p>
    </div>
    ${btn}
  </div>`;
}

function headHtml(p) {
  const ph = phase(p);
  return `<header class="pl-head">
    <div class="pl-tags">${pill(p.kind === "resolution" ? "kind-res" : "kind-sur", KIND_LABEL[p.kind] || "アンケート")}${p.anonymous ? pill("anon", "無記名") : pill("", "記名")}${pill(PHASE_PILL[ph], PHASE_LABEL[ph])}</div>
    <h2>${esc(p.title)}</h2>
    <p class="pl-period">受付期間：${esc(period(p))}</p>
  </header>
  <div class="pl-body rich-body" data-poll-body></div>
  <p class="pl-anon ${p.anonymous ? "is-anon" : ""}">${p.anonymous
    ? "無記名投票です：誰が何に投票したかは記録されません。投票したかどうかだけが記録されます。"
    : "記名投票です：投票の内容は、お名前・会員番号とともに記録されます。"}</p>`;
}

// ---------- 投票（入力 → 確認） ----------
const optClass = (o) => /^賛成/.test(o) ? "yes" : /^反対/.test(o) ? "no" : /^棄権/.test(o) ? "abs" : "";
function questionHtml(p, q, i, ans) {
  const req = q.required ? '<span class="req">必須</span>' : "";
  const name = `q_${q.id}`;
  let body = "";
  if (q.type === "text") {
    body = `<textarea name="${name}" maxlength="1000" rows="4" placeholder="ご自由にお書きください（1000 文字まで）">${esc(ans || "")}</textarea>`;
  } else if (p.kind === "resolution" && q.type === "single") {
    body = `<div class="pl-seg" role="radiogroup" aria-label="${esc(q.text)}">${q.options.map(o =>
      `<label class="${optClass(o)}"><input type="radio" name="${name}" value="${esc(o)}"${ans === o ? " checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
  } else if (q.type === "multi") {
    const sel = Array.isArray(ans) ? ans : [];
    body = `${q.maxChoices ? `<p class="pl-note">${esc(q.maxChoices)} つまで選べます</p>` : `<p class="pl-note">あてはまるものをすべて選んでください</p>`}
      <div class="pl-opts" data-max="${esc(q.maxChoices || 0)}">${q.options.map(o =>
      `<label class="pl-opt"><input type="checkbox" name="${name}" value="${esc(o)}"${sel.includes(o) ? " checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
  } else {
    body = `<div class="pl-opts">${q.options.map(o =>
      `<label class="pl-opt"><input type="radio" name="${name}" value="${esc(o)}"${ans === o ? " checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
  }
  return `<fieldset class="pl-q" data-q="${esc(q.id)}">
    <legend><span class="pl-qno">${p.kind === "resolution" ? `第 ${i + 1} 号議案` : `Q${i + 1}`}</span>${esc(q.text)}${req}</legend>
    ${body}
    <p class="pl-err" hidden></p>
  </fieldset>`;
}

function answerText(p, q, a) {
  if (q.type === "multi") return Array.isArray(a) && a.length ? a.join("、") : "（未回答）";
  return a ? String(a) : "（未回答）";
}

function pollView(ctx, p) {
  const { state } = ctx;
  const ph = phase(p);
  const v = state.pollVotes?.[p.id];
  const wrap = (inner) => `<div class="consent-wrap pl-wrap" id="poll-box">${back}<section class="pl-card">${headHtml(p)}${inner}</section></div>`;
  if (v?.voted) return wrap(`<div class="alert ok">${esc(fmtJst(v.votedAt))} に投票済みです。<a href="#votes/${esc(p.id)}/receipt">控えを見る →</a></div>`);
  if (ph === "final") return wrap(p.results ? `<div class="alert info">結果が確定しました。<a href="#votes/${esc(p.id)}/results">結果を見る →</a></div>` : `<div class="alert info">結果が確定しました。${p.showResults === "never" ? "結果は会員には公開されません。" : "結果は確定後に公開されます。"}</div>`);
  if (ph === "ended") return wrap(`<div class="alert info">受付は終了しました。${p.showResults === "never" ? "結果は会員には公開されません。" : "結果は確定後に公開されます。"}</div>`);
  if (ph === "before") return wrap(`<div class="alert info">受付は ${esc(fmtJst(p.opensAt))} から始まります。</div>`);
  if (!v) return wrap(`<div class="skel" style="height:120px;border-radius:14px"></div>`);

  const draft = drafts[p.id] || {};
  if (steps[p.id] === "confirm") {
    return wrap(`<div class="pl-confirm">
      <h3>回答の確認</h3>
      <p class="pl-note">次の内容で投票します。<b>投票後は変更できません。</b></p>
      <dl class="pl-summary">${(p.questions || []).map((q, i) => `<div><dt>${p.kind === "resolution" ? `第 ${i + 1} 号議案` : `Q${i + 1}`}　${esc(q.text)}</dt>
        <dd class="${optClass(String(draft[q.id] || ""))}">${esc(answerText(p, q, draft[q.id]))}</dd></div>`).join("")}</dl>
      <div class="pl-actions">
        <button type="button" class="lux-btn ghost" data-poll-back>← 修正する</button>
        <button type="button" class="lux-btn" data-poll-cast>この内容で投票する</button>
      </div>
    </div>`);
  }
  return wrap(`<form id="poll-form" class="pl-form" novalidate>
    ${(p.questions || []).map((q, i) => questionHtml(p, q, i, draft[q.id])).join("")}
    <div class="pl-actions"><button type="submit" class="lux-btn">回答を確認する →</button></div>
  </form>`);
}

/** 入力欄から回答を読み取る */
function readAnswers(form, p) {
  const out = {};
  for (const q of p.questions || []) {
    const name = `q_${q.id}`;
    if (q.type === "multi") out[q.id] = [...form.querySelectorAll(`input[name="${CSS.escape(name)}"]:checked`)].map(x => x.value);
    else if (q.type === "text") out[q.id] = (form.elements[name]?.value || "").trim();
    else out[q.id] = form.querySelector(`input[name="${CSS.escape(name)}"]:checked`)?.value || "";
  }
  return out;
}
function validate(form, p, ans) {
  let first = null;
  for (const q of p.questions || []) {
    const fs = form.querySelector(`[data-q="${CSS.escape(q.id)}"]`);
    const err = fs.querySelector(".pl-err");
    const a = ans[q.id];
    let msg = "";
    const empty = q.type === "multi" ? !a.length : !a;
    if (q.required && empty) msg = q.type === "text" ? "回答を入力してください" : "選択してください";
    else if (q.type === "multi" && q.maxChoices && a.length > q.maxChoices) msg = `${q.maxChoices} つまで選べます`;
    else if (q.type === "text" && a.length > 1000) msg = "1000 文字以内で入力してください";
    err.hidden = !msg; err.textContent = msg;
    fs.classList.toggle("is-invalid", !!msg);
    if (msg && !first) first = fs;
  }
  first?.scrollIntoView({ behavior: "smooth", block: "center" });
  return !first;
}

// ---------- 控え ----------
function receiptBlock(p, r, { print = false } = {}) {
  return `<section class="receipt pl-receipt${print ? " is-print" : ""}">
    <div class="receipt-head">
      <img src="LOGO.png" alt="">
      <div><b>普賢アーカイブ運営委員会</b><span>電子投票　投票の控え</span></div>
      <span class="receipt-ok">✓ 投票済み</span>
    </div>
    <dl class="receipt-list">
      <div><dt>投票・アンケート</dt><dd>${esc(p.title)}（${esc(KIND_LABEL[p.kind] || "")}・${p.anonymous ? "無記名" : "記名"}）</dd></div>
      <div><dt>受付番号</dt><dd><code>${esc(r.ballotId || "—")}</code></dd></div>
      <div><dt>受付ハッシュ</dt><dd><code>${esc(fmtHash(r.receipt || ""))}</code></dd></div>
      ${r.seq ? `<div><dt>連番</dt><dd>${esc(r.seq)}</dd></div>` : ""}
      <div><dt>投票日時</dt><dd>${esc(fmtJst(r.castAt || r.votedAt))}</dd></div>
    </dl>
    <p class="receipt-note">受付ハッシュは、あなたの票の内容から計算した固有の値です。票が書き換えられると値が変わるため、
      結果の確定後に「自分の票が集計に含まれているか」を確かめられます。${print ? "" : "同じ内容の控えをメールでもお送りしました。"}</p>
  </section>`;
}
function verifyBoxHtml(p, r) {
  return `<section class="pl-verify" id="pl-verify">
    <h3>控えで確認する</h3>
    <p class="pl-note">受付番号と受付ハッシュで、あなたの票が改ざんされずに記録されているかを確認できます。</p>
    <form id="pl-verify-form" class="pl-verify-form">
      <label class="field"><span>受付番号</span><input name="ballotId" value="${esc(r?.ballotId || "")}" autocomplete="off" required></label>
      <label class="field"><span>受付ハッシュ</span><input name="receipt" value="${esc(r?.receipt ? fmtHash(r.receipt) : "")}" autocomplete="off" spellcheck="false" required></label>
      <button type="submit" class="lux-btn ghost">確認する</button>
    </form>
    <div id="pl-verify-out">${verifyResult?.pollId === p.id ? checklistHtml(verifyResult.res) : ""}</div>
  </section>`;
}
function checklistHtml(res) {
  if (!res) return "";
  return `<div class="pl-check ${res.ok ? "ok" : "ng"}">
    <p class="pl-check-sum">${res.ok ? "✓" : "✕"} ${esc(res.summary || (res.ok ? "確認できました" : "確認できませんでした"))}</p>
    ${res.found && res.counted !== undefined ? `<p class="pl-note">${res.counted ? "この票は確定した集計に含まれています。" : "この票はまだ集計されていません（結果の確定前）。"}</p>` : ""}
    ${(res.checks || []).length ? `<ul>${res.checks.map(c => `<li class="${c.ok ? "ok" : "ng"}"><b>${c.ok ? "✓" : "✕"}</b><span>${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</span></li>`).join("")}</ul>` : ""}
  </div>`;
}

function receiptView(ctx, p) {
  const { state } = ctx;
  const v = state.pollVotes?.[p.id];
  const fresh = state.pollReceipts?.[p.id];   // 投票した直後（このページを開いている間だけ）
  const r = fresh || (v?.ballotId ? { ballotId: v.ballotId, receipt: v.receipt, votedAt: v.votedAt } : null);
  const wrap = (inner) => `<div class="consent-wrap pl-wrap" id="poll-box">${back}${inner}</div>`;
  if (!v?.voted && !fresh) return wrap(`<div class="alert info">まだ投票していません。<a href="#votes/${esc(p.id)}">投票する →</a></div>`);
  if (!r) {
    return wrap(`<div class="alert ok">${esc(fmtJst(v.votedAt))} に投票済みです。</div>
      <div class="alert info">無記名投票のため、控え（受付番号・受付ハッシュ）は投票直後の画面とメールにだけ表示されます。メールの控えの値を入力すると確認できます。</div>
      ${verifyBoxHtml(p, null)}`);
  }
  return wrap(`${fresh && p.anonymous ? `<div class="alert info">この控えは今だけ表示されます。メールでもお送りしました。</div>` : fresh ? `<div class="alert ok">投票を受け付けました。ありがとうございました。</div>` : ""}
    ${receiptBlock(p, r)}
    <div class="receipt-actions pl-receipt-actions">
      <button type="button" class="lux-btn ghost sm" data-poll-print>控えを印刷</button>
      ${phase(p) === "final" && p.results ? `<a class="lux-btn ghost sm" href="#votes/${esc(p.id)}/results">結果を見る</a>` : ""}
    </div>
    ${verifyBoxHtml(p, r)}`);
}

// ---------- 結果 ----------
function resultsView(ctx, p) {
  const { state } = ctx;
  const wrap = (inner) => `<div class="consent-wrap pl-wrap" id="poll-box">${back}<section class="pl-card">${headHtml(p)}${inner}</section></div>`;
  if (p.status !== "final" || !p.results) return wrap(`<div class="alert info">${p.showResults === "never" ? "結果は会員には公開されません。" : "結果は確定後に公開されます。"}</div>`);
  const R = p.results;
  const total = Number(R.total) || 0, eligible = Number(R.eligible) || 0;
  const turnout = eligible ? Math.round(total / eligible * 1000) / 10 : null;
  const qs = (p.questions || []).map((q, i) => {
    const label = p.kind === "resolution" ? `第 ${i + 1} 号議案` : `Q${i + 1}`;
    if (q.type === "text") return `<div class="pl-res-q"><h4><span class="pl-qno">${label}</span>${esc(q.text)}</h4><p class="pl-note">記述の回答 ${esc(R.textCount?.[q.id] || 0)} 件（内容は公開されません）</p></div>`;
    const t = R.tallies?.[q.id] || {};
    const base = q.type === "multi" ? total : (q.options || []).reduce((s, o) => s + (Number(t[o]) || 0), 0);
    return `<div class="pl-res-q"><h4><span class="pl-qno">${label}</span>${esc(q.text)}</h4>
      <ul class="pl-bars">${(q.options || []).map(o => {
        const n = Number(t[o]) || 0;
        const pct = base ? Math.round(n / base * 1000) / 10 : 0;
        return `<li class="${optClass(o)}"><span class="pl-bar-label">${esc(o)}</span>
          <span class="pl-bar" role="img" aria-label="${esc(o)}：${n} 票（${pct}%）"><i style="width:${pct}%"></i></span>
          <span class="pl-bar-num"><b>${n}</b> 票　${pct}%</span></li>`;
      }).join("")}</ul>
      ${q.type === "multi" ? `<p class="pl-note">複数回答。割合は投票数（${total} 票）に対する割合です。</p>` : ""}</div>`;
  }).join("");
  const known = state.pollReceipts?.[p.id] || state.pollVotes?.[p.id];
  return wrap(`<div class="pl-res-sum">
      <div><span>投票数</span><b>${total}</b><small>票</small></div>
      <div><span>対象の会員</span><b>${eligible || "—"}</b><small>名</small></div>
      <div><span>投票率</span><b>${turnout === null ? "—" : turnout}</b><small>%</small></div>
    </div>
    ${qs}
    <dl class="pl-hashes">
      <div><dt>結果のハッシュ値（SHA-256）</dt><dd><code>${esc(fmtHash(R.resultsHash || ""))}</code></dd></div>
      <div><dt>サーバーの封印</dt><dd><code>${esc(fmtHash(R.seal || ""))}</code></dd></div>
      ${p.finalizedAt ? `<div><dt>確定日時</dt><dd>${esc(fmtJst(p.finalizedAt))}</dd></div>` : ""}
    </dl>
    <section class="pl-verify" id="pl-include">
      <h3>自分の票が集計に含まれているか確認</h3>
      <p class="pl-note">投票の控えにある「受付ハッシュ」を入力してください。確定した結果の全票の受付ハッシュ（${esc((R.receipts || []).length)} 件）と照合します。</p>
      <form id="pl-include-form" class="pl-verify-form">
        <label class="field"><span>受付ハッシュ</span><input name="receipt" value="${esc(known?.receipt ? fmtHash(known.receipt) : "")}" autocomplete="off" spellcheck="false" required></label>
        <button type="submit" class="lux-btn ghost">照合する</button>
      </form>
      <div id="pl-include-out"></div>
    </section>`);
}

// ---------- 表示後の処理 ----------
export function after(ctx) {
  const { state, rerender, toast } = ctx;
  document.querySelectorAll("[data-ptab]").forEach(b => b.addEventListener("click", () => { tab = b.dataset.ptab; rerender(); }));
  const [, id, sub] = location.hash.slice(1).split("/");
  const p = id && state.polls?.find(x => x.id === id);
  if (!p) return;
  const bodyEl = document.querySelector("[data-poll-body]");
  if (bodyEl) { if (p.bodyHtml || p.bodyText) renderRich(bodyEl, { bodyHtml: p.bodyHtml, body: p.bodyText }); else bodyEl.remove(); }

  // 入力
  const form = document.getElementById("poll-form");
  if (form) {
    // 複数選択の上限
    form.querySelectorAll(".pl-opts[data-max]").forEach(box => {
      const max = Number(box.dataset.max) || 0;
      if (!max) return;
      const sync = () => {
        const n = box.querySelectorAll("input:checked").length;
        box.querySelectorAll("input:not(:checked)").forEach(i => { i.disabled = n >= max; i.closest("label").classList.toggle("is-disabled", n >= max); });
      };
      box.addEventListener("change", sync); sync();
    });
    form.addEventListener("change", () => { drafts[p.id] = readAnswers(form, p); });
    form.addEventListener("input", () => { drafts[p.id] = readAnswers(form, p); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const ans = readAnswers(form, p);
      drafts[p.id] = ans;
      if (!validate(form, p, ans)) return;
      steps[p.id] = "confirm";
      rerender(); window.scrollTo({ top: 0, behavior: "instant" });
    });
  }
  // 確認 → 送信
  document.querySelector("[data-poll-back]")?.addEventListener("click", () => { steps[p.id] = "form"; rerender(); window.scrollTo({ top: 0, behavior: "instant" }); });
  document.querySelector("[data-poll-cast]")?.addEventListener("click", async (e) => {
    if (sending) return;
    if (!window.confirm("この内容で投票します。投票後は変更できません。よろしいですか？")) return;
    const btn = e.currentTarget;
    sending = true; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 送信中…';
    try {
      const ans = {};
      for (const q of p.questions || []) {
        const a = drafts[p.id]?.[q.id];
        if (q.type === "multi") { if (Array.isArray(a) && a.length) ans[q.id] = a; }
        else if (a) ans[q.id] = a;
      }
      const res = await call("castVote", { pollId: p.id, answers: ans });
      (state.pollReceipts ||= {})[p.id] = res;
      state.pollVotes[p.id] = { voted: true, votedAt: res.castAt, ...(p.anonymous ? {} : { ballotId: res.ballotId, receipt: res.receipt }) };
      delete drafts[p.id]; delete steps[p.id];
      ctx.updateBadges();
      toast("投票を受け付けました。控えをメールでもお送りしました");
      location.hash = `votes/${p.id}/receipt`;
    } catch (err) {
      console.error(err);
      toast(err.message || "投票できませんでした", true);
      btn.disabled = false; btn.textContent = "この内容で投票する";
    } finally { sending = false; }
  });
  // 控えの印刷
  document.querySelector("[data-poll-print]")?.addEventListener("click", () => {
    const r = state.pollReceipts?.[p.id] || (state.pollVotes?.[p.id]?.ballotId ? state.pollVotes[p.id] : null);
    if (!r) return;
    document.getElementById("print-sheet")?.remove();
    const sheet = document.createElement("div");
    sheet.id = "print-sheet";
    sheet.innerHTML = receiptBlock(p, r, { print: true });
    document.body.appendChild(sheet);
    window.print();
  });
  // 控えで確認する
  document.getElementById("pl-verify-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const ballotId = f.elements.ballotId.value.trim();
    const receipt = f.elements.receipt.value.replace(/\s+/g, "").toLowerCase();
    const out = document.getElementById("pl-verify-out");
    const btn = f.querySelector("button");
    btn.disabled = true; out.innerHTML = '<p class="pl-note">確認しています…</p>';
    try {
      const res = await call("verifyBallot", { pollId: p.id, ballotId, receipt });
      verifyResult = { pollId: p.id, res };
      out.innerHTML = checklistHtml(res);
    } catch (err) { console.error(err); out.innerHTML = ""; toast(err.message || "確認できませんでした", true); }
    finally { btn.disabled = false; }
  });
  // 結果に自分の票が含まれているか
  document.getElementById("pl-include-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const receipt = e.target.elements.receipt.value.replace(/\s+/g, "").toLowerCase();
    const out = document.getElementById("pl-include-out");
    if (!/^[0-9a-f]{64}$/.test(receipt)) { out.innerHTML = checklistHtml({ ok: false, summary: "受付ハッシュは 64 桁の英数字です。控えの値をそのまま入力してください。" }); return; }
    const included = (p.results?.receipts || []).includes(receipt);
    out.innerHTML = checklistHtml({ ok: included, summary: included ? "この受付ハッシュは、確定した集計に含まれています。" : "この受付ハッシュは、確定した集計に見つかりませんでした。" });
    const known = state.pollReceipts?.[p.id] || state.pollVotes?.[p.id];
    if (included && known?.ballotId && known.receipt === receipt) {
      try { out.insertAdjacentHTML("beforeend", checklistHtml(await call("verifyBallot", { pollId: p.id, ballotId: known.ballotId, receipt }))); }
      catch (err) { console.warn(err); }
    }
  });
}
