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

module.exports = { CONFIG, memberApplied, memberApproved, memberRejected, contactReceived, adminInvited };
