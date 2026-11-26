import net from 'node:net';
import { safeFetchBinary } from '../llm/safe-fetch.js';
import { resolveFileSegmentUrl } from './audio-transcribe.js';

const ATTACHMENT_LIMIT = 16 * 1024 * 1024;
const MATERIAL_LIMIT = 8192;
const imageMaterial = /\.(?:png|jpe?g)$/i;

export function containerAllowed(config, turn) {
  const owner = String(config.admin?.ownerUin || '').trim();
  if (!/^\d+$/.test(owner) || config.linuxContainer?.enabled !== true || turn.proactive || turn.external) return false;
  if (!turn.senders.length || !turn.senders.every(id => String(id) === owner)) return false;
  return turn.chatKey === `private:${owner}`
    || (/^group:\d+$/.test(turn.chatKey) && turn.directed && config.linuxContainer.allowGroup === true);
}

export function containerRequest(request, signal, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: '/run/qq-agent-linux-container.sock', signal });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(45000, () => socket.destroy(new Error('容器响应超时，执行结果未知')));
    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
      if (payload) socket.write(payload);
    });
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 524288) socket.destroy(new Error('容器响应过大'));
    });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

const quoteShell = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function workspaceDirectoryAllowed(directory, requestText) {
  if (typeof directory !== 'string' || directory.length > 180 ||
      !/^\/workspace\/(?:[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\/)*[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u.test(directory)) return false;
  const requestedPaths = String(requestText ?? '').match(/\/workspace\/[^\s"'，。；、）)]+/gu) ?? [];
  return requestedPaths.includes(directory) ||
    String(requestText ?? '').includes('"' + directory + '"') ||
    String(requestText ?? '').includes('「' + directory + '」');
}

export function workspaceSearchCommand(directory, keywords, requestText) {
  if (!workspaceDirectoryAllowed(directory, requestText) || !Array.isArray(keywords) || keywords.length < 1 || keywords.length > 5 ||
      keywords.some((word) => typeof word !== 'string' || !/^[\p{L}\p{N}_ .-]{1,40}$/u.test(word) || !word.trim())) return null;
  const filters = keywords.map((word) => '-iname ' + quoteShell('*' + word.trim() + '*')).join(' -o ');
  return 'set -eu; dir=$(realpath -e -- ' + quoteShell(directory) + '); '
    + 'test "$dir" = ' + quoteShell(directory) + '; test -d "$dir"; '
    + 'find -P "$dir" -maxdepth 3 -mindepth 1 \\( -type d -name ".*" -prune \\) -o '
    + '\\( -type f ! -name ".*" \\( ' + filters + ' \\) -printf "%T@\\t%s\\t%p\\0" \\) '
    + '| LC_ALL=C sort -z -k1,1nr --buffer-size=8M | head -z -n 26';
}

export function parseWorkspaceSearch(output) {
  const records = output.split('\0').slice(0, -1);
  const candidates = [];
  for (const record of records) {
    const match = /^(-?\d+(?:\.\d+)?)\t(\d+)\t(\/workspace\/[\s\S]+)$/.exec(record);
    if (!match) continue;
    const [, modified, bytes, path] = match;
    const date = new Date(Number(modified) * 1000);
    const size = Number(bytes);
    if (!Number.isFinite(date.getTime()) || !Number.isSafeInteger(size)) continue;
    candidates.push({ path, modifiedAt: date.toISOString(), bytes: size });
  }
  candidates.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
  const files = candidates.slice(0, 25);
  return { paths: files.map(file => file.path), files, truncated: candidates.length > 25 || output.endsWith('[输出已截断]') };
}

export function workspaceMaterialCommand(directory, file, requestText, { scanPdf = false } = {}) {
  if (!workspaceDirectoryAllowed(directory, requestText) || typeof file !== 'string' ||
      Buffer.byteLength(file) > 1024 || !file.startsWith(directory + '/') ||
      !/\.(?:txt|md|csv|tsv|pdf|png|jpe?g)$/i.test(file) || /[\x00-\x1f\x7f]/.test(file)) return null;
  const parts = file.slice(directory.length + 1).split('/');
  if (parts.length > 3 || parts.some((part) => !part || part.startsWith('.'))) return null;
  const quoted = quoteShell(file);
  const verified = 'set -eu; file=$(realpath -e -- ' + quoted + '); test "$file" = ' + quoted + '; test -f "$file"; ';
  if (scanPdf) {
    if (!/\.pdf$/i.test(file)) return null;
    return verified + 'command -v pdftoppm >/dev/null && command -v tesseract >/dev/null || exit 69; '
      + 'test "$(stat -c %s -- "$file")" -le ' + ATTACHMENT_LIMIT + ' || exit 65; '
      + 'tmp=$(mktemp -d); trap \'rm -f -- "$tmp/page.png" "$tmp/text"; rmdir -- "$tmp"\' EXIT; '
      + 'timeout 8s pdftoppm -f 1 -l 1 -scale-to 2400 -singlefile -png "$file" "$tmp/page" || exit 66; '
      + '(ulimit -f 2048; export OMP_THREAD_LIMIT=1; timeout 12s tesseract "$tmp/page.png" stdout -l chi_sim+eng > "$tmp/text") || exit 66; '
      + 'head -c ' + (MATERIAL_LIMIT + 1) + ' -- "$tmp/text"';
  }
  if (/\.pdf$/i.test(file)) {
    return verified + 'command -v pdftotext >/dev/null || exit 69; '
      + 'test "$(stat -c %s -- "$file")" -le ' + ATTACHMENT_LIMIT + ' || exit 65; '
      + 'tmp=$(mktemp); trap \'rm -f -- "$tmp"\' EXIT; '
      + '(ulimit -f 2048; timeout 8s pdftotext -f 1 -l 8 -layout -enc UTF-8 "$file" "$tmp") || exit 66; '
      + 'head -c ' + (MATERIAL_LIMIT + 1) + ' -- "$tmp"';
  }
  if (imageMaterial.test(file)) {
    return verified + 'command -v tesseract >/dev/null || exit 69; '
      + 'test "$(stat -c %s -- "$file")" -le ' + ATTACHMENT_LIMIT + ' || exit 65; '
      + 'tmp=$(mktemp); trap \'rm -f -- "$tmp"\' EXIT; '
      + '(ulimit -f 2048; export OMP_THREAD_LIMIT=1; timeout 12s tesseract "$file" stdout -l chi_sim+eng > "$tmp") || exit 66; '
      + 'head -c ' + (MATERIAL_LIMIT + 1) + ' -- "$tmp"';
  }
  return verified + 'head -c ' + (MATERIAL_LIMIT + 1) + ' -- "$file"';
}

export function containerTools(getConfig, turn) {
  if (!containerAllowed(getConfig(), turn)) return [];
  const tools = [{
    name: 'linux_shell',
    description: '在管理员的持久 Linux 容器 /workspace 中以 root 运行 shell 命令，可访问公网。QQ 附件在 inbox/ 下。仅按管理员本轮指示操作。超时或连接中断后先检查状态。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (ctx, { command }) => {
      if (!containerAllowed(getConfig(), turn)) return { content: '容器访问已关闭', isError: true };
      if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 8192) return { content: '命令须为 1–8192 字节', isError: true };
      const result = await containerRequest({ action: 'exec', command }, ctx.signal);
      return { content: `退出码 ${result.code}\n${result.output}`, isError: result.code !== 0 };
    }
  }];
  const privateOwner = turn.chatKey === 'private:' + String(getConfig().admin?.ownerUin ?? '').trim();
  if (privateOwner) tools.push({
    name: 'linux_find_workspace_files',
    description: '在管理员私聊本轮明确指定的 /workspace 子目录里按文件名查资料。输入原话里的目录和 1–5 个关键词。返回候选路径、大小和修改时间。修改时间可用来排序候选，文件内容须另行读取。',
    parameters: { type: 'object', required: ['directory', 'keywords'], properties: {
      directory: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }
    } },
    execute: async (ctx, { directory, keywords }) => {
      if (!containerAllowed(getConfig(), turn)) return { content: '容器访问已关闭', isError: true };
      const request = ctx.triggerEntries?.filter((entry) => !entry.self).at(-1);
      const command = workspaceSearchCommand(directory, keywords, request?.text);
      if (!command) return { content: '请使用管理员本轮明确给出的 /workspace 子目录和有效文件名关键词', isError: true };
      try {
        const result = await containerRequest({ action: 'exec', command }, ctx.signal);
        if (result.code !== 0) return { content: '目录不存在或无法读取', isError: true };
        return { content: JSON.stringify(parseWorkspaceSearch(result.output)) };
      } catch {
        return { content: '容器文件搜索未完成', isError: true };
      }
    }
  });
  if (privateOwner) tools.push({
    name: 'linux_read_workspace_material',
    description: '读取管理员指定目录里的文本资料、PDF 或 PNG/JPEG。用 file 读一份，或用 files 同时比较至多两份。每份最多返回 8 KiB。OCR 可能误读金额和编号，引用时附文件路径。',
    parameters: { type: 'object', required: ['directory'], properties: {
      directory: { type: 'string' }, file: { type: 'string' },
      files: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } }
    } },
    execute: async (ctx, { directory, file, files }) => {
      if (!containerAllowed(getConfig(), turn)) return { content: '容器访问已关闭', isError: true };
      const request = ctx.triggerEntries?.filter((entry) => !entry?.self).at(-1);
      const validBatch = Array.isArray(files) && files.length >= 1 && files.length <= 2 && file === undefined;
      if (files !== undefined && !validBatch) return { content: '请提供一份文件，或提交最多两份候选文件', isError: true, reportIncident: false };
      const paths = Array.isArray(files) ? [...new Set(files)] : [file];
      const reads = paths.map(path => ({ path, command: workspaceMaterialCommand(directory, path, request?.text) }));
      if (reads.some(item => !item.command)) return {
        content: '请使用本轮明确指定的 /workspace 子目录及其中支持的资料', isError: true, reportIncident: false
      };
      const results = await Promise.all(reads.map(({ path, command }) => readMaterial(ctx, directory, path, request?.text, command)));
      if (files === undefined) return results[0];
      return { content: JSON.stringify({ files: results.map((result, index) => result.isError
        ? { file: paths[index], error: result.content }
        : JSON.parse(result.content)) }) };
    }
  });
  async function readMaterial(ctx, directory, file, request, command) {
  try {
    let result = await containerRequest({ action: 'exec', command }, ctx.signal);
    const pdf = /\.pdf$/i.test(file);
    const image = imageMaterial.test(file);
    if (pdf && result.code === 69) return { content: '容器未安装 PDF 文字提取工具', isError: true, reportIncident: false };
    if (pdf && result.code !== 0) return { content: 'PDF 无法提取文字或超过读取限制', isError: true, reportIncident: false };
    const scan = pdf && !result.output.trim();
    if (scan) {
      const scanCommand = workspaceMaterialCommand(directory, file, request, { scanPdf: true });
      result = await containerRequest({ action: 'exec', command: scanCommand }, ctx.signal);
    }
    const ocr = scan || image;
    if (ocr && result.code === 69) return { content: '容器缺少 OCR 所需工具', isError: true, reportIncident: false };
    if (ocr && result.code !== 0) return { content: 'OCR 失败或超过读取限制', isError: true, reportIncident: false };
    if (result.code !== 0 || result.output.includes('\0')) {
      return { content: '文件不可读取或不是文本资料', isError: true };
    }
    const text = Buffer.from(result.output);
    const truncated = text.length > MATERIAL_LIMIT;
    const excerpt = text.subarray(0, MATERIAL_LIMIT).toString('utf8').replace(/\uFFFD$/u, '');
    if (ocr && !excerpt.trim()) return { content: 'OCR 未识别到可读文字', isError: true, reportIncident: false };
    return { content: JSON.stringify({ file, excerpt, truncated, ...(pdf ? { pagesReadUpTo: scan ? 1 : 8 } : {}),
      ...(ocr ? { extraction: 'ocr', needsVerification: true } : {}) }) };
  } catch {
    return { content: '容器资料读取未完成', isError: true };
  }
  }
  if (turn.attachments?.length) tools.push({
    name: 'linux_import_qq_file',
    description: '把本轮 QQ 附件下载到容器 /workspace/inbox，单个文件最多 16 MiB。参数为附件序号，从 1 开始。可选附件：'
      + JSON.stringify(turn.attachments.map((file, index) => [index + 1, file.file])),
    parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
    execute: async (ctx, { index }) => {
      const attachment = Number.isInteger(index) ? turn.attachments[index - 1] : null;
      if (!attachment || !containerAllowed(getConfig(), turn)) return { content: '附件不可用', isError: true };
      const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(ctx.signal ? [ctx.signal] : [])]);
      try {
        const url = await resolveFileSegmentUrl(ctx, attachment, { signal }) || attachment.url;
        if (!url) return { content: 'QQ 协议端没有提供附件下载地址', isError: true };
        const { buffer } = await safeFetchBinary(url, ATTACHMENT_LIMIT, signal, { allowPrivate: false });
        if (!containerAllowed(getConfig(), turn)) return { content: '容器访问已关闭', isError: true };
        const name = attachment.file.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '_');
        const result = await containerRequest({ action: 'import', name, size: buffer.length }, signal, buffer);
        return { content: JSON.stringify(result) };
      } catch {
        return { content: '附件导入未确认。请检查文件是否过期、是否超过 16 MiB，以及容器是否运行。', isError: true };
      }
    }
  });
  return tools;
}
