// 简历文件 -> 纯文本。支持 PDF（pdf.js）、DOCX（fflate 解压读 document.xml）、
// TXT/MD/JSON（直接读）。均在扩展页面上下文运行（同源，可加载打包的 worker）。
import { unzipSync, strFromU8 } from '../vendor/fflate.module.js';

// 主入口：File -> { text, meta }
export async function parseResumeFile(file) {
  const name = (file.name || '').toLowerCase();
  const type = file.type || '';
  if (name.endsWith('.pdf') || type === 'application/pdf') {
    return { text: await parsePdf(file), meta: { kind: 'pdf' } };
  }
  if (name.endsWith('.docx') || type.includes('officedocument.wordprocessingml')) {
    return { text: await parseDocx(file), meta: { kind: 'docx' } };
  }
  if (name.endsWith('.doc')) {
    throw new Error('旧版 .doc 格式不支持，请另存为 .docx 或 PDF，或直接粘贴文本');
  }
  // 纯文本类
  const text = await file.text();
  return { text, meta: { kind: 'text' } };
}

// —— PDF ——
let pdfLibPromise = null;
async function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import('../vendor/pdf.min.mjs').then((mod) => {
      const lib = mod.default || mod;
      // worker 指向打包的同源文件
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdf.worker.min.mjs');
      return lib;
    });
  }
  return pdfLibPromise;
}

async function parsePdf(file) {
  const lib = await loadPdfLib();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // 依 y 坐标粗略还原换行
    let lastY = null;
    let line = '';
    const lines = [];
    for (const item of content.items) {
      const s = item.str;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
        lines.push(line);
        line = '';
      }
      line += s;
      lastY = y;
    }
    if (line) lines.push(line);
    pages.push(lines.join('\n'));
  }
  await doc.destroy();
  const text = pages.join('\n\n').trim();
  if (!text) throw new Error('未能从 PDF 提取到文本（可能是扫描件/图片型 PDF，请粘贴文本）');
  return text;
}

// —— DOCX（解压 + 读 word/document.xml，剥标签） ——
async function parseDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let files;
  try {
    files = unzipSync(buf);
  } catch (e) {
    throw new Error('DOCX 解析失败，请另存为 PDF 或直接粘贴文本');
  }
  const docXml = files['word/document.xml'];
  if (!docXml) throw new Error('DOCX 结构异常（缺 document.xml），请粘贴文本');
  const xml = strFromU8(docXml);
  // 段落 </w:p> 转换行，制表 <w:tab/> 转空格，其余标签去除
  const text = xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('DOCX 中未提取到文本，请粘贴文本');
  return text;
}
