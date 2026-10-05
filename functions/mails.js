// ============================================================
//  メールの文面（件名・本文）
//  ★ 文面を変えたいときはこのファイルを編集してください。
//    各関数は { to, subject, text, replyTo? } の配列を返します。
// ============================================================

// ★ 設定
const CONFIG = {
  orgName: "普賢アーカイブ運営委員会",
  notifyTo: "yuya.ikr@gmail.com",                       // 委員会への通知先
  siteUrl: "https://fugen-archive-official.web.app",    // サイトのURL
};

const TYPE_LABEL = { regular: "正会員", associate: "準会員", student: "学生会員" };

const signature = () => `
――――――――――――――――――――
${CONFIG.orgName}
${CONFIG.siteUrl}/
※ このメールは送信専用のアドレスから自動で送信しています。
　 ご返信いただいても内容を確認できない場合があります。
　 お問い合わせは ${CONFIG.siteUrl}/contact.html からお願いいたします。`;

const fmtDate = (d) => (d instanceof Date ? d : new Date()).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

// ---------- 入会申込があったとき ----------
function memberApplied(m) {
  const type = TYPE_LABEL[m.type] || m.type;
  return [
    {
      // 委員会への通知
      to: CONFIG.notifyTo,
      subject: `【入会申込】${m.name} 様（${type}）`,
      text:
`新しい入会申込がありました。管理画面から審査（承認・否認）を行ってください。

■ 会員種別：${type}
■ お名前　：${m.name}（${m.kana || ""}）
■ メール　：${m.email}
■ ご職業　：${m.occupation || "—"}
■ ご所属　：${m.affiliation || "—"}
■ 電話番号：${m.phone || "—"}
■ ご住所　：${m.address || "—"}
■ 申込日時：${fmtDate(m.createdAt)}

■ 入会の動機・メッセージ
${m.message || "（なし）"}

▼ 管理画面（会員タブ）
${CONFIG.siteUrl}/admin.html
`
    },
    {
      // 申込者への受付確認
      to: m.email,
      subject: `【${CONFIG.orgName}】入会お申込みを受け付けました`,
      text:
`${m.name} 様

このたびは${CONFIG.orgName}への入会をお申込みいただき、誠にありがとうございます。
以下の内容でお申込みを受け付けました。

■ 会員種別：${type}（入会金・年会費は無料です）
■ 受付日時：${fmtDate(m.createdAt)}

本会は委員会承認制です。委員会で審査のうえ、結果をこのメールアドレスへお知らせいたします。
審査の状況は、会員サイトからいつでもご確認いただけます。

▼ 会員サイト
${CONFIG.siteUrl}/member-login.html

お心当たりのない場合は、このメールを破棄してください。
${signature()}`
    }
  ];
}

// ---------- 承認されたとき ----------
function memberApproved(m) {
  const type = TYPE_LABEL[m.type] || m.type;
  return [{
    to: m.email,
    subject: `【${CONFIG.orgName}】入会承認のお知らせ`,
    text:
`${m.name} 様

${CONFIG.orgName}です。
委員会で審査を行い、ご入会が承認されましたのでお知らせいたします。
本日より会員サイトのすべての機能をご利用いただけます。

■ 会員番号：${m.memberNo || "—"}
■ 会員種別：${type}

▼ 会員サイト（ログイン）
${CONFIG.siteUrl}/member-login.html

会員サイトでは、会員向けのお知らせ・会員限定資料・行事への参加登録・デジタル会員証をご利用いただけます。
今後ともどうぞよろしくお願いいたします。
${signature()}`
  }];
}

// ---------- 否認されたとき ----------
function memberRejected(m) {
  return [{
    to: m.email,
    subject: `【${CONFIG.orgName}】入会審査結果のお知らせ`,
    text:
`${m.name} 様

${CONFIG.orgName}です。
このたびは入会をお申込みいただき、誠にありがとうございました。

委員会にて慎重に審査いたしましたが、誠に残念ながら、今回はご入会の承認に至りませんでした。
ご期待に沿えず申し訳ございません。

ご不明な点がございましたら、下記よりお問い合わせください。
${CONFIG.siteUrl}/contact.html
${signature()}`
  }];
}

// ---------- お問い合わせがあったとき ----------
function contactReceived(c) {
  return [
    {
      // 委員会への通知（そのまま「返信」すると送信者に届く）
      to: CONFIG.notifyTo,
      replyTo: c.email,
      subject: `【お問い合わせ】${c.subject}：${c.name} 様`,
      text:
`サイトからお問い合わせがありました。
このメールに返信すると、送信者（${c.email}）に届きます。

■ 種別　：${c.subject}
■ お名前：${c.name}
■ メール：${c.email}
■ 日時　：${fmtDate(c.createdAt)}

■ 内容
${c.message}

▼ 管理画面（お問い合わせタブ）
${CONFIG.siteUrl}/admin.html
`
    },
    {
      // 送信者への自動返信
      // ※ 第三者のアドレスあての迷惑メールに悪用されないよう、入力内容は本文に含めません
      to: c.email,
      subject: `【${CONFIG.orgName}】お問い合わせを受け付けました`,
      text:
`${CONFIG.orgName}です。
お問い合わせいただき、ありがとうございます。以下の日時に受け付けました。

■ 受付日時：${fmtDate(c.createdAt)}

内容を確認のうえ、担当者よりご連絡いたします。
お返事までお時間をいただく場合がございますので、あらかじめご了承ください。

お心当たりのない場合は、このメールを破棄してください。
${signature()}`
    }
  ];
}

// ---------- 管理者に招待したとき ----------
function adminInvited(inv) {
  return [{
    to: inv.email,
    subject: `【${CONFIG.orgName}】管理者への招待`,
    text:
`${inv.name || ""} 様

${CONFIG.orgName}のウェブサイト管理者として招待されました。
下記の管理画面から登録すると、管理者として利用できるようになります。

▼ 管理画面
${CONFIG.siteUrl}/admin.html

■ 登録方法
・このメールアドレスが Google アカウントの場合
　→「Googleでログイン」を押すだけで登録が完了します。
・それ以外の場合
　→「管理者として招待された方（初めての方）はこちら」から、このメールアドレス（${inv.email}）とパスワードを登録してください。
　　届いた確認メールのリンクを開くと登録が完了します。

お心当たりのない場合は、このメールを破棄してください。
${signature()}`
  }];
}

// ---------- 電子同意書に署名したとき（署名者へ控え） ----------
function consentSigned(s) {
  const signedAt = s.agreedAt?.toDate?.() || new Date(s.clientSignedAt);
  const verifyUrl = `${CONFIG.siteUrl}/consent-verify.html?id=${encodeURIComponent(s.id)}&h=${s.recordHash}`;
  return [{
    to: s.email,
    subject: `【${CONFIG.orgName}】「${s.formTitle}」への署名の控え`,
    text:
`${s.name} 様

${CONFIG.orgName}です。
以下の同意書への電子署名を受け付けました。このメールは署名の控えです。大切に保管してください。

■ 同意書　：${s.formTitle}（第${s.formVersion}版）
■ 署名者　：${s.name}
■ 署名日時：${fmtDate(signedAt)}
■ 署名ID　：${s.id}

■ 改ざん防止のための値（SHA-256 / HMAC-SHA256）
　文書のハッシュ値　：${s.formHash}
　署名記録のハッシュ値：${s.recordHash}
　サーバーの封印　　：${s.seal}（連番 ${s.seq}）

▼ 署名が有効か（内容が変更されていないか）は、次のページで確認できます
${verifyUrl}

お心当たりのない場合は、お手数ですが下記よりご連絡ください。
${CONFIG.siteUrl}/contact.html
${signature()}`
  }];
}

// ---------- 理事会への承認依頼（理事ごと） ----------
function reviewRequest({ director, member: m, groupName, total, link, reminder = false }) {
  const type = TYPE_LABEL[m.type] || m.type;
  return [{
    to: director.email,
    subject: `【${CONFIG.orgName}】${reminder ? "（再送）" : ""}入会申込の承認のお願い：${m.name} 様（${type}）`,
    text:
`${director.name || ""} 様

${CONFIG.orgName}です。
新しい入会申込がありました。${groupName}（${total}名）の皆さまに審査をお願いしております。
下記のページで申込内容をご確認のうえ、「承認」または「非承認」を選び、理由をご入力ください。

▼ 審査ページ（あなた専用のリンクです。他の方に転送しないでください）
${link}

■ 会員種別：${type}
■ お名前　：${m.name}（${m.kana || ""}）
■ ご職業　：${m.occupation || "—"}
■ ご所属　：${m.affiliation || "—"}

・理事会の全員が承認すると、自動で入会が承認され、申込者へ承認メールが送られます。
・1 名でも非承認の場合は、自動で否認となり、申込者へ否認メールが送られます。
・ご入力いただいた理由は理事会の記録として保存され、申込者には表示されません。
${reminder ? "\n※ 以前にお送りしたリンクは無効になりました。このメールのリンクをお使いください。\n" : ""}${signature()}`
  }];
}

// ---------- 理事会の審査結果（理事全員へ共有） ----------
function reviewResult({ review: r, member: m }) {
  const approved = r.status === "approved";
  const lines = Object.values(r.voters).map(v =>
    `・${v.name || v.email}：${v.decision === "approve" ? "承認" : v.decision === "reject" ? "非承認" : "未回答"}${v.reason ? `\n　理由：${v.reason.replace(/\n/g, "\n　　　　")}` : ""}`).join("\n");
  const text =
`理事会の皆さま

${CONFIG.orgName}です。
${m.name} 様（${TYPE_LABEL[m.type] || m.type}）の入会審査が確定しました。

■ 結果：${approved ? "承認（全員が承認）" : "否認（非承認の回答あり）"}
■ 承認 ${r.approveCount} 名 ／ 非承認 ${r.rejectCount} 名 ／ 理事 ${r.total} 名

■ 各理事の判断と理由（理事会の記録。申込者には通知されません）
${lines}

申込者へは${approved ? "承認" : "否認"}のお知らせを自動で送信しました。
▼ 管理画面
${CONFIG.siteUrl}/admin.html
${signature()}`;
  return Object.values(r.voters).map(v => ({ to: v.email, subject: `【${CONFIG.orgName}】入会審査の結果：${m.name} 様（${approved ? "承認" : "否認"}）`, text }));
}

// ---------- 会員証の署名の書き直し申請（委員会へ） ----------
function signatureRewriteRequested(m) {
  return [{
    to: CONFIG.notifyTo,
    subject: `【会員証】署名の書き直し申請：${m.name} 様（${m.memberNo || ""}）`,
    text:
`会員から、デジタル会員証の署名の書き直し申請がありました。
管理画面の「会員管理」から、許可または却下してください（許可すると本人が 1 回だけ書き直せます）。

■ お名前　：${m.name}
■ 会員番号：${m.memberNo || "—"}
■ メール　：${m.email}

▼ 管理画面
${CONFIG.siteUrl}/admin.html#members
`
  }];
}

// ---------- 会員証の署名の書き直しを許可（本人へ） ----------
function signatureRewriteAllowed(m) {
  return [{
    to: m.email,
    subject: `【${CONFIG.orgName}】会員証の署名の書き直しが許可されました`,
    text:
`${m.name} 様

${CONFIG.orgName}です。
デジタル会員証の署名の書き直しを許可しました。
会員サイトの「会員証」から「署名を書き直す」を押して、新しい署名を登録してください（書き直しは 1 回のみです）。

▼ 会員サイト（会員証）
${CONFIG.siteUrl}/member.html#card
${signature()}`
  }];
}

// ---------- 会員種別の変更申請（委員会へ） ----------
function typeChangeRequested(m) {
  return [{
    to: CONFIG.notifyTo,
    subject: `【会員種別の変更申請】${m.name} 様：${TYPE_LABEL[m.type] || m.type} → ${TYPE_LABEL[m.typeRequest] || m.typeRequest}`,
    text:
`会員から、会員種別の変更申請がありました。
管理画面の「会員管理」から、許可または却下してください。${m.typeRequest === "student" ? "\n学生会員への変更のため、学生証（表面）の画像が提出されています。" : ""}

■ お名前　：${m.name}
■ 会員番号：${m.memberNo || "—"}
■ 変更内容：${TYPE_LABEL[m.type] || m.type} → ${TYPE_LABEL[m.typeRequest] || m.typeRequest}
■ 理由　　：${m.typeRequestReason || "—"}

▼ 管理画面
${CONFIG.siteUrl}/admin.html#members
`
  }];
}

// ---------- 会員種別の変更結果（本人へ） ----------
function typeChangeDecided(m, beforeType) {
  const ok = m.typeDecision === "approved";
  const to = TYPE_LABEL[m.typeDecisionTo] || m.typeDecisionTo;
  return [{
    to: m.email,
    subject: `【${CONFIG.orgName}】会員種別の変更について（${ok ? "承認" : "結果のお知らせ"}）`,
    text:
`${m.name} 様

${CONFIG.orgName}です。
会員種別の変更（${TYPE_LABEL[beforeType] || beforeType} → ${to}）のお申し出について、${ok
  ? `委員会で承認し、会員種別を「${to}」に変更しました。\nデジタル会員証にも反映されています。`
  : "誠に恐れ入りますが、今回は変更を見送らせていただきました。\nご不明な点は、お問い合わせフォームからご連絡ください。"}

▼ 会員サイト
${CONFIG.siteUrl}/member.html
${signature()}`
  }];
}

module.exports = { CONFIG, memberApplied, memberApproved, memberRejected, contactReceived, adminInvited, consentSigned, reviewRequest, reviewResult , signatureRewriteRequested, signatureRewriteAllowed , typeChangeRequested, typeChangeDecided };