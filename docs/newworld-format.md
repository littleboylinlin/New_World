# New_World 工程格式规范（Schema 1 / 2 / 3）

状态：本仓库原生工程交换格式，扩展名 `.newworld`，MIME `application/vnd.newworld.project+zip`。

工程 Schema 与应用版本 `appVersion` 独立。已发布 v0.18.0 使用 Schema 1，v0.18.1 写入 Schema 2。v0.19.0 正式写入 **Schema 3**，显式读取 Schema 1、2、3。v0.18.1 及更旧应用不能读取 Schema 3。Schema 1 不做破坏性改写：缺少的作品信息保持缺少，不填入作者或状态。实现入口为 `src/projects/`；这是作品级导入，不是 `new-world-backup.json` 全库备份，不能调用备份恢复函数。工程导入后仍在 IndexedDB 书库编辑；修改后须重新导出文件，不存在外部工程自动保存。

## v0.19.0 升级与回退

**升级前请在 v0.18.1 中创建并保留全库备份。** 应用、数据库、单部工程和全库备份分别管理版本：

| 数据 | v0.18.1 | v0.19.0 | 兼容边界 |
| --- | --- | --- | --- |
| IndexedDB | v8 | v9，仅新增九个任务表 | v0.18.1 不能直接打开 v9；不重写旧作品 |
| `.newworld` | 读取 1/2，写入 2 | 读取 1/2/3，写入 3 | v0.18.1 不能导入 Schema 3；旧工程再次导出为 3 |
| 全库 ZIP 备份 | 格式 1 | 读取 1/2，写入 2 | 旧软件拒绝格式 2；格式 1 恢复时保留现有任务，格式 2 替换全部任务表 |

回退须使用升级前的格式 1 备份，不能直接复用升级后的数据库或用格式 2 备份在旧版恢复。单部工程不是全库回退备份，也不包含个人任务及本机设置。已发布 Schema 1/2 示例及历史发行说明保留原样。见[任务规则](tasks.md)及[中英文发行说明](releases/v0.19.0.md)。

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
assets/<resource-key>.bin          # 封面/任务附件（正文插图仍在 Tiptap JSON 中）
revisions/chapters.json
revisions/blobs.json
revisions/payloads/<resource-key>.bin
revisions/ideas.json
revisions/baselines.json
trash/index.json                  # 只包含当前作品的回收记录
tasks/index.json                  # 以下六项仅 Schema 3，均必需
tasks/projects.json
tasks/sections.json
tasks/labels.json
tasks/completions.json
tasks/attachments.json
```

Schema 1/2 的十个索引文件全部必需；Schema 3 另增加六个任务索引，共十六项，均为 JSON 数组，空数据用 `[]`。不得省略空表，不允许未列入资源清单的额外条目，也不允许清单中未被引用的资源。文件名不取自用户上传的原文件名，原文件名保存在作品元数据中，中文及特殊字符不会变成 ZIP 路径。

ZIP 内路径是大小写敏感的相对 ASCII 路径，长度至多 240，只能使用小写字母、数字、`-`、`.`、`/`。路径分段不得为空、`.`、`..`；禁止反斜线、驱动器、绝对路径、NUL、URI 和百分号编码。永远不将归档解压到本机路径，也不执行其中任何内容。

## 2. manifest.json

必填字段：

| 字段 | 类型与含义 |
| --- | --- |
| `format` | 固定字符串 `new-world-project` |
| `schemaVersion` | 整数 `1`、`2` 或 `3`；v0.19.0 写入器写 `3` |
| `appVersion` | 字符串，导出时应用版本，仅作来源信息 |
| `createdAt` | 非负安全整数，导出时间，Unix 毫秒 |
| `root` | `{ "library": "original" 或 "reference", "id": "作品 UUID" }` |
| `records` | 下述固定表名与索引路径的对象 |
| `detached` | `{ books: string[], editions: string[], chapters: string[], ideas: string[], tasks: string[] }`（tasks 仅 Schema 3） |
| `resources` | 全部索引及二进制资源的清单（不含 manifest 自身） |

`records` 固定映射：`books → books.json`、`files → originals/index.json`、`editions → editions/index.json`、`chapters → chapters/index.json`、`ideas → ideas/index.json`、`revisions → revisions/chapters.json`、`revisionBlobs → revisions/blobs.json`、`ideaRevisions → revisions/ideas.json`、`aiBaselines → revisions/baselines.json`、`trash → trash/index.json`。Schema 3 还要求 `tasks → tasks/index.json`、`taskProjects → tasks/projects.json`、`taskSections → tasks/sections.json`、`taskLabels → tasks/labels.json`、`taskCompletions → tasks/completions.json`、`taskAttachments → tasks/attachments.json`；Schema 1/2 禁止这些新增表。

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

以下为字段全集；未注明可选的字段均必填。结构对象禁止未定义字段（Schema 2 的 `metadata` 内可按下述约束扩展）；可选字段不存在时省略，不能以 `null` 代替。数字均为有限数，时间、修订号、计数和大小为非负安全整数。普通身份字符串非空、至多 255 字符且不含控制字符；作品、版本及章节的存活 ID 使用小写 UUID，以符合现有路由。标题非空且至多 255 字符。

### books / files

`books`：`library, id, title, importedAt, format`；可选 `workId, archivedAt, cover`。Schema 2 另允许可选的 `metadata`（包括回收记录内的 books）。Schema 1 不允许这个新增字段。

导入文件作品还必须有 `originalName, size, digest`，可选 `readingAnnotations`。`format` 为现有 TXT、PDF、EPUB、DOC、DOCX、Markdown、RTF、HTML、ODT、MOBI、AZW3 对应的小写格式键；`digest` 为原始字节 SHA-256。手写作品 `format = "draft"` 不携带原文件字段。

只允许一个根作品；其他作品必须在 `reference` 库以 `workId` 指向根作品，表示续写工程的附属原文。`archivedAt` 保留归档状态。`cover` 为 Blob 资源引用；允许现有 PNG/JPEG/WebP/GIF/AVIF/BMP，检查类型、签名及大小，不执行 SVG 或其他活动内容。Schema 1 没有独立作者字段，不推断或编造缺少的信息。

`files`：`library, id, blob`。`id` 与导入文件作品对应，`blob` 引用原始字节资源。大小及 SHA-256 必须与作品记录相符。保留原始换行、BOM、文件编码及压缩文件内部字节，不重新编码。

### Schema 2 可扩展作品信息（metadata）

`metadata` 是可选的、作品范围内的惰性 JSON 对象。它不是全局设置、程序配置、资源或身份引用表。已知字段全部可选，可以缺少或为空，不从账户名、文件名、正文或其他作品推断内容。

| 字段 | 类型、限制与含义 |
| --- | --- |
| `author` | 字符串，≤255，作者自由填写，单行 |
| `subtitle` | 字符串，≤255，可选副标题，单行 |
| `synopsis` | 字符串，≤20000，简介，保留段落、LF / CRLF / CR 及制表符 |
| `tags` | 字符串数组，≤50 项，每项 1–64，首尾无空白、无重复，顺序保留 |
| `status` | 字符串，≤64，单行；界面提供 planning / serializing / completed / paused，可保留未来的其他安全字符串 |

长度按 JavaScript UTF-16 code units 计算；已知单行字段及标签不得有 U+0000–U+001F，简介只允许其中的 TAB、LF、CR。界面按行输入标签（逗号可为标签内容），对**修改过的**标签做去重、首尾去空白；不改写未编辑的字段。清空某个字段移除该键；所有字段都删除时可省略 metadata。

示例（第三方扩展建议使用命名空间，避免占用未来普通字段）：

```json
{
  "author": "笔名",
  "subtitle": "第二次归航",
  "synopsis": "第一段。\n\n第二段。",
  "tags": ["奇幻", "海洋"],
  "status": "serializing",
  "extensions": { "org.example.series": { "name": "雾港", "volume": 2 } }
}
```

未知键的值只允许 null、布尔值、有限 JSON 数字、字符串、数组及普通 JSON 对象。整个对象经 `JSON.stringify` 的 UTF-8 大小 ≤128 KiB，根深度为 0、最大深度 12、累计遍历值 ≤4096，每个对象 ≤64 个键，每个数组 ≤256 项，键非空、≤128、无 U+0000–U+001F。任意层禁止 `__proto__`、`constructor`、`prototype`、`$resource`；不接受二进制、类实例、undefined、函数、访问器、Symbol 或稀疏数组。元数据受全工程 SHA-256、JSON 及资源预算约束，不降低原安全检查。

安全的未知 JSON 字段原样存储和再次导出（保留值、数组顺序、换行，不承诺 JSON 空白或对象键的字节顺序）。界面只编辑已知字段，不执行、联网加载或解释扩展；即使未知字段名为 `id` / `bookId`，副本导入也**不重映射其中的字面值**。扩展不得用来承载需重映射的作品引用、可执行设置或二进制资源；这些新语义必须另行制定结构及兼容规则。不能安全保留的元数据和未知结构字段明确报错，导入不写数据；导出遇到不支持的本地数据也报错，不能静默丢失后声称成功。

Schema 2 内增加这种有界、可选、惰性的普通元数据无需升级 Schema。已有字段的类型/语义不能通过扩展改变；安全约束或必需结构发生变化时须显式升级版本并实现读取/迁移。未知结构字段不会自动塞进 metadata，也不执行模糊迁移。

### editions / chapters

`editions`：`library, bookId, id, name, source, notes, chapters, createdAt, revision`；可选 `copiedFrom, originalId`。

`source` 为 `original | blank | copy`；`notes` 是原有转换提示字符串数组；`chapters` 是有序 `{ id, title }` 数组（1–2000 项），是标题和顺序的唯一来源，不重复存到章节正文。`copiedFrom` 指原版本身份；`originalId` 指实际使用的原文件身份。不存在关系时不推断、不补造。

`chapters`：`library, bookId, editionId, id, content, revision`；可选 `readingAnnotations`。

`content` 是完整 Tiptap `doc` JSON，按本应用现有 `documentExtensions` 验证节点、标记、属性及树结构。支持段落、各级标题、现有行内样式、列表、引用、代码、表格及本地栅格插图。表格对齐只允许 null/left/right/center，有序列表 type 只允许 null/1/a/A/i/I，图片宽高只允许 null、非负有限尺寸或数字加 px/%（最大 100000）。未知节点/标记/属性直接拒绝，不能在导入时通过 HTML/纯文本转换静默删除。插图继续使用模型原有的 data URL，验证 MIME、魔数和现有图片预算；这样历史内容哈希也保持不变。应用全局字体、字号、主题不是作品样式，不混入工程；本轮不添加现有编辑器尚未支持的字体属性。

### 阅读批注

章节上的 `readingAnnotations` 为 `{ revision, items }`；原文件作品上的同名字段为 `sectionId → { revision, items }` 映射。sectionId 按原预览器持久化，不重建锚点。

每条批注：`id, anchor, text, color, display, collapsed, createdAt`，可选 `inlineColor`。

`anchor`：`version = 1, kind = document | text, from, to, quote, sourceHash`。`from >= 0`、`to > from`，位置为现有表面偏移；`sourceHash` 为 64 位十六进制 SHA-256。颜色是 `#RRGGBB`，支持自定义色；`display = inline | mark`；`collapsed` 为布尔值；批注文本非空、至多 10000 字符。保留过期锚点，不擅自移动批注；编辑后的有效性仍由原有批注定位逻辑判断。

### ideas / revisions / revisionBlobs / ideaRevisions / aiBaselines

`ideas`：`id, text, createdAt`；可选 `library, bookId, usedAt`。工程内当前灵感及回收灵感必须属于根作品或工程中实际保存的附属原文（包括本作品回收原文）。原文右键记录的灵感保留原文 bookId，不改写为根作品 ID。文本至多 20000 字符。

`revisions`：`id, library, bookId, editionId, chapterId, chapterTitle, words, createdAt, source, action, contentHash`；可选 `editionName, chapterRevision, content, plainText, blobHash, rawBytes, storedBytes, clientId, clientName`。

`source = ai | user-restore`。兼容旧内联快照（`content`）与现有去重快照（`blobHash`），至少有一种有效载荷。内联文档也通过完整正文验证。历史章节名/版本名按实际记录保存；旧记录缺少可选字段时不补造。

`revisionBlobs`：`hash, encoding, data, rawBytes, storedBytes, createdAt`；`encoding = gzip | json`，`data` 是 `bytes` 资源引用。只包含相关历史实际引用的载荷，按 hash 去重。除 ZIP 的 SHA-256 外，解码后再检查原模型 `synchronousContentHash(JSON字符串)` 与 `hash/contentHash`、原始及存储字节数；这是现有双 32 位历史指纹，不能当作密码学完整性校验。gzip 解压也有独立流式限额。

`ideaRevisions`：`id, ideaId, text, ideaCreatedAt, createdAt, source, action, contentHash`；可选 `library, bookId, usedAt, clientId, clientName`。收集当前/本作品回收灵感的全部历史，另收集历史归属为此作品的真实记录。历史曾属于其他作品时，只保留历史关联身份并列入 detached，绝不打包其他作品。副本导入同步映射关联并重算包含归属的历史指纹。

`aiBaselines`：`clientId, library, bookId, editionId, chapterId, peakWords, anchorWords, anchorText, updatedAt`。这是每章防累计内容丢失的持久化基线，属于作品安全状态，不能当作临时缓存丢掉。`clientId/clientName` 仅为历史来源及基线身份，不包含访问令牌、账户、授权范围或本机 AI 配置；导入不会启用任何 AI 客户端。

### trash

只导出 `library/bookId` 归属当前根作品（灵感也包含附属原文）的 `original | edition | chapter | idea` 记录，保证可恢复的已删父级与其正文仍完整存在。整个作品的回收记录不与存活根作品混用。

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
- v0.19.0 读取器明确支持 Schema 1 / 2 / 3，写入器始终写 Schema 3。Schema 1 直接按原规则验证、恢复，缺少 metadata 不做填充；再次导出生成 Schema 3。更高/更低/无版本均明确拒绝，不能按应用版本猜测。已发布 v0.18.0 **无法读取 Schema 2/3**，v0.18.1 **无法读取 Schema 3**。读旧文件时新增任务表正规化为空数组、断开的 tasks 为空，不填造任务；不承诺旧软件兼容未来格式。未来升级须显式实现迁移并测试；只有 metadata 内符合本规范的未知 JSON 值允许保留，其他未知持久化字段仍拒绝。
- 无网络资源加载、代码执行或原文件自动打开；原文件只按现有受限预览器读取。安全检查失败不会打开写事务。

## 5. 导入、冲突与本地存储

在预览中显示作品、所属书库、章节/版本/原文件/历史/灵感/本作品回收记录数。导入前可取消、跳过、保持身份导入或导入副本。

保留身份仅在没有作品 ID/标题、原文件摘要和身份冲突时提供。冲突不仅检查存活作品，还检查版本、章节、灵感、历史、回收记录及断开的历史引用，防止旧引用错误绑定到本地其他作品。原文件摘要按同书库检测。

副本导入为全部作品/原文/版本/章节/灵感/历史/回收/批注身份以及 detached 身份生成新 UUID，修正 `workId, bookId, editionId, chapterId, ideaId, originalId, copiedFrom`、目录和回收位置；正文、作品信息与批注内容/锚点哈希不变。metadata 不属于身份引用图，详见上文。历史载荷使用现有去重键，不为同字节再建一套数据。

写入前重新验证数据，确认后在**单个 strict IndexedDB 事务**中重新读冲突、映射及 `add` 全部记录。禁止 `clear` 或覆盖已有记录；任意 Constraint/Quota/其他错误整体 abort。历史载荷若同一旧指纹对应不同压缩字节则拒绝并提示冲突，不覆盖已有载荷（指纹不是抗碰撞摘要）。

v0.18.0 和 v0.18.1 使用 IndexedDB v8：`byLibraryDigest` 是非唯一索引，允许副本保有独立原文身份但相同字节。原有普通文件导入仍在串行写事务中查重，不重复添加。作品信息使用可选嵌套字段；v0.19.0 的任务功能将数据库升至 v9，仅新增九个独立任务表，不改写旧记录、不填造作者/状态。旧软件不能直接打开 v9 数据库，回退需要升级前备份。表的主键、版本名唯一索引及原有正文、批注结构不变；不把工程 schemaVersion 当作数据库版本。全库备份独立升为格式 2，包含全部任务及附件，读取器仍支持格式 1；恢复旧备份无任务数据时保留本机任务。不复用全库恢复来导入工程。

不包含全局写作统计、个人任务/其他作品任务/未确认外部任务链接、全局任务过滤器/模板、本机提醒设置、未关联灵感、其他作品、其他作品回收数据、主题/字体/窗口/存储位置/备份设置、AI 授权及令牌、缓存、当前选区、编辑器未保存缓冲或会话撤销栈。作品导出入口设于书架菜单及续写详情，读取已持久化的一致快照，不修改原作品。

## 6. 文件保存与桌面关联

桌面导出使用原生保存对话框，可选位置及 Unicode 文件名（系统不支持的路径分隔/保留字符需更名）。先完成工程自校验，再在目标同目录创建随机 `.partial` 文件，写入、fsync、重读 SHA-256 与已验证字节比对，最后 rename；失败清理临时文件，保留旧目标。

Web 版优先用 File System Access 保存选择器/可提交写入流；没有此 API 时使用浏览器下载，位置按浏览器下载设置管理，可开启“每次询问保存位置”。所有路径先生成并验证完整文件再交付；浏览器和操作系统的文件提交/断电耐久性保证受平台实现限制。

Windows 安装器通过 electron-builder 注册 `.newworld` 文件关联；macOS 声明 `com.littleboylinlin.newworld.project` UTI，继承 `public.zip-archive`，角色 Viewer。双击只是启动导入，绝不声称支持文件原地编辑。Windows 初始 argv/second-instance 与 macOS open-file 均进入有界队列，等 renderer ready 后交付一次性 token；renderer 不能请求任意本机路径。重复启动复用现有窗口，不替换编辑中的文稿；有模态操作时排队，确认导入前执行原有未保存处理。

## 7. 互通和验收

`.newworld` 不面向通用阅读器。导入后继续使用原有 TXT、Markdown、HTML、DOCX、PDF 正文导出器，不增加 EPUB 导出器。正文格式只导出所选版本/章节：TXT 不保留样式/图片/表格结构，Markdown 简化呈现，HTML/DOCX/PDF 保留各转换器支持的呈现；均不携带工程版本关系、批注、原始文件、灵感和历史，不能当作无损工程转换。

正文导出增加三个独立、默认关闭的选项：作品标题及副标题、作者、作品简介。全部关闭时沿用原有正文排版。TXT 使用简单文本分隔，Markdown/HTML 使用现有转换器及安全文本结构，DOCX/PDF 将所选信息置于正文前的标题页/作品介绍；简介保留换行。标签、创作状态和未知扩展不作为正文前言导出，这些数据留在完整工程中。

示例：[雾港.newworld](examples/雾港.newworld)。包含 2 个版本、3 个存活章节、原始 Markdown 文件、封面/插图、表格/样式、自定义批注、gzip 历史、灵感历史、防丢失基线及一个已删章节。由真实 UI 导出生成；`tests/projects.spec.mjs` 验证跨干净浏览器上下文导入、全部 IndexedDB 记录与字节对比、再导出、历史恢复和继续编辑。续写场景使用第二个原文检验 `workId/originalId/copiedFrom`，并检验错误文件、冲突和事务故障。

上述示例保持已发布 Schema 1 的原字节，用于旧文件回归。新增 [雾港-作品信息.newworld](examples/雾港-作品信息.newworld) 为 Schema 2，含作者、多段简介、副标题、标签、状态及安全未知扩展。`tests/work-information.spec.mjs` 通过实际 UI 导出、干净书库导入、数据库全部相关记录及字节对比、再次导出、副本冲突、编辑后保留扩展、并发修改冲突、错误/超限数据拒绝验证。Windows/macOS 安装测试还验证作品信息重启持久化及真实 PDF 标题页。

运行 `npm test`；平台安装及系统文件关联在 `npm run test:desktop` 和 `npm run test:macos` 中验证。已发布 Schema 1/2 样本保持不可覆盖；新任务示例使用独立的 Schema 3 生成命令，见任务文档。示例为测试数据，不包含真实用户信息。

已发布 Schema 1/2 样本不可由新写入器替换。Schema 3 样本生成及任务验收见 [任务文档](tasks.md)。

## 8. Schema 3 任务记录（正式结构升级）

Schema 3 在 Schema 2 的作品/元数据规范之上增加六个任务表及 `detached.tasks`。字段是正式结构，不放进 metadata 扩展。字段全集如下；未注明可选的均必填，未知结构字段拒绝。各项更详细的运行语义和独立任务 JSON 见 [任务规范](tasks.md)。

| 表 | 必填字段 | 可选字段 |
| --- | --- | --- |
| `tasks` | `id,title,description,notes,projectId,sectionId,parentId,priority,labelIds,order,expanded,planDate,completedAt,deletedAt,createdAt,updatedAt,revision` | `deletionId,planTime,zone,fold,deadline,durationMinutes,repeat,reminderMinutes,link,comments` |
| `taskProjects` | `id,name,color,icon,parentId,order,favorite,archivedAt,deletedAt,revision` | `deletionId,view` |
| `taskSections` | `id,projectId,name,order,deletedAt` | `deletionId,revision` |
| `taskLabels` | `id,name,color,favorite,deletedAt` | `revision` |
| `taskCompletions` | `id,taskId,title,at,occurrence` | `reverts,next,cycle` |
| `taskAttachments` | `id,taskId,name,type,bytes,sha256,content` | 无 |

身份为小写 UUID；归类及父 ID 可为 null 表示收件箱、无分区、根任务。`priority` 为 1/2/3/4，`order` 和 `revision` 为非负安全整数。颜色为 `#RRGGBB`，图标是至多 16 字符的惰性文字/表情。名称和标题非空、至多 500 字符；描述/备注/评论至多 20000，禁 NUL 等控制符。任务最多 100 标签、1000 评论；层级最多 32，禁止循环及跨项目/分区的父子关系。全部任务及组织/完成记录去重、验证必要引用。副本保留同名标签，按身份区别，不覆盖名称相同的现有标签。

日期是有效 `YYYY-MM-DD`（1900–9999），`planDate` 可 null，截止日期独立；具体时间 `HH:mm` 必须同时提供计划日期与 IANA 时区，`fold` 为 earlier/later。持续分钟数 0–525600，提醒提前分钟 0–43200，提醒需具体时刻。时间戳为非负有效 Unix 毫秒，任务实现还约束在可用的四位公历年份范围。布尔字段不接受数值代替；可选字段省略，不用 null 代替（已明确可 null 的归类、日期、状态除外）。

- `repeat`：`{frequency,interval,anchorDate}`，可选 `weekdays,monthDays,until`。frequency 为 day/week/month/year；interval 为 1–3660；原始锚点不晚于当前计划日期。weekdays 为 weekly 的不重复 0–6 星期数组，monthDays 为 monthly 的不重复 1–31 数组；结束日期含当日。重复父任务的子树不得另有独立重复规则。
- `view`：`{mode,calendar,sort}`，mode 为 list/board/calendar/table，calendar 为 month/week，sort 为 order/priority/date/title。
- `comments`：数组，每项 `{id,text,createdAt,updatedAt,deletedAt}`。deletedAt 可 null；删除评论仍保留内容，可恢复。
- `link`：`{library,bookId,title}`，可选 `editionId,chapterId,position,unconfirmed`。title 是真实关联时的名称快照，不冒充当前作品标题。章节需版本；position 为 `{from,to,quote,contentHash}`，非负文档位置、to≥from、上限 10000000，引用文字最多 2000，contentHash 是当前编辑器既有 16 位正文指纹，**不是安全校验 SHA-256**。正文变动后不猜测新位置。工程内 link 必须确认、归属根作品；断开的目标在相应 detached 数组声明，存在的目标还须匹配版本/章节关系。
- 完成事件 `occurrence` 为本次计划日期或 null，`reverts` 指向同任务已发生且尚未被撤销的完成事件；不得重复撤销或指向撤销事件。`next` 是本次重复计算出的下一日期。`cycle` 保存恢复周期需要的最小 `{taskId,planDate,completedAt,revision}[]`；修订号是推进后的防覆盖检查值，不保存第二份正文/描述。成员后来移动、重新关联或缺失时，只保留历史状态与身份，恢复不能覆盖其后续改动。
- 附件 `content` 是标准 Blob `$resource` 引用，原始字节、MIME 和 `sha256` 一致。附件名只作显示/下载，不作 ZIP 路径，禁止斜线、反斜线和控制符，最多 255 字符。允许的媒体、签名和 UTF-8 规则见任务规范；每个最多 16 MiB，累计 64 MiB，仍受工程整体限制。无自动执行、自动打开或嵌入预览。

**归属闭包**：只收集 `link.library/bookId` 确认指向根作品的任务，包括完成和删除状态；同一子树统一归属。组织只包含任务实际引用的项目与祖先、分区、标签。完成/附件只能属于这些任务。每个任务的父、项目、分区、标签必须实际存在，不能以 detached 豁免。全局个人任务、其他作品任务、待确认的外部链接、全局模板/过滤器和本机提醒/视图设置不导出。

`detached.tasks` 仅声明周期历史成员的断开任务身份，重新计算并严格比对，不包含任务当前的个人描述、评论或附件，也不能代替存活任务关系。这样原成员后来移出作品时可保留真实历史，而不把它当前的其他个人内容混入小说。保留原身份导入也检查这些历史身份冲突；副本同步重映射历史身份、周期成员、父/项目/分区/标签、评论和附件引用。

Schema 1/2 读取时使用原有十表规范，验证原有四组 detached，再在内存中正规化六个空任务表和空 detached.tasks。原文件字节不改写，不虚构任务；再次导出用 Schema 3。旧版本不能读取新的六表结构，界面和文档明确提示，不承诺前向兼容。
