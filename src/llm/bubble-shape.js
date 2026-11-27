// 拟人气泡整形：模型最好主动传数组，但不能指望它每次都这样。
// 这里把一段长回复按标点拆成 1–3 条气泡，保护代码块、URL、行内代码和常见颜文字；
// 已经分好的数组只做长度合并，不改变原有顺序。
const PLACEHOLDER = /\u0000(\d+)\u0000/g;
const HAS_PLACEHOLDER = /\u0000\d+\u0000/;

function protect(text) {
  const parts = [];
  const stash = (value) => `\u0000${parts.push(value) - 1}\u0000`;
  let out = String(text ?? '');
  out = out.replace(/^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\2[ \t]*(?=\r?$)/gm, (match) => stash(match));
  out = out.replace(/```[\s\S]*?```/g, (match) => stash(match));
  out = out.replace(/`[^`\n]+`/g, (match) => stash(match));
  out = out.replace(/https?:\/\/[^\s，。！？；、"')】]+/gi, (match) => stash(match));
  // 常见颜文字：括号内部不拆开（只保护短片段，避免把正常括号内容也吞掉）。
  out = out.replace(/[（(][^（）()\n\u0000]{1,16}[）)]/g, (match) => stash(match));
  return { text: out, parts };
}

function restore(text, parts) {
  return String(text ?? '').replace(PLACEHOLDER, (_match, index) => parts[Number(index)] ?? '');
}

function joinChunks(left, right, separator = '') {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a) return b;
  if (!b) return a;
  // 中文/标点结尾直接拼；英文单词之间补一个空格。
  const glue = separator || (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? ' ' : '');
  return `${a}${glue}${b}`;
}

/** 编号项连同下方的说明、公式和代码一起发送。 */
function numberedBubbles(message) {
  const { text, parts } = protect(message);
  const items = [...text.matchAll(/^[ \t]{0,3}(?:\*\*)?\d{1,3}(?:[.)．](?!\d)|[、）])(?=[ \t]*\S)/gm)];
  if (!items.length) return [];
  // 首项也可能紧接在开场白后面，如「有两个问题：1. ……」。
  const inlineFirst = /^[^\r\n]*?[:：][ \t]*(?:\*\*)?1(?:[.)．](?!\d)|[、）])(?=[ \t]*\S)/.test(text)
    && items[0].index > text.indexOf('\n')
    && /^[ \t]*(?:\*\*)?2(?:[.)．]|[、）])/.test(items[0][0]);
  if (items.length + Number(inlineFirst) < 2) return [];
  const starts = [0, ...items.slice(inlineFirst ? 0 : 1).map(item => item.index)];
  const count = Math.min(starts.length, 8);
  const bubbles = [];
  let from = 0;
  for (let remaining = count; remaining > 0; remaining--) {
    const to = from + Math.ceil((starts.length - from) / remaining);
    bubbles.push(restore(text.slice(starts[from], starts[to]), parts).trim());
    from = to;
  }
  return bubbles;
}

/** 按自然边界拆成待打包的片段。含代码/链接/颜文字的段落整段保留。 */
function chunksOf(message) {
  const { text: guarded, parts } = protect(message);
  const out = [];
  const paragraphs = guarded.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    // 占位符说明这段里有代码块、行内代码、URL 或短括号：整段发，不再按句子切。
    if (HAS_PLACEHOLDER.test(paragraph)) {
      out.push({ text: restore(paragraph, parts), keepAlone: true });
      continue;
    }
    const sentences = paragraph.split(/(?<=[。！？!?；;…])\s*/).map((piece) => piece.trim()).filter(Boolean);
    for (const sentence of sentences) {
      out.push({ text: sentence, keepAlone: false });
    }
  }
  return out;
}

/**
 * @param {string|string[]} messages 模型给的文本或数组
 * @param {{maxBubbles?: number, maxChars?: number, preserveCode?: boolean}} options maxChars 是合并片段的目标长度
 * @returns {string[]} 普通回复最多 maxBubbles 条，单段编号回复最多 8 条
 */
export function shapeBubbles(messages, { maxBubbles = 3, maxChars = 60 } = {}) {
  const list = (Array.isArray(messages) ? messages : [messages])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  if (!list.length) return [];
  const bubbleLimit = Math.max(1, Math.min(8, Math.round(Number(maxBubbles) || 3)));
  const charLimit = Math.max(10, Math.min(2000, Math.round(Number(maxChars) || 60)));
  if (list.length === 1) {
    const numbered = numberedBubbles(list[0]);
    if (numbered.length) return numbered;
  }
  // 模型已经分好条且条数在上限内，按原边界交给协议长度检查。
  if (list.length > 1 && list.length <= bubbleLimit) return list;
  if (list.length > 1 && list.every((item) => item.length <= charLimit)) {
    return [...list.slice(0, bubbleLimit - 1), joinChunks(list[bubbleLimit - 1], list.slice(bubbleLimit).join(''))];
  }

  const chunks = [];
  for (const message of list) chunks.push(...chunksOf(message));
  if (!chunks.length) return list.slice(0, bubbleLimit);

  const bubbles = [];
  for (const chunk of chunks) {
    const last = bubbles[bubbles.length - 1];
    const mergeable = last && !last.keepAlone && !chunk.keepAlone
      && joinChunks(last.text, chunk.text).length <= charLimit;
    if (mergeable) {
      bubbles[bubbles.length - 1] = { text: joinChunks(last.text, chunk.text), keepAlone: false };
    } else if (bubbles.length < bubbleLimit) {
      bubbles.push({ ...chunk });
    } else {
      // 上限优先：把剩余内容并进最后一条，宁可长一点，也不刷屏。
      // 代码块与正文之间用换行隔开，避免粘成一行看不出边界。
      const previous = bubbles[bubbles.length - 1];
      bubbles[bubbles.length - 1] = {
        text: joinChunks(previous.text, chunk.text, previous.keepAlone || chunk.keepAlone ? '\n' : ''),
        keepAlone: previous.keepAlone || chunk.keepAlone
      };
    }
  }
  return bubbles.map((bubble) => bubble.text.trim()).filter(Boolean).slice(0, bubbleLimit);
}
