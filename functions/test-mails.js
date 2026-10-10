// メール文面の確認用（実際には送信しません）： npm test
const mails = require("./mails");

const member = {
  name: "普賢 太郎", kana: "フゲン タロウ", email: "taro@example.com", type: "regular",
  joinReason: "普賢岳ネットワーク（普賢ネット）からの参加", referrer: "普賢 花子",
  affiliation: "○○大学", message: "記録の継承に協力したいです。",
  status: "pending", createdAt: new Date(), memberNo: "FA-2026-0001"
};
const contact = { subject: "資料提供について", name: "山田 花子", email: "hanako@example.com", message: "写真を提供できます。", createdAt: new Date() };
const invite = { email: "new-admin@example.com", name: "新しい管理者" };

const all = [
  ["入会申込", mails.memberApplied(member)],
  ["承認", mails.memberApproved(member)],
  ["否認", mails.memberRejected(member)],
  ["お問い合わせ", mails.contactReceived(contact)],
  ["管理者招待", mails.adminInvited(invite)]
];
let count = 0;
for (const [label, list] of all) {
  for (const m of list) {
    count++;
    if (!m.to || !m.subject || !m.text) throw new Error(`${label}: 宛先・件名・本文のいずれかが空です`);
    if (/undefined|null|\[object/.test(m.subject + m.text)) throw new Error(`${label}: 本文に undefined などが含まれています`);
    console.log(`\n========== ${label} ==========\n宛先：${m.to}${m.replyTo ? `（返信先：${m.replyTo}）` : ""}\n件名：${m.subject}\n${m.text}`);
  }
}
// 自動返信に入力内容（名前・本文）が含まれていないこと
const autoReply = mails.contactReceived(contact)[1].text;
if (autoReply.includes(contact.name) || autoReply.includes(contact.message)) throw new Error("自動返信に入力内容が含まれています");
console.log(`\nOK：${count} 通の文面を確認しました`);
