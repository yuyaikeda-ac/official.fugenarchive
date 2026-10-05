// ============================================================
//  会員限定資料のファイル（Firebase Storage の member_docs/）
//  ・アップロード・削除は管理者のみ、閲覧は有効な会員と管理者のみ（storage.rules）
//  ・Firestore の member_docs には保存場所（filePath）とファイル名・大きさ・種類だけを保存し、
//    会員が開くときに、その場で閲覧用の URL を発行する（権限はそのたびに確認される）
// ============================================================
import {
  getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { app } from "./db.js";

// ★ 1 ファイルの上限（storage.rules と揃える）
export const MAX_DOC_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

const storage = () => getStorage(app);

/** ファイルの種類（表示・開き方の切り替えに使用） */
export function kindOf(type = "", name = "") {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (type.startsWith("video/") || ["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  if (type.startsWith("audio/") || ["mp3", "m4a", "wav", "aac", "ogg"].includes(ext)) return "audio";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  return "file";
}
export const KIND_LABEL = { video: "動画", audio: "音声", image: "画像", pdf: "PDF", file: "ファイル" };

/** 拡張子（バッジ表示用） */
export const extOf = (name = "") => { const m = /\.([a-z0-9]{1,5})$/i.exec(name); return m ? m[1].toUpperCase() : "FILE"; };

/** 1.2 MB などの表示 */
export function fmtSize(n) {
  if (!n && n !== 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

/**
 * ファイルをアップロード（管理者）
 * @param onProgress (0〜1) 進み具合
 * @returns { filePath, fileName, fileSize, fileType }
 */
export function uploadDocFile(file, onProgress) {
  if (file.size > MAX_DOC_BYTES) return Promise.reject(new Error(`ファイルが大きすぎます（${fmtSize(MAX_DOC_BYTES)} まで）。`));
  const safe = file.name.replace(/[^\w.\-ぁ-んァ-ヶ一-龠ー]/g, "_").slice(-80);
  const filePath = `member_docs/${new Date().getFullYear()}/${crypto.randomUUID()}-${safe}`;
  const kind = kindOf(file.type, file.name);
  const disposition = `${kind === "file" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  const task = uploadBytesResumable(ref(storage(), filePath), file, {
    contentType: file.type || "application/octet-stream",
    contentDisposition: disposition,
    cacheControl: "private, max-age=3600"
  });
  return new Promise((resolve, reject) => {
    task.on("state_changed",
      (s) => onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
      (err) => reject(err),
      () => resolve({ filePath, fileName: file.name, fileSize: file.size, fileType: file.type || "" }));
  });
}

/** ファイルを削除（管理者）。見つからない場合は無視 */
export async function deleteDocFile(filePath) {
  if (!filePath) return;
  try { await deleteObject(ref(storage(), filePath)); }
  catch (e) { if (e.code !== "storage/object-not-found") throw e; }
}

/** 閲覧用の URL（有効な会員・管理者のみ取得できる） */
export const docFileUrl = (filePath) => getDownloadURL(ref(storage(), filePath));
