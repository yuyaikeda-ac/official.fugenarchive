// ============================================================
//  個人情報のマスク（AI に渡す前に必ず通す）
//
//  ・メールアドレス・電話番号・郵便番号・住所・氏名・会員番号・カード番号などの長い数字列・
//    URL のクエリ（トークンなどを含みやすい）を「[メール1]」のような置き換え記号にする
//  ・置き換え前の値は mask() が返す map にだけ残る（AI には送らない・データベースにも保存しない）
//  ・AI の返信文を本人へ送るときだけ unmask() で元に戻す
//  ★ 検出のパターンを増やしたいときは RULES に追加してください（上から順に適用）
// ============================================================

const RULES = [
  // メールアドレス
  { label: "メール", re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g },
  // URL（クエリ・フラグメントにトークンが入りやすいので、ドメインとパスだけ残す）
  { label: "URL", re: /https?:\/\/[^\s"'<>）)]+\?[^\s"'<>）)]*/g },
  // 会員番号（例：FA-2026-0001）
  { label: "会員番号", re: /\b[A-Z]{2,4}-\d{4}-\d{3,6}\b/g },
  // 電話番号（固定・携帯・国際表記）※ 郵便番号より先に判定
  { label: "電話", re: /(?<![\d-])(?:\+81[-\s]?|0)\d{1,4}[-\s(（]?\d{1,4}[-\s)）]?\d{3,4}(?![\d-])/g },
  // カード番号・マイナンバー・口座番号など 10 桁以上の数字（区切りあり含む）
  { label: "番号", re: /(?<![\d-])\d(?:[\s-]?\d){9,}(?![\d-])/g },
  // 郵便番号
  { label: "郵便番号", re: /〒?\s?(?<![\d-])\d{3}-\d{4}(?![\d-])/g },
  // 住所（都道府県から始まり、番地らしき数字を含むまで）
  { label: "住所", re: /(?:北海道|東京都|(?:京都|大阪)府|[^\s、。,「」（）()]{2,3}県)[^\s、。,「」]{1,40}?\d[\d\-−ー‐の丁目番地号]*(?:[^\s、。,「」]{0,20}?\d+号?室?)?/g },
  // 生年月日らしき日付（「生年月日」「誕生日」の後ろ）
  { label: "生年月日", re: /(?:生年月日|誕生日)[:：\s]*\d{2,4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?/g },
  // 「〇〇様」「〇〇さん」「〇〇氏」などの直前の人名（漢字・カタカナ。ひらがなは助詞と区別できないため含めない）
  { label: "氏名", re: /[一-龠々ァ-ヶー]{1,6}(?:[\s　][一-龠々ァ-ヶー]{1,6})?(?=(?:様|さま|さん|くん|ちゃん|氏|殿|先生))/g }
];

// 人名として扱わない語（「委員会様」「お客様」などの誤検出を防ぐ）
const NOT_NAMES = /(委員会|事務局|運営|担当|皆|客|会員|管理者|貴会|御中|各位|神|仏|職員|理事|会長|部長|課長|先方|相手|奥)/;

/**
 * 文字列をマスクする
 * @param texts  { key: 文字列 } まとめてマスクしたい項目（同じ値には同じ記号を使う）
 * @param known  { label: [値, ...] } 確実にマスクしたい既知の値（送信者の氏名・メールなど）
 * @returns { masked: { key: マスク後の文字列 }, map: { 記号: 元の値 }, counts: { label: 件数 } }
 */
function mask(texts, known = {}) {
  const map = {};          // 記号 → 元の値
  const byValue = {};      // 元の値 → 記号
  const counter = {};
  const tokenFor = (label, value) => {
    const v = value.trim();
    if (byValue[v]) return byValue[v];
    counter[label] = (counter[label] || 0) + 1;
    const token = `[${label}${counter[label]}]`;
    map[token] = v; byValue[v] = token;
    return token;
  };
  const masked = {};
  for (const [key, raw] of Object.entries(texts)) {
    // 全角の英数字・記号を半角にそろえてから検出（「０９０−…」なども検出できるように）
    let s = String(raw ?? "").normalize("NFKC");
    // 既知の値：同じ項目（同じ人の氏名の漢字・カナなど）は同じ記号にし、元に戻すときは最初の値を使う
    const knownList = [];
    for (const [label, vals] of Object.entries(known)) {
      const list = (vals || []).filter(v => v && String(v).trim().length >= 2).map(v => String(v).normalize("NFKC").trim());
      if (!list.length) continue;
      const token = tokenFor(label, list[0]);
      for (const v of list) {
        knownList.push([v, token]);
        // 姓・名を分けて書かれた場合も（「普賢 太郎」→「普賢」「太郎」）
        if (label === "氏名") for (const part of v.split(/[\s　]+/).filter(p => p.length >= 2)) knownList.push([part, token]);
      }
    }
    knownList.sort((a, b) => b[0].length - a[0].length); // 長いものから置き換え
    for (const [v, token] of knownList) s = s.split(v).join(token);
    for (const { label, re } of RULES) {
      s = s.replace(re, (m) => {
        if (/^\[.+\d\]$/.test(m)) return m; // すでに記号
        if (label === "氏名" && NOT_NAMES.test(m)) return m;
        if (label === "URL") { const [base] = m.split("?"); return `${base}?${tokenFor("URLパラメータ", m.slice(base.length + 1))}`; }
        return tokenFor(label, m);
      });
    }
    masked[key] = s;
  }
  const counts = {};
  for (const token of Object.keys(map)) { const label = token.replace(/^\[|\d+\]$/g, ""); counts[label] = (counts[label] || 0) + 1; }
  return { masked, map, counts };
}

/** 記号を元の値に戻す（本人へ送る返信文にだけ使う） */
function unmask(text, map) {
  return String(text ?? "").replace(/\[[^\[\]\s]{1,12}?\d{1,3}\]/g, (t) => map[t] ?? t);
}

/** 文字列に、マスクされていない個人情報が残っていないか（念のための最終確認） */
function looksUnmasked(text) {
  const s = String(text ?? "").normalize("NFKC");
  return RULES.filter(r => ["メール", "電話", "番号", "郵便番号"].includes(r.label)).some(r => { r.re.lastIndex = 0; const hit = r.re.test(s); r.re.lastIndex = 0; return hit; });
}

module.exports = { mask, unmask, looksUnmasked };
