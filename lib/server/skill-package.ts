import { JSON_SCHEMA, load } from "js-yaml";
import { fromBufferPromise } from "yauzl";
import { z } from "zod";
import { skillZipLimit } from "@/lib/workbench";

const fileLimit = 256 * 1024;
const unpackedLimit = 5 * 1024 * 1024;
const maxFiles = 50;
const maxEntries = 100;
const textFile = /\.(md|txt|json|ya?ml|csv|tsv|xml|toml)$/i;
const sourceFile = /\.(py|pyw|sh|bash|zsh|fish|ps1|bat|cmd|[cm]?js|[cm]?ts|jsx|tsx|rb|lua|pl|php|r|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|scala|sql|awk|html?|css|scss|less|vue|svelte)$/i;
const buildFile = /^(makefile|gnumakefile|dockerfile|cmakelists\.txt)$/i;
const runtimeFile = /^(skill\.md|claude\.md|claude\.local\.md|mcp\.json|settings\.json|settings\.local\.json)$/i;
const dynamicCommand = /!\x60|\x60{3,}!|~{3,}!/;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const skillName = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const frontmatter = z.object({
  name: skillName,
  description: z.string().trim().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  version: z.union([z.string(), z.number()]).optional(),
  author: z.string().optional(),
  "allowed-tools": z.union([z.string(), z.array(z.string())]).optional(),
}).strict();

export type SkillBundle = {
  name: string;
  description: string;
  content: string;
  files: { path: string; content: string }[];
};

export class SkillUploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function parseSkillUpload(request: Request): Promise<SkillBundle> {
  if (request.headers.get("content-type") !== "application/zip" || !request.body) {
    throw new SkillUploadError("请选择一个 ZIP 压缩包。");
  }
  if (Number(request.headers.get("content-length")) > skillZipLimit) {
    throw new SkillUploadError("ZIP 压缩包大小不能超过 2 MB。", 413);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > skillZipLimit) {
        void reader.cancel().catch(() => undefined);
        throw new SkillUploadError("ZIP 压缩包大小不能超过 2 MB。", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return parseBundle(await readArchive(Buffer.concat(chunks, size)));
  } catch (error) {
    if (error instanceof SkillUploadError) throw error;
    throw new SkillUploadError("无法读取 ZIP 压缩包，请检查包格式及文件路径。");
  }
}

async function readArchive(bytes: Buffer) {
  const archive = await fromBufferPromise(bytes, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true,
  });
  const files = new Map<string, string>();
  const entries = new Map<string, boolean>();
  let total = 0;
  try {
    if (archive.entryCount > maxEntries) throw new SkillUploadError("ZIP 中的条目过多。", 413);
    for await (const entry of archive.eachEntry()) {
      const directory = entry.fileName.endsWith("/");
      const path = entry.fileName.replace(/\/$/, "").normalize("NFC");
      const parts = path.split("/");
      if (path.length > 240 || parts.some(part => !part || part === "." || part === ".."
        || /[\\:\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part))) {
        throw new SkillUploadError("ZIP 含有无效的文件路径。");
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || (directory && entry.uncompressedSize)) {
        throw new SkillUploadError(`${path} 必须是普通文件或目录。`);
      }
      const key = path.toLowerCase();
      if (entries.has(key)) throw new SkillUploadError(`ZIP 中存在重名条目 ${path}。`);
      entries.set(key, directory);
      if (parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store") continue;
      if (parts.some(part => part.startsWith("."))) {
        throw new SkillUploadError(`${path} 是隐藏文件或位于隐藏目录中。`);
      }
      if (directory) continue;
      if (!textFile.test(path) && !sourceFile.test(path) && !buildFile.test(parts.at(-1)!)) {
        throw new SkillUploadError(`${path} 不是支持的文本或源码文件。`);
      }
      total += entry.uncompressedSize;
      if (files.size >= maxFiles || total > unpackedLimit || entry.uncompressedSize > fileLimit) {
        throw new SkillUploadError(`${path} 超出了文件数量或解压大小限制。`, 413);
      }
      const chunks: Buffer[] = [];
      const stream = await archive.openReadStreamPromise(entry);
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      let content: string;
      try {
        content = textDecoder.decode(Buffer.concat(chunks));
        if (content.includes("\0")) throw new Error();
      } catch {
        throw new SkillUploadError(`${path} 必须是 UTF-8 文本。`);
      }
      files.set(path, content);
    }
  } finally {
    archive.close();
  }
  for (const path of entries.keys()) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (entries.get(parts.join("/")) === false) throw new SkillUploadError("ZIP 中存在文件和目录路径冲突。");
      parts.pop();
    }
  }
  return files;
}

function parseBundle(files: Map<string, string>): SkillBundle {
  const manifests = [...files.keys()].filter(path => path.split("/").at(-1)?.toLowerCase() === "skill.md");
  const manifest = manifests[0];
  if (manifests.length !== 1 || !/^(?:[^/]+\/)?SKILL\.md$/.test(manifest)) {
    throw new SkillUploadError("请在 ZIP 根目录或一层 Skill 目录内放置唯一的 SKILL.md。");
  }
  const raw = files.get(manifest)!.replace(/\r\n?/g, "\n");
  const sections = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(raw);
  if (!sections || sections[1].length > 16_384 || !sections[2].trim() || sections[2].length > 32_768) {
    throw new SkillUploadError("SKILL.md 需要有效的 YAML 元数据和正文，且正文不能超过 32,768 字符。");
  }
  let metadata: unknown;
  try {
    metadata = load(sections[1], { schema: JSON_SCHEMA, maxDepth: 8, maxAliases: 0 });
  } catch {
    throw new SkillUploadError("SKILL.md 的 YAML 元数据无效。");
  }
  const parsed = frontmatter.safeParse(metadata);
  if (!parsed.success) throw new SkillUploadError("请检查 Skill 名称、描述和元数据格式，并移除不受支持的字段。");
  // Keep upload-only metadata, including tool declarations, out of the runtime bundle.
  const { name } = parsed.data;
  const description = parsed.data.description.replace(/\s+/g, " ");
  if (/[\u0000-\u001f\u007f-\u009f]/.test(description)) {
    throw new SkillUploadError("SKILL.md 的描述含有无效字符。");
  }
  if (dynamicCommand.test(sections[2]) || dynamicCommand.test(description)) {
    throw new SkillUploadError("SKILL.md 不支持在加载时执行动态命令。请将代码作为独立文件打包。");
  }
  const prefix = manifest.slice(0, -"SKILL.md".length);
  if (prefix && prefix !== `${name}/`) throw new SkillUploadError("Skill 文件夹名称需要与 SKILL.md 的 name 一致。");
  const attachments = [...files]
    .filter(([path]) => path !== manifest)
    .map(([path, content]) => {
      if (!path.startsWith(prefix) || runtimeFile.test(path.split("/").at(-1)!)) {
        throw new SkillUploadError(`${path} 必须是 Skill 目录中的普通内容文件。`);
      }
      return { path: path.slice(prefix.length), content };
    })
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { name, description, content: sections[2], files: attachments };
}
