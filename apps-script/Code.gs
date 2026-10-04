/**
 * 普賢アーカイブ運営委員会：メール送信用 Google Apps Script
 *
 * Cloud Functions（functions/index.js）から呼び出され、
 * このスクリプトを作成した Google アカウントの Gmail からメールを送信します。
 *
 * ■ 設置手順（README の「メール送信」も参照）
 *  1. 送信に使う Gmail アカウントで https://script.google.com を開き「新しいプロジェクト」
 *  2. このファイルの内容をすべて貼り付けて保存
 *  3. 関数「setup」を選んで ▶実行 → 権限を許可 → 実行ログに表示される TOKEN を控える
 *  4. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *     → 表示される「ウェブアプリの URL」を控える
 *  5. TOKEN と URL を Firebase に登録（README 参照）
 *
 * ※ 無料の Gmail アカウントは 1 日あたり約 100 通まで送信できます。
 */

// 差出人として表示される名前
const ORG_NAME = "普賢アーカイブ運営委員会";
// 1 回の呼び出しで送れる最大通数（悪用防止）
const MAX_PER_REQUEST = 5;

/** 初回に 1 回だけ実行：合言葉（TOKEN）を作成して表示します */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty("TOKEN")) {
    props.setProperty("TOKEN", Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, ""));
  }
  Logger.log("TOKEN（Firebase に MAIL_TOKEN として登録してください）: " + props.getProperty("TOKEN"));
  Logger.log("本日あと送信できる通数: " + MailApp.getRemainingDailyQuota());
}

/** Cloud Functions からの送信依頼を受け取る */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty("TOKEN");
    if (!token || body.token !== token) return json_({ ok: false, error: "unauthorized" });

    const mails = Array.isArray(body.mails) ? body.mails : [];
    if (mails.length === 0 || mails.length > MAX_PER_REQUEST) return json_({ ok: false, error: "invalid mails" });

    const results = mails.map(function (m) {
      try {
        const options = { to: String(m.to), subject: String(m.subject), body: String(m.text), name: ORG_NAME };
        if (m.replyTo) options.replyTo = String(m.replyTo);
        MailApp.sendEmail(options);
        return { to: m.to, ok: true };
      } catch (err) {
        return { to: m.to, ok: false, error: String(err) };
      }
    });
    return json_({ ok: true, results: results, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
