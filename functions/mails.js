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
■ ご所属　：${m.affiliation || "—"}${m.type === "student" ? `\n■ 学籍番号：${m.studentNo || "—"}` : ""}${m.type === "regular" ? `
■ 入会理由：${m.joinReason || "—"}${m.referrer ? `\n■ 紹介者　：${m.referrer}` : ""}` : ""}
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

内容を確認のうえ、担当者より通常 3 営業日以内（土日祝日・年末年始などの長期休暇を除く）にご連絡いたします。
内容によっては、お返事までさらにお時間をいただく場合がございます。あらかじめご了承ください。

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

▼ 管理画面（登録用）
${CONFIG.siteUrl}/admin.html?invite=${encodeURIComponent(inv.email)}

■ 登録方法
・このメールアドレスが Google アカウント（Gmail など）の場合
　→「Googleでログイン」を押すだけで登録が完了します。パスワードの登録は不要です。
・それ以外の場合
　1. 上のリンクを開くと、登録欄にこのメールアドレス（${inv.email}）が入った状態で表示されます
　2. 管理画面で使うパスワードを「新しく決めて」入力してください
　　 （メールアドレスのパスワードではありません。次回からはこのパスワードでログインします）
　3. 届いた確認メールのリンクを開き、管理画面で「確認しました」を押すと登録が完了します

お心当たりのない場合は、このメールを破棄してください。
${signature()}`
  }];
}

// ---------- 2 段階認証のコード（mfa.js。ログイン時・メール方式の設定時） ----------
function mfaCode({ to, code, minutes, purpose }) {
  const enroll = purpose === "enroll";
  return [{
    to,
    subject: `【${CONFIG.orgName}】${enroll ? "2 段階認証の設定" : "ログイン"}の確認コード：${code}`,
    text:
`${enroll ? "2 段階認証（メール）を設定するための確認コードです。" : "ログインのための確認コード（2 段階認証）です。"}
画面に次の 6 桁のコードを入力してください。

　　${code}

・有効期限は ${minutes} 分です。
・このコードはだれにも教えないでください。委員会からコードをお聞きすることはありません。
・お心当たりのない場合は、パスワードが他人に知られている可能性があります。パスワードを変更してください。
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
■ ご所属　：${m.affiliation || "—"}${m.type === "regular" ? `\n■ 入会理由：${m.joinReason || "—"}` : ""}

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
管理画面の「会員管理」から、許可または却下してください。${m.typeRequest === "student" ? (m.typeRequestStudentNo ? "\n学生会員への変更のため、学籍番号が入力されています（学生証の画像も提出されている場合があります）。" : "\n学生会員への変更のため、学生証（表面）の画像が提出されています。") : ""}

■ お名前　：${m.name}
■ 会員番号：${m.memberNo || "—"}
■ 変更内容：${TYPE_LABEL[m.type] || m.type} → ${TYPE_LABEL[m.typeRequest] || m.typeRequest}
■ 理由　　：${m.typeRequestReason || "—"}${m.typeRequest === "student" ? `\n■ 学籍番号：${m.typeRequestStudentNo || "—"}` : ""}

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

// ============================================================
//  お問い合わせの AI オペレータ（ai-operator.js）
// ============================================================
const AI_NOTE = `※ このメールは、お問い合わせ窓口の AI オペレータが自動で作成・送信しました。
　 内容に誤りやご不明な点がございましたら、このメールに返信せず、お問い合わせフォームからご連絡ください。
　 担当者が確認いたします。`;

// ---------- AI からの返信（送信者へ） ----------
function contactAiReply({ to, subject, body, answered }) {
  return [{
    to,
    subject: `【${CONFIG.orgName}】${subject}`,
    text:
`${body.trim()}

${answered ? "" : "担当者が内容を確認のうえ、通常 3 営業日以内（土日祝日・年末年始などの長期休暇を除く）にご連絡いたします。\n\n"}${AI_NOTE}
${signature()}`
  }];
}

// ---------- AI が送るパスワード再設定メール ----------
function passwordResetByAi({ to, name, link }) {
  return [{
    to,
    subject: `【${CONFIG.orgName}】パスワード再設定のご案内`,
    text:
`${name ? name + " 様" : "会員の皆さま"}

${CONFIG.orgName}です。
お問い合わせいただいた内容にもとづき、会員サイトのパスワード再設定用のリンクをお送りします。
下記のリンクを開き、新しいパスワードを設定してください（有効期限は 1 時間です）。

▼ パスワード再設定
${link}

お心当たりのない場合は、このメールを破棄してください（パスワードは変更されません）。
${signature()}`
  }];
}

// ---------- 担当者の対応が必要なお問い合わせ（委員会へ） ----------
function contactAiNotify(c, ai) {
  const actions = (ai.actions || []).map(a => `・${a.tool}${a.result ? "：" + a.result : ""}`).join("\n") || "・なし";
  return [{
    to: CONFIG.notifyTo,
    replyTo: c.email,
    subject: `【お問い合わせ・要対応${ai.priority === "urgent" || ai.priority === "high" ? "（優先度：" + ai.priorityLabel + "）" : ""}】${ai.categoryLabel}：${c.name} 様`,
    text:
`お問い合わせに AI オペレータが 1 次対応しました。担当者の対応が必要です。
このメールに返信すると、送信者（${c.email}）に届きます。管理画面から返信することもできます。

■ AI の要約
${ai.summary}

■ 担当者がすべきこと
${ai.humanReason || "—"}

■ 分類：${ai.categoryLabel}　／　優先度：${ai.priorityLabel}
■ AI が実行した操作
${actions}

■ AI が送信者へ送った返信
${ai.replyBody}

■ 担当者の返信の下書き（AI 作成）
${ai.draftForStaff || "—"}

――――――――――――――――――――
■ 元のお問い合わせ
■ 種別　：${c.subject}
■ お名前：${c.name}
■ メール：${c.email}
■ 日時　：${fmtDate(c.createdAt)}

${c.message}

▼ 管理画面（お問い合わせ）
${CONFIG.siteUrl}/admin.html#contacts
`
  }];
}

// ---------- 担当者からの返信（管理画面から送信） ----------
function contactStaffReply({ to, subject, body }) {
  return [{
    to,
    subject: `【${CONFIG.orgName}】${subject}`,
    text: `${body.trim()}
${signature()}`
  }];
}

// ============================================================
//  お問い合わせチケット（tickets.js）
// ============================================================
// ---------- AI・担当者の返信（お客様へ。返信のたびに送信） ----------
function ticketReplyToCustomer({ to, name, no, link, from, text, first = false, closed = false, category = "", askClose = false }) {
  const who = from === "staff" ? "担当者" : "AI オペレータ";
  return [{
    to,
    subject: `【${CONFIG.orgName}】${first ? "お問い合わせを受け付けました" : "お問い合わせへの返信"}（${no}）`,
    text:
`${name} 様

${CONFIG.orgName}です。${first
  ? `\nお問い合わせを受け付け、チケットを発行しました。\n\n■ チケット番号：${no}\n■ 種別　　　　：${category}\n\nAI オペレータからの返信は次のとおりです。`
  : `\nお問い合わせ（${no}）に、${who}から返信がありました。`}

――――――――――――――――――――
${text.trim()}
――――――――――――――――――――

▼ このお問い合わせの専用チャット（返信・続きはこちらから）
${link}
※ このリンクはお客様専用です。他の方に転送しないでください。
${askClose && !closed ? "\n解決した場合は、専用チャットの「チャットを終了する」ボタンでお問い合わせを終了できます。\n" : ""}${closed ? "\nこのお問い合わせは完了となりました。新しいお問い合わせはお問い合わせページからお送りください。\n" : ""}${from === "ai" ? `
※ 担当者からの返信は、通常 3 営業日以内（土日祝日・年末年始などの長期休暇を除く）にお送りします。
※ AI オペレータの返信は自動で作成しています。担当者との対応をご希望の場合は、専用チャットの「担当者に相談する」を押してください。` : ""}
${signature()}`
  }];
}

// ---------- 委員会への通知（担当者へ引き継ぎ・担当者の対応中のお客様からの返信） ----------
function ticketToStaff({ kind, ticket: t, text, adminLink }) {
  const escalated = kind === "escalated";
  return [{
    to: CONFIG.notifyTo,
    subject: escalated
      ? `【お問い合わせ・要対応${t.priority === "urgent" || t.priority === "high" ? "（優先度：" + t.priorityLabel + "）" : ""}】${t.no} ${t.category}：${t.name} 様`
      : `【お問い合わせ・お客様から返信】${t.no}：${t.name} 様`,
    text:
`${escalated ? "AI オペレータが担当者へ引き継ぎました。対応をお願いします。" : "担当者が対応中のお問い合わせに、お客様から返信がありました。"}
返信は管理画面から行ってください（お客様へメールが届き、専用チャットにも表示されます）。

▼ 管理画面
${adminLink}

■ チケット：${t.no}（${t.category}）
■ お名前　：${t.name}
■ メール　：${t.email}
${escalated ? `■ 優先度　：${t.priorityLabel || "—"}
■ AI の要約：${t.summary || "—"}
■ 担当者がすべきこと：${t.todoForStaff || "—"}

■ これまでのやりとり
` : "■ お客様の返信\n"}${text}
`
  }];
}

// ---------- お問い合わせの転送（管理画面で「転送」→ 選んだ管理者へ） ----------
function ticketTransferred({ to, toName, fromName, note, ticket: t, text, adminLink }) {
  return [{
    to,
    subject: `【お問い合わせ・転送】${t.no} ${t.category || ""}：${t.name || ""} 様（${fromName} さんから）`,
    text:
`${toName} さん

${fromName} さんから、お問い合わせが転送されました。担当者はあなたになっています。
返信は管理画面から行ってください（お客様へメールが届き、専用チャットにも表示されます）。

▼ 管理画面
${adminLink}
${note ? `
■ ${fromName} さんからのメモ
${note}
` : ""}
■ チケット：${t.no}（${t.category || "—"}）
■ お名前　：${t.name || "—"}
■ メール　：${t.email || "—"}
■ AI の要約：${t.summary || "—"}
■ 担当者がすべきこと：${t.todoForStaff || "—"}

■ これまでのやりとり
${text}
`
  }];
}

// ---------- ログイン方法の案内（パスワード再設定を頼まれたが、パスワードのないアカウント・管理者だった場合） ----------
function loginGuideByAi({ to, name, kind, hasPassword = false }) {
  const body = kind === "admin"
    ? `このメールアドレスは、ウェブサイトの管理者アカウントとして登録されています。
安全のため、管理者アカウントのパスワードはお問い合わせ窓口からは再設定できません。

▼ 管理画面のログイン
${CONFIG.siteUrl}/admin.html
${hasPassword ? "・パスワードを忘れた場合は、ログイン画面でメールアドレスを入力し「パスワードの設定・再設定」を押してください。" : "・このアカウントにはパスワードがありません。ログイン画面の「Google でログイン」を押してください。"}`
    : `このメールアドレスのアカウントは「Google アカウント」でログインする設定のため、パスワードはありません。
会員ログイン画面で「Google でログイン」を押し、このメールアドレスの Google アカウントを選んでください。

▼ 会員ログイン
${CONFIG.siteUrl}/member-login.html`;
  return [{
    to,
    subject: `【${CONFIG.orgName}】ログイン方法のご案内`,
    text:
`${name ? name + " 様" : "ご登録の方へ"}

${CONFIG.orgName}です。
お問い合わせ窓口でパスワードの再設定のご依頼がありましたので、ログイン方法をご案内します。

${body}

お心当たりのない場合は、このメールを破棄してください。
${signature()}`
  }];
}

// ---------- 行事の参加登録・取り消し（会員へ） ----------
function eventRsvpMail({ member: mm, event: e, join }) {
  const [y, mo, d] = String(e.date || "").split("-");
  const week = e.date ? "日月火水木金土"[new Date(e.date + "T00:00:00+09:00").getDay()] : "";
  const when = e.date ? `${y}年${Number(mo)}月${Number(d)}日（${week}）${e.startTime ? " " + e.startTime + (e.endTime ? "〜" + e.endTime : "") : ""}` : "—";
  return [{
    to: mm.email,
    subject: `【${CONFIG.orgName}】${join ? "参加登録を受け付けました" : "参加登録を取り消しました"}：${e.title}`,
    text:
`${mm.name} 様

${CONFIG.orgName}です。
${join ? "下記の行事への参加登録を受け付けました。当日お会いできるのを楽しみにしております。" : "下記の行事の参加登録を取り消しました。"}

■ 行事　：${e.title}
■ 日時　：${when}
■ 会場　：${e.place || "—"}
${e.url ? `■ 詳細　：${e.url}\n` : ""}
${join ? "ご都合が悪くなった場合は、会員サイトの「行事・参加登録」から取り消しできます。" : "あらためて参加される場合は、会員サイトの「行事・参加登録」から登録できます。"}

▼ 会員サイト（行事・参加登録）
${CONFIG.siteUrl}/member.html#events
${signature()}`
  }];
}

// ---------- 会員へのお知らせ（会員向けお知らせ・行事・会員限定資料の投稿時） ----------
function memberNotice({ to, name, kind, item: it }) {
  const plain = String(it.body || it.description || "").replace(/\s+\n/g, "\n").trim();
  const excerpt = plain.length > 400 ? plain.slice(0, 400) + "…" : plain;
  const fmtDay = (v) => { const [y, mo, d] = String(v || "").split("-"); return y ? `${y}年${Number(mo)}月${Number(d)}日（${"日月火水木金土"[new Date(v + "T00:00:00+09:00").getDay()]}）` : ""; };
  let head = "", detail = "", link = "", label = "";
  if (kind === "events") {
    label = "新しい行事";
    head = `新しい行事のご案内です。`;
    const cap = Number(it.capacity) || 0;
    detail = `■ 行事　：${it.title}
■ 日時　：${fmtDay(it.date)}${it.startTime ? " " + it.startTime + (it.endTime ? "〜" + it.endTime : "") : ""}
■ 会場　：${it.place || "—"}${cap ? `\n■ 定員　：${cap} 名（先着順）` : ""}${it.rsvpDeadline ? `\n■ 申込締切：${fmtDay(it.rsvpDeadline)}` : ""}${excerpt ? `\n\n${excerpt}` : ""}

${it.rsvpOpen === false ? "" : "会員サイトから、ワンクリックで参加登録できます。\n"}`;
    link = `${CONFIG.siteUrl}/member.html#events`;
  } else if (kind === "member_docs") {
    label = "新しい会員限定資料";
    head = `会員限定資料室に、新しい資料を掲載しました。`;
    detail = `■ 資料名：${it.title}${it.category ? `\n■ 分類　：${it.category}` : ""}${excerpt ? `\n\n${excerpt}` : ""}\n`;
    link = `${CONFIG.siteUrl}/member.html#docs`;
  } else {
    label = it.important ? "【重要】会員向けのお知らせ" : "会員向けのお知らせ";
    head = `会員向けのお知らせを掲載しました。`;
    detail = `■ ${it.title}\n■ 掲載日：${fmtDay(it.date)}${excerpt ? `\n\n${excerpt}` : ""}\n`;
    link = `${CONFIG.siteUrl}/member.html#news/${it.id}`;
  }
  return [{
    to,
    subject: `【${CONFIG.orgName}】${label}：${it.title}`,
    text:
`${name ? name + " 様" : "会員の皆さまへ"}

${CONFIG.orgName}です。
${head}

${detail}
▼ 会員サイトで見る（ログインが必要です）
${link}

※ このメールは「会員向けのお知らせをメールで受け取る」に設定している会員の皆さまにお送りしています。
　 受け取りの設定は、会員サイトの「プロフィール設定」で変更できます。
${signature()}`
  }];
}

// ============================================================
//  投票・アンケート（polls.js）
// ============================================================
const pollWhen = (s) => { if (!s) return ""; const d = new Date(`${s}:00+09:00`); return `${d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short" })} ${s.slice(11, 16)}`; };
const POLL_KIND = { resolution: "総会の議決", survey: "アンケート" };

// ---------- 投票の案内（公開時・対象の会員へ） ----------
function pollOpened({ to, name, poll: p }) {
  return [{
    to,
    subject: `【${CONFIG.orgName}】${POLL_KIND[p.kind] || "投票"}のお願い：${p.title}`,
    text:
`${name ? name + " 様" : "会員の皆さまへ"}

${CONFIG.orgName}です。
${p.kind === "resolution" ? "総会の議案について、オンラインでの議決権の行使（投票）を受け付けています。" : "アンケートへのご協力をお願いいたします。"}

■ 件名　　：${p.title}
■ 受付期間：${p.opensAt ? pollWhen(p.opensAt) + " 〜 " : "受付中 〜 "}${pollWhen(p.closesAt)}
■ 方式　　：${p.anonymous ? "無記名（だれが何に投票したかは記録されません）" : "記名"}

▼ 会員サイトで回答する（ログインが必要です）
${CONFIG.siteUrl}/member.html#votes/${p.id}

投票は 1 人 1 回です。投票すると、控え（受付番号・ハッシュ値）をメールでお送りします。
${signature()}`
  }];
}

// ---------- 投票の控え（投票した会員へ） ----------
function voteReceipt({ to, name, poll: p, ballotId, receipt, seq, castAtIso }) {
  return [{
    to,
    subject: `【${CONFIG.orgName}】投票の控え：${p.title}`,
    text:
`${name} 様

${CONFIG.orgName}です。
「${p.title}」への投票を受け付けました。このメールは投票の控えです。大切に保管してください。

■ 件名　　　：${p.title}（${POLL_KIND[p.kind] || ""}）
■ 受付日時　：${new Date(castAtIso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
■ 受付番号　：${ballotId}
■ 受付ハッシュ：${receipt}
■ 連番　　　：${seq}
${p.anonymous ? "\n※ 無記名投票のため、投票内容はこのメールにも記録にも、あなたの名前と結びつけて保存していません。\n" : ""}
受付番号と受付ハッシュで、あなたの票が改ざんされずに集計に含まれているかを、会員サイトの「投票・アンケート」で確認できます。
▼ 会員サイト
${CONFIG.siteUrl}/member.html#votes/${p.id}
${signature()}`
  }];
}

// ---------- 締切で投票の受付を自動終了（委員会へ） ----------
function pollAutoClosed({ poll: p }) {
  return [{
    to: CONFIG.notifyTo,
    subject: `【投票・アンケート】受付を終了しました：${p.title}`,
    text:
`締切（${pollWhen(p.closesAt)}）を過ぎたため、次の投票・アンケートの受付を自動で終了しました。
管理画面で結果を確認し、「集計を確定」してください（確定すると結果が封印され、変更できなくなります）。

■ 件名　：${p.title}（${POLL_KIND[p.kind] || ""}）
■ 投票数：${p.voteCount || 0} 票

▼ 管理画面
${CONFIG.siteUrl}/admin.html#polls/${p.id}
`
  }];
}

module.exports = {CONFIG, memberApplied, memberApproved, memberRejected, contactReceived, adminInvited, consentSigned, reviewRequest, reviewResult , signatureRewriteRequested, signatureRewriteAllowed , typeChangeRequested, typeChangeDecided , contactAiReply, passwordResetByAi, contactAiNotify, contactStaffReply , ticketReplyToCustomer, ticketToStaff , ticketTransferred , loginGuideByAi , eventRsvpMail, memberNotice, pollOpened, voteReceipt, pollAutoClosed , mfaCode };