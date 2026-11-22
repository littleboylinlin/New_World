## 尚未发布

- **故事设定画布**　从编辑器顶栏的「设定」打开本书的白板。桌面版打开独立窗口，Web 版打开新标签页。可以平移和缩放，也可以双击空白处建卡、拖动调整布局或大小、摆放文字和图片。选中元素后可添加分组框一起移动。画布支持框选、多选、复制粘贴、撤销和重做，自动保存布局与视角。
- **自由卡片和关系**　卡片只需填写名称，可添加别名、多个自定义彩色标签、任意键值字段和正文。人物、地点模板可以随意修改。拖动卡边可连到卡片、文字或已有关系线，双击线可改关系名，还可调整箭头、线型和颜色。从编辑器打开时，新卡默认关联当前章，仍可修改章节或添加从某章起生效的状态。卡片列表可按名称或别名定位，删除的卡片可在回收站恢复。

### 升级与回退

- 新版把本地书库升级到 IndexedDB v13，添加画布表和回收站的作品索引。v0.30.0 及更早版本无法直接打开升级后的书库。
- 新导出的全库备份使用格式 4，单部 `.newworld` 工程使用 Schema 4。两者保存画布、布局、视角和卡片回收记录。v0.30.0 及更早版本会拒绝这两种新格式。新版仍可读取全库备份格式 1–3 和工程 Schema 1–3。
- 全库恢复会替换当前书库的画布。旧备份恢复后画布为空。需要回退时，请在升级前用旧版保留一份全库备份。

## Unreleased

- **Story canvas**　Open a work’s whiteboard from **Story settings** in the editor toolbar. The desktop app opens a separate window, and the web app opens a new tab. Pan, zoom, double-click to add cards and arrange or resize them. Add text and images, put selections into frames and move them together. The canvas supports marquee selection, copy and paste, undo and redo. It remembers the layout and view.
- **Free-form cards and connections**　Cards require a name and can carry aliases, multiple custom colored tags, key/value fields and body text. Character and location templates are editable starting points. Drag from a card edge to connect to a card, text or an existing line. Double-click a line to name it, and edit its arrow direction, line style and color. New cards link to the chapter that opened the canvas. Chapter links and chapter-based states remain editable. Find cards by name or alias in the card list and restore deleted cards from Trash.

### Upgrade and rollback

- The local library upgrades to IndexedDB v13, adding a canvas store and a work index for Trash. New World v0.30.0 and earlier cannot open the upgraded library.
- Full-library backups use format 4 and `.newworld` projects use Schema 4. Both preserve the canvas, layout, view and trashed cards. New World v0.30.0 and earlier reject these exports. The new version still reads backup formats 1–3 and project Schemas 1–3.
- A full-library restore replaces the current canvases. Restoring a legacy backup leaves an empty canvas. Keep a backup made in the older app before upgrading if you need to roll back.
