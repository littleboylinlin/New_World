## 尚未发布

- **故事设定库**　从编辑器顶栏的「设定」打开本书的卡片库。桌面版打开可独立移动的窗口，Web 版打开新标签页。支持五种分类、名称与别名搜索、模板、命名关系、章节关联和从指定章节起生效的状态。删除的卡片可以从回收站恢复。

### 升级与回退

- 新版会把本地书库升级到 IndexedDB v12，添加设定卡片表和回收站作品索引。v0.30.0 及更早版本无法直接打开升级后的书库。
- 新导出的全库备份使用格式 4，单部 `.newworld` 工程使用 Schema 4。v0.30.0 及更早版本会拒绝导入这两种新格式。新版仍可读取全库备份格式 1–3 和工程 Schema 1–3。
- 全库恢复会替换当前书库的设定卡片。旧备份没有卡片，恢复后设定库为空。需要回退时，请在升级前用旧版保留一份全库备份。

## Unreleased

- **Story settings**　Open a work’s card library from **Story settings** in the editor toolbar. The desktop app opens a movable window, and the web app opens a new tab. Use five categories, search by name or alias, start from a template, link chapters, name relationships and record states from a chosen chapter. Deleted cards can be restored from Trash.

### Upgrade and rollback

- The local library upgrades to IndexedDB v12, adding a story card store and a work index for Trash. New World v0.30.0 and earlier cannot open the upgraded library.
- New exports use full-library backup format 4 and `.newworld` project Schema 4. New World v0.30.0 and earlier reject both new formats. The new version still reads backup formats 1–3 and project Schemas 1–3.
- A full-library restore replaces the current story cards. Restoring from a legacy backup leaves an empty card library. Keep a full-library backup made in the older app before upgrading if you need to roll back.
