// 字幕解析（1.0.2-r7 播放器字幕）：.srt / .vtt → 时间轴 cue 数组。
// 解析在纯前端完成（后端只负责读文件与编码转换），主窗口与 PiP 窗口共用。

export interface SubtitleCue {
  /** 开始时间（秒） */
  s: number;
  /** 结束时间（秒） */
  e: number;
  /** 字幕文本（多行合并，已去除常用标签） */
  text: string;
}

/** 时间戳 → 秒：srt 用 `HH:MM:SS,mmm`，vtt 用 `HH:MM:SS.mmm` */
function tsToSec(ts: string): number {
  const t = ts.trim().replace(",", ".");
  const parts = t.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return -1;
  let sec = 0;
  if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else sec = parts[0];
  return sec;
}

/** 清理文本：去掉 <i>/<b>/<font> 等标签与 ASS 风格 {\...} 控制码 */
function cleanText(line: string): string {
  return line
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 解析 .srt：序号 + 时间行（HH:MM:SS,mmm --> ...）+ 多行文本，空行分隔 */
export function parseSrt(text: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  // 按块切分：块之间以空行分隔（兼容 \r\n / \n）
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startRaw, endRaw] = timeLine.split("-->").map((s) => s.trim());
    const s = tsToSec(startRaw);
    const e = tsToSec(endRaw);
    if (s < 0 || e < 0 || e <= s) continue;
    // 文本 = 非序号、非时间行的行
    const textLines = lines.filter(
      (l) => !l.includes("-->") && !/^\d+$/.test(l)
    );
    if (!textLines.length) continue;
    const text = cleanText(textLines.join(" "));
    if (!text) continue;
    out.push({ s, e, text });
  }
  return out;
}

/** 解析 .vtt：WEBVTT 头 + 时间行（HH:MM:SS.mmm --> ...），可带 cue 设置 */
export function parseVtt(text: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  const body = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const blocks = body.split(/\n{2,}/);
  let first = true;
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    if (!lines.length || !lines[0]) continue;
    if (first && lines[0].toUpperCase().startsWith("WEBVTT")) {
      first = false;
      continue;
    }
    first = false;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startRaw, endRaw] = timeLine.split("-->").map((s) => s.trim());
    const s = tsToSec(startRaw);
    const e = tsToSec(endRaw);
    if (s < 0 || e < 0 || e <= s) continue;
    const textLines = lines.filter((l) => !l.includes("-->"));
    if (!textLines.length) continue;
    const text = cleanText(textLines.join(" "));
    if (!text) continue;
    out.push({ s, e, text });
  }
  return out;
}

/** 按扩展名自动选择解析器 */
export function parseSubtitle(text: string, kind: "srt" | "vtt"): SubtitleCue[] {
  return kind === "vtt" ? parseVtt(text) : parseSrt(text);
}

/** 查找当前时间命中的字幕（二分，cue 已按时间有序） */
export function cueAt(cues: SubtitleCue[], t: number): string | null {
  if (!cues.length || t < 0) return null;
  // 顺序查找即可（cue 数通常几百，每 250ms 一次无压力）；命中取最后一行文本
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (t >= c.s && t < c.e) return c.text;
    if (c.s > t) break;
  }
  return null;
}
