# New_World 工程格式规范（Schema 1）

状态：本仓库原生工程交换格式，扩展名 `.newworld`，MIME `application/vnd.newworld.project+zip`。

此规范的 `schemaVersion = 1` 与应用版本 `appVersion` 独立。实现入口为 `src/projects/`；这是作品级导入，不是 `new-world-backup.json` 全库备份，不能调用备份恢复函数。工程导入后仍在 IndexedDB 书库编辑；修改后须重新导出文件，不存在外部工程自动保存。

## 1. 容器与文件布局

使用标准 ZIP，JSON 使用无 BOM 的 UTF-8。写入器采用 STORE（level 0），避免把高度重复的合法正文压缩成无法再次导入的异常压缩率文件；读取器也支持满足限制的 DEFLATE。禁止加密、目录条目、符号链接、重复路径、路径穿越、自解压前缀、尾随数据、重叠条目以及不一致的本地/中央目录。

```text
manifest.json
books.json
originals/index.json
originals/<resource-key>.bin       # 原始文件字节
editions/index.json
chapters/index.json
ideas/index.json
assets/<resource-key>.bin          # 封面（现有正文插图仍在 Tiptap JSON 中）
revisions/chapters.json
revisions/blobs.json
revisions/payloads/<resource-key>.bin
revisions/ideas.json
revisions/baselines.json
trash/index.json                  # 只包含当前作品的回收记录
```

十个索引文件全部必需，均为 JSON 数组，空数据用 `[]`。不得省略空表，不允许未列入资源清单的额外条目，也不允许清单中未被引用的资源。文件名不取自用户上传的原文件名，原文件名保存在作品元数据中，中文及特殊字符不会变成 ZIP 路径。

ZIP 内路径是大小写敏感的相对 ASCII 路径，长度至多 240，只能使用小写字母、数字、`-`、`.`、`/`。路径分段不得为空、`.`、`..`；禁止反斜线、驱动器、绝对路径、NUL、URI 和百分号编码。永远不将归档解压到本机路径，也不执行其中任何内容。

## 2. manifest.json

必填字段：

| 字段 | 类型与含义 |
| --- | --- |
| `format` | 固定字符串 `new-world-project` |
| `schemaVersion` | 整数 `1`，工程 Schema 版本 |
| `appVersion` | 字符串，导出时应用版本，仅作来源信息 |
| `createdAt` | 非负安全整数，导出时间，Unix 毫秒 |
| `root` | `{ "library": "original" 或 "reference", "id": "作品 UUID" }` |
| `records` | 下述固定表名与索引路径的对象 |
| `detached` | `{ books: string[], editions: string[], chapters: string[], ideas: string[] }` |
| `resources` | 全部索引及二进制资源的清单（不含 manifest 自身） |

`records` 固定映射：`books → books.json`、`files → originals/index.json`、`editions → editions/index.json`、`chapters → chapters/index.json`、`ideas → ideas/index.json`、`revisions → revisions/chapters.json`、`revisionBlobs → revisions/blobs.json`、`ideaRevisions → revisions/ideas.json`、`aiBaselines → revisions/baselines.json`、`trash → trash/index.json`。

每项资源必填：

```json
{
  "path": "chapters/index.json",
  "bytes": 1234,
  "sha256": "64位小写十六进制摘要",
  "mediaType": "application/json",
  "kind": "json"
}
```

`kind` 只允许 `json`、`blob`、`bytes`；`bytes` 是精确字节数，不是压缩后长度。`mediaType` 是原 Blob 的类型，允许空字符串。索引文件必须是 `json`。

`detached` 是**真实引用但已不存在记录**的 ID 集合，每组排序且唯一。读取器根据全部数据重新计算并比对，不接受多余或遗漏项。它保存已删除原文的 `originalId`、已删版本的 `copiedFrom`、旧历史的目标以及灵感历史的外部作品引用；不是补造的作品/章节记录。当前存活章节必须与编辑版本目录双向一致，不能以 detached 豁免缺失正文。历史目标仍在本作品回收站时，导入后可先恢复真实的父版本/章节再恢复历史；若原库早已没有目标记录，保留历史与断开的身份，不能承诺凭空恢复原来不存在的父级。

## 3. 索引记录与类型

以下为字段全集；未注明可选的字段均必填。对象禁止未定义字段；可选字段不存在时省略，不能以 `null` 代替。数字均为有限数，时间、修订号、计数和大小为非负安全整数。普通身份字符串非空、至多 255 字符且不含控制字符；作品、版本及章节的存活 ID 使用 UUID，以符合现有路由。标题非空且至多 255 字符。

### books / files

`books`：`library, id, title, importedAt, format`；可选 `workId, archivedAt, cover`。

导入文件作品还必须有 `originalName, size, digest`，可选 `readingAnnotations`。`format` 为现有 TXT、PDF、EPUB、DOC、DOCX、Markdown、RTF、HTML、ODT、MOBI、AZW3 对应的小写格式键；`digest` 为原始字节 SHA-256。手写作品 `format = "draft"` 不携带原文件字段。

只允许一个根作品；其他作品必须在 `reference` 库以 `workId` 指向根作品，表示续写工程的附属原文。`archivedAt` 保留归档状态。`cover` 为 Blob 资源引用；允许现有 PNG/JPEG/WebP/GIF/AVIF/BMP，检查类型、签名及大小，不执行 SVG 或其他活动内容。当前数据模型没有作者、ISBN 等独立作品字段，不编造这些信息。

`files`：`library, id, blob`。`id` 与导入文件作品对应，`blob` 引用原始字节资源。大小及 SHA-256 必须与作品记录相符。保留原始换行、BOM、文件编码及压缩文件内部字节，不重新编码。

### editions / chapters

`editions`：`library, bookId, id, name, source, notes, chapters, createdAt, revision`；可选 `copiedFrom, originalId`。

`source` 为 `original | blank | copy`；`notes` 是原有转换提示字符串数组；`chapters` 是有序 `{ id, title }` 数组（1–2000 项），是标题和顺序的唯一来源，不重复存到章节正文。`copiedFrom` 指原版本身份；`originalId` 指实际使用的原文件身份。不存在关系时不推断、不补造。

`chapters`：`library, bookId, editionId, id, content, revision`；可选 `readingAnnotations`。

`content` 是完整 Tiptap `doc` JSON，按本应用现有 `documentExtensions` 验证节点、标记、属性及树结构。支持段落、各级标题、现有行内样式、列表、引用、代码、表格及本地栅格插图。未知节点/标记/属性直接拒绝，不能在导入时通过 HTML/纯文本转换静默删除。插图继续使用模型原有的 data URL，验证 MIME、魔数和现有图片预算；这样历史内容哈希也保持不变。应用全局字体、字号、主题不是作品样式，不混入工程；本轮不添加现有编辑器尚未支持的字体属性。

### 阅读批注

章节上的 `readingAnnotations` 为 `{ revision, items }`；原文件作品上的同名字段为 `sectionId → { revision, items }` 映射。sectionId 按原预览器持久化，不重建锚点。

每条批注：`id, anchor, text, color, display, collapsed, createdAt`，可选 `inlineColor`。

`anchor`：`version = 1, kind = document | text, from, to, quote, sourceHash`。`from >= 0`、`to > from`，位置为现有表面偏移；`sourceHash` 为 64 位十六进制 SHA-256。颜色是 `#RRGGBB`，支持自定义色；`display = inline | mark`；`collapsed` 为布尔值；批注文本非空、至多 10000 字符。保留过期锚点，不擅自移动批注；编辑后的有效性仍由原有批注定位逻辑判断。

### ideas / revisions / revisionBlobs / ideaRevisions / aiBaselines

`ideas`：`id, text, createdAt`；可选 `library, bookId, usedAt`。工程内当前灵感及回收灵感必须属于根作品。文本至多 20000 字符。

`revisions`：`id, library, bookId, editionId, chapterId, chapterTitle, words, createdAt, source, action, contentHash`；可选 `editionName, chapterRevision, content, plainText, blobHash, rawBytes, storedBytes, clientId, clientName`。

`source = ai | user-restore`。兼容旧内联快照（`content`）与现有去重快照（`blobHash`），至少有一种有效载荷。内联文档也通过完整正文验证。历史章节名/版本名按实际记录保存；旧记录缺少可选字段时不补造。

`revisionBlobs`：`hash, encoding, data, rawBytes, storedBytes, createdAt`；`encoding = gzip | json`，`data` 是 `bytes` 资源引用。只包含相关历史实际引用的载荷，按 hash 去重。除 ZIP 的 SHA-256 外，解码后再检查原模型 `synchronousContentHash(JSON字符串)` 与 `hash/contentHash`、原始及存储字节数；这是现有双 32 位历史指纹，不能当作密码学完整性校验。gzip 解压也有独立流式限额。

`ideaRevisions`：`id, ideaId, text, ideaCreatedAt, createdAt, source, action, contentHash`；可选 `library, bookId, usedAt, clientId, clientName`。收集当前/本作品回收灵感的全部历史，另收集历史归属为此作品的真实记录。历史曾属于其他作品时，只保留历史关联身份并列入 detached，绝不打包其他作品。副本导入同步映射关联并重算包含归属的历史指纹。

`aiBaselines`：`clientId, library, bookId, editionId, chapterId, peakWords, anchorWords, anchorText, updatedAt`。这是每章防累计内容丢失的持久化基线，属于作品安全状态，不能当作临时缓存丢掉。`clientId/clientName` 仅为历史来源及基线身份，不包含访问令牌、账户、授权范围或本机 AI 配置；导入不会启用任何 AI 客户端。

### trash

只导出 `library/bookId` 归属当前根作品的 `original | edition | chapter | idea` 记录，保证可恢复的已删父级与其正文仍完整存在。整个作品的回收记录不与存活根作品混用。

字段为 `id, kind, library, bookId, title, deletedAt, books, files, editions, chapters`，可选 `ideas, position`。内嵌记录遵循同一类型。`position = { editionId, index }` 保留已删章节位置。按种类要求原文一组 book/file、版本一个 edition 及其章节、章节一个 chapter 和 position、灵感一个 idea，不允许混入其他作品数据。

### 二进制引用

上述 Blob / Uint8Array 值在 JSON 中统一表示为：

```json
{ "$resource": "originals/<resource-key>.bin" }
```

引用对象只能有这个字段；其资源 `kind = blob` 时恢复为 Blob（保留 mediaType），`kind = bytes` 时恢复为 Uint8Array。`resource-key = SHA256(UTF8(SHA256(原始字节) + "\n" + mediaType))`，同目录按此去重。封面和原文独立于 JSON，历史保留原有压缩字节；ZIP 导入不会将资源路径变成本地文件路径。`$resource`、`__proto__`、`constructor`、`prototype` 为保留键。

## 4. 完整性、安全与兼容

- 逐项校验 ZIP CRC、本地/中央目录、声明及实际流入字节数、SHA-256、UTF-8 JSON、类型、唯一键、章节双向引用、原文件摘要、历史载荷及 detached 集合；全部成功后才显示摘要。Manifest 自身由 ZIP CRC 与严格解析保护；清单 SHA-256 能发现损坏，不提供发布者身份认证或数字签名。
- 物理归档 ≤512 MiB，累计解压 ≤512 MiB，单项 ≤128 MiB，JSON 索引/manifest ≤32 MiB，条目 ≤10000，顶层记录总量 ≤50000；JSON 最大 64 层、1000000 个遍历值；大于 1 MiB 的条目压缩率不得超过 200:1。
- 章节历史 gzip 单项原始 JSON ≤32 MiB，累计解码 ≤512 MiB；原文件沿用 ≤128 MiB，封面 ≤32 MiB，插图沿用单图 ≤4 MiB、文档预算 ≤24 MiB。声明偏小也不能绕过流式限额。
- 只支持 Schema 1。更高/更低/无版本均明确拒绝，不能按应用版本猜测。未来 Schema 升级须显式迁移、补充测试，并在没有迁移器时拒绝；Schema 1 内不接受未知持久化字段，避免下次保存时静默丢失。
- 无网络资源加载、代码执行或原文件自动打开；原文件只按现有受限预览器读取。安全检查失败不会打开写事务。

## 5. 导入、冲突与本地存储

在预览中显示作品、所属书库、章节/版本/原文件/历史/灵感/本作品回收记录数。导入前可取消、跳过、保持身份导入或导入副本。

保留身份仅在没有作品 ID/标题、原文件摘要和身份冲突时提供。冲突不仅检查存活作品，还检查版本、章节、灵感、历史、回收记录及断开的历史引用，防止旧引用错误绑定到本地其他作品。原文件摘要按同书库检测。

副本导入为全部作品/原文/版本/章节/灵感/历史/回收/批注身份以及 detached 身份生成新 UUID，修正 `workId, bookId, editionId, chapterId, ideaId, originalId, copiedFrom`、目录和回收位置；正文与批注内容/锚点哈希不变。历史载荷使用现有去重键，不为同字节再建一套数据。

写入前重新验证数据，确认后在**单个 strict IndexedDB 事务**中重新读冲突、映射及 `add` 全部记录。禁止 `clear` 或覆盖已有记录；任意 Constraint/Quota/其他错误整体 abort。历史载荷若同一旧指纹对应不同压缩字节则拒绝并提示冲突，不覆盖已有载荷（指纹不是抗碰撞摘要）。

IndexedDB 升至 v8：`byLibraryDigest` 改为非唯一索引，允许副本保有独立原文身份但相同字节。原有普通文件导入仍在串行写事务中查重，不重复添加。表的主键、版本名唯一索引及原有正文、批注结构不变；不把工程 schemaVersion 当作数据库版本。

不包含全局写作统计、未关联灵感、其他作品、其他作品回收数据、主题/字体/窗口/存储位置/备份设置、AI 授权及令牌、缓存、当前选区、编辑器未保存缓冲或会话撤销栈。作品导出入口设于书架菜单及续写详情，读取已持久化的一致快照，不修改原作品。

## 6. 文件保存与桌面关联

桌面导出使用原生保存对话框，可选位置及 Unicode 文件名（系统不支持的路径分隔/保留字符需更名）。先完成工程自校验，再在目标同目录创建随机 `.partial` 文件，写入、fsync、重读 SHA-256 与已验证字节比对，最后 rename；失败清理临时文件，保留旧目标。

Web 版优先用 File System Access 保存选择器/可提交写入流；没有此 API 时使用浏览器下载，位置按浏览器下载设置管理，可开启“每次询问保存位置”。所有路径先生成并验证完整文件再交付；浏览器和操作系统的文件提交/断电耐久性保证受平台实现限制。

Windows 安装器通过 electron-builder 注册 `.newworld` 文件关联；macOS 声明 `com.littleboylinlin.newworld.project` UTI，继承 `public.zip-archive`，角色 Viewer。双击只是启动导入，绝不声称支持文件原地编辑。Windows 初始 argv/second-instance 与 macOS open-file 均进入有界队列，等 renderer ready 后交付一次性 token；renderer 不能请求任意本机路径。重复启动复用现有窗口，不替换编辑中的文稿；有模态操作时排队，确认导入前执行原有未保存处理。

## 7. 互通和验收

`.newworld` 不面向通用阅读器。导入后继续使用原有 TXT、Markdown、HTML、DOCX、PDF 正文导出器，不增加 EPUB 导出器。正文格式只导出所选版本/章节：TXT 不保留样式/图片/表格结构，Markdown 简化呈现，HTML/DOCX/PDF 保留各转换器支持的呈现；均不携带工程版本关系、批注、原始文件、灵感和历史，不能当作无损工程转换。

示例：[雾港.newworld](examples/雾港.newworld)。包含 2 个版本、3 个存活章节、原始 Markdown 文件、封面/插图、表格/样式、自定义批注、gzip 历史、灵感历史、防丢失基线及一个已删章节。由真实 UI 导出生成；`tests/projects.spec.mjs` 验证跨干净浏览器上下文导入、全部 IndexedDB 记录与字节对比、再导出、历史恢复和继续编辑。续写场景使用第二个原文检验 `workId/originalId/copiedFrom`，并检验错误文件、冲突和事务故障。

运行 `npm test`；平台安装及系统文件关联在 `npm run test:desktop` 和 `npm run test:macos` 中验证。重新生成验收示例可运行 `UPDATE_PROJECT_EXAMPLE=1 npx playwright test tests/projects.spec.mjs --grep 'original 工程' --workers=1`（先 `npm run build`）。示例为测试数据，不包含真实用户信息。
