/**
 * Split reply content for WeCom (企业微信) push API.
 * Chunks are sent sequentially so the user receives content in time (≤1 min goal).
 *
 * Rules:
 * - Prefer markdown_v2 when content contains tables (supports table rendering per API 100285).
 * - Else markdown when content looks like markdown (max 4096 bytes); else text (2048 bytes).
 * - Split by paragraphs; do NOT split tables or lists (keep as single blocks).
 *
 * markdown_v2: content ≤4096 bytes UTF-8; does not support font color or @member.
 * @see https://developer.work.weixin.qq.com/document/path/100285 应用推送 (markdown_v2 类型支持标题/列表/引用/链接/代码/表格)
 * @see 群机器人 webhook: markdown/markdown_v2 4096, text 2048; 20条/分钟
 */

const MARKDOWN_MAX_BYTES = 4096;
const TEXT_MAX_BYTES = 2048;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** True if line looks like a list item (ordered or unordered). */
function isListLine(line: string): boolean {
  const t = line.trimStart();
  return (
    /^[-*]\s/.test(t) ||
    /^\d+\.\s/.test(t) ||
    /^>\s/.test(t)
  );
}

/** True if line looks like a table row (contains at least two |). */
function isTableLine(line: string): boolean {
  const pipes = (line.match(/\|/g) || []).length;
  return pipes >= 2;
}

/** True if block has markdown that WeCom supports (# ** ` []( > <font). */
function looksLikeMarkdown(block: string): boolean {
  return (
    /#\s/.test(block) ||
    /\*\*[^*]+\*\*/.test(block) ||
    /`[^`]+`/.test(block) ||
    /\[[^\]]+\]\([^)]+\)/.test(block) ||
    /^>\s/m.test(block) ||
    /<font\s+color=/.test(block)
  );
}

/** True if block contains a markdown table (line with at least two |). Prefer markdown_v2 for table support. */
function containsTable(block: string): boolean {
  return block.split(/\r?\n/).some((line) => isTableLine(line));
}

/**
 * Split content into logical blocks: paragraphs, tables (kept whole), lists (kept whole).
 * Returns array of non-empty trimmed blocks.
 */
function splitIntoBlocks(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let inTable = false;
  let inList = false;

  const flush = () => {
    const s = current.join('\n').trim();
    if (s) blocks.push(s);
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1];
    const lineIsTable = isTableLine(line);
    const lineIsList = isListLine(line);

    if (inTable) {
      current.push(line);
      if (!lineIsTable) {
        inTable = false;
        flush();
      }
      continue;
    }

    if (lineIsTable) {
      flush();
      inTable = true;
      current.push(line);
      continue;
    }

    if (inList) {
      if (line.trim() === '' || !lineIsList) {
        inList = false;
        flush();
        if (line.trim() !== '') {
          current.push(line);
        }
      } else {
        current.push(line);
      }
      continue;
    }

    if (lineIsList) {
      flush();
      inList = true;
      current.push(line);
      continue;
    }

    // Paragraph: blank line ends it
    if (line.trim() === '') {
      flush();
    } else {
      current.push(line);
    }
  }

  flush();
  return blocks;
}

/**
 * Merge small consecutive blocks until just under maxBytes, to reduce number of messages.
 * Never merges across table/list boundaries (we already have one block per table/list).
 */
function mergeBlocksToSize(blocks: string[], maxBytes: number): string[] {
  const result: string[] = [];
  let acc = '';

  for (const block of blocks) {
    const blockWithSep = acc ? acc + '\n\n' + block : block;
    if (byteLength(blockWithSep) <= maxBytes) {
      acc = blockWithSep;
    } else {
      if (acc) result.push(acc);
      if (byteLength(block) <= maxBytes) {
        acc = block;
      } else {
        // Single block too large: split by size
        const chunkSize = Math.floor(maxBytes / 2); // safe for UTF-8
        for (let i = 0; i < block.length; i += chunkSize) {
          result.push(block.slice(i, i + chunkSize));
        }
        acc = '';
      }
    }
  }
  if (acc) result.push(acc);
  return result;
}

export interface WecomChunk {
  content: string;
  useMarkdown: boolean;
  /** Prefer markdown_v2 when true (supports tables per WeCom API 100285). */
  useMarkdownV2: boolean;
}

/**
 * Split reply into chunks suitable for WeCom webhook.
 * - Prefer markdown_v2 when content has tables (API 100285); else markdown when content looks like markdown; else text.
 * - Tables and lists are kept as single chunks (not split).
 */
export function splitReplyForWecom(reply: string): WecomChunk[] {
  const blocks = splitIntoBlocks(reply);
  const markdownChunks = mergeBlocksToSize(blocks, MARKDOWN_MAX_BYTES);
  const result: WecomChunk[] = [];

  for (const chunk of markdownChunks) {
    const useMarkdown = looksLikeMarkdown(chunk) && byteLength(chunk) <= MARKDOWN_MAX_BYTES;
    const useMarkdownV2 = useMarkdown && containsTable(chunk);
    if (useMarkdown) {
      result.push({ content: chunk, useMarkdown: true, useMarkdownV2 });
    } else {
      // Split by TEXT_MAX_BYTES (UTF-8) if needed
      if (byteLength(chunk) <= TEXT_MAX_BYTES) {
        result.push({ content: chunk, useMarkdown: false, useMarkdownV2: false });
      } else {
        let start = 0;
        while (start < chunk.length) {
          let end = start;
          while (end < chunk.length && byteLength(chunk.slice(start, end + 1)) <= TEXT_MAX_BYTES) end++;
          if (end === start) end = start + 1; // at least one char
          result.push({ content: chunk.slice(start, end), useMarkdown: false, useMarkdownV2: false });
          start = end;
        }
      }
    }
  }

  return result;
}
