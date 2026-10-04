# 普賢アーカイブ運営委員会 公式サイト

普賢アーカイブ運営委員会（運営団体）の公式サイトです。HTML / CSS / JavaScript だけで作られた静的サイトで、お知らせ・行事・お問い合わせのデータは Firebase（Firestore）に保存されます。

※「普賢アーカイブ」本体は別のウェブサイトです。このサイトからはリンクで案内します（URL は `assets/js/common.js` の `archiveUrl`）。

## ファイル構成

```
index.html        トップページ（スライダー・News・Discover・普賢アーカイブ紹介・行事）
about.html        委員会について（概要・挨拶・名簿・規程・沿革）※HTMLを直接編集
news.html         お知らせ一覧／詳細（news.html?id=xxx）
archive.html      普賢アーカイブについて（紹介ページ・外部サイトへのリンク）※HTMLを直接編集
events.html       行事・イベント
contact.html      資料提供・お問い合わせフォーム（Firestore の contacts に保存）
join.html         入会案内（会員特典・会員種別・入会の流れ・オンライン申込・FAQ）
member-login.html 会員ログイン（パスワード再設定つき）
member.html       会員サイト（ダッシュボード・お知らせ・行事参加登録・資料室・会員証・プロフィール）
admin.html        管理画面（お知らせ・行事・会員の承認・会員向けコンテンツの管理）
sitemap.html / privacy.html

assets/css/style.css         デザイン全体（先頭の :root で色を変更可能）
assets/js/common.js          ヘッダー・フッター・メニュー（全ページ共通）
assets/js/firebase-config.js Firebase の接続設定
assets/js/db.js              Firestore の読み書き
assets/js/render.js          行事などの表示パーツ
assets/css/member.css        入会案内・会員サイトのデザイン（黒×金。先頭の :root で色を変更可能）
assets/js/member-api.js      会員機能のデータ処理（会員種別 MEMBER_TYPES もここ）
assets/js/member.js          会員サイトの画面（メニューは ROUTES）
LOGO.png                     ロゴ（ヘッダー・ファビコン・紹介ブロックで使用）
assets/js/sample-data.js     Firebase 未設定時のサンプルデータ
firestore.rules              Firestore セキュリティルール
firebase.json                Firebase Hosting 設定
```

## よくある変更

| やりたいこと | 編集する場所 |
|---|---|
| メニュー項目・フッターの住所/メール | `assets/js/common.js` の `SITE` と `NAV` |
| 普賢アーカイブ（別サイト）のURL | `assets/js/common.js` の `SITE.archiveUrl`（全ページのリンクに反映） |
| ロゴ | `LOGO.png` を同じ名前で差し替え |
| サイトの色 | `assets/css/style.css` 先頭の `:root` |
| トップのスライド文言・画像 | `index.html` の `<div class="slider">` 内 |
| 委員名簿・規程などの文章 | `about.html` を直接編集 |
| お知らせ・行事の追加 | `admin.html`（管理画面）から。Firebase コンソールで直接追加することもできます |
| 管理画面の入力項目を増やす | `admin.html` の `SCHEMA` |
| 会員種別（入会金・年会費は無料） | `join.html` の「会員種別」、`assets/js/member-api.js` の `MEMBER_TYPES`、`firestore.rules` の type 一覧 |
| 会員サイトのメニュー | `assets/js/member.js` の `ROUTES` |

新しいページを作るときは `privacy.html` をコピーして、`<main>` の中身を書き換えるのが簡単です。

## Firebase の初期設定（最初に1回だけ）

1. **Firestore Database** を作成する（Firebase コンソール > 構築 > Firestore Database）。※ 2026-10-04 に東京リージョン（asia-northeast1）で作成済み
2. **Authentication** で「メール / パスワード」を有効にし、ユーザー > 「ユーザーを追加」で管理者アカウントを作成する。
3. 作成したユーザーの **UID** をコピーし、Firestore に `admins` コレクションを作成して、**ドキュメントID = UID** のドキュメントを追加する（フィールドは `name: "管理者名"` など何でも可）。
4. セキュリティルールを反映する。Firebase コンソールの Firestore > ルール に `firestore.rules` の中身を貼り付けて公開するか、CLI で `firebase deploy --only firestore:rules`。 ※ 作成済み。`firestore.rules` を変更したときだけ再実行してください

> `admins` に登録されていないアカウントでは、ログインしても書き込めません（apiKey は公開されるため、この仕組みで守っています）。

## 管理者・オーナー

- **オーナー**：yuya.ikr@gmail.com（`admins` の role が `owner`）。管理画面の「管理者（オーナー専用）」タブで、管理者の **招待** と **解除** ができます。オーナーは解除できません。
- **管理者の追加方法**：オーナーがメールアドレスとお名前を入力して「招待する」→ 招待された方に管理画面のURLを伝える → その方が招待されたメールアドレスで登録・ログイン（Google ログインなら即完了、メールとパスワードの場合は確認メールのリンクを開く）→ 自動で管理者になります。
- 管理者を増やせるのはオーナーだけです（セキュリティルールで制限）。

## Google ログイン

会員ログイン・管理画面・入会申込で「Googleでログイン」が使えます。**Firebase コンソール > Authentication > ログイン方法 で「Google」を有効にしてください。** 独自ドメインで公開する場合は、Authentication > 設定 > 承認済みドメイン にそのドメインを追加してください。

## Firestore のデータ形式

| コレクション | フィールド |
|---|---|
| `news` | `title`, `date`（"2026-10-01" 形式の文字列）, `category`（`topics` または `kaikoku`）, `important`（true/false）, `body`, `url` |
| `events` | `title`, `date`（"YYYY-MM-DD"）, `place`, `description`, `url` |
| `contacts` | `subject`, `name`, `email`, `message`, `createdAt`（自動） |
| `members` | ドキュメントID = 会員の UID。`name`, `kana`, `email`, `type`（regular/student）, `status`（pending/active/suspended/rejected）, `memberNo`, `approvedAt`, `approvedBy`（承認した管理者の UID）, `validUntil`（任意） など |
| `member_news` | `title`, `date`, `body`, `important` |
| `member_docs` | `title`, `date`, `category`, `description`, `url` |
| `rsvps` | 行事の参加登録。ID = 行事ID_会員UID |
| `admins` | 管理者。ID = UID。`role`（owner/admin）, `email`, `name`, `invitedBy`, `createdAt` |
| `admin_invites` | 管理者への招待。ID = 小文字のメールアドレス |

## 会員機能の流れ

1. 入会希望者が `join.html` から申込 → アカウントが作成され、`members` に「審査中」で登録されます。
2. **委員会承認制**です。管理画面の「会員」タブで **承認** を押すと、会員番号（FA-年-連番）・承認日・承認者が記録されます。**否認** も選べます。会員の状態はこれらのボタンでのみ変更でき、本人が自分を承認することはセキュリティルール上できません。入会金・年会費はなく、会員資格に期限はありません（必要なら会員ごとに有効期限を設定可能）。
3. 承認された会員は `member.html` で会員サイトを利用できます（審査中の間は進行状況が表示されます）。
4. 会員向けのお知らせ・資料は管理画面の「会員向けお知らせ」「会員限定資料」タブから登録します。資料ファイルは Google ドライブなどに置き、その URL を登録してください。
5. 行事の参加登録者は、管理画面の「行事」タブに人数と氏名が表示されます。

会員サイトの操作：`Ctrl + K`（Mac は `⌘ + K`）で検索・ページ移動、`1`〜`6` キーでページ切替、`/` キーで検索欄へ移動できます。

## 表示確認（ローカル）

JavaScript モジュールを使っているため、HTML ファイルをダブルクリックで開くとデータが読み込まれません。次のいずれかでローカルサーバーを起動してください。

- VS Code の拡張機能「Live Server」で `index.html` を開く
- `npx serve .` を実行し、表示された URL を開く
- Firebase CLI: `firebase serve`

## 公開（Firebase Hosting）

```
npm install -g firebase-tools
firebase login
firebase use fugen-archive-official
firebase deploy
```
