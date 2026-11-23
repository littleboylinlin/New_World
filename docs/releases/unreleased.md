## 尚未发布

- **故事设定画布**　从编辑器顶栏的「设定」打开本书的白板。桌面版打开独立窗口，Web 版打开新标签页。画布铺满窗口，工具都是浮在上面的小岛：顶部一排工具（选择、套索、平移、卡片、箭头、文字、分组框、图片、橡皮擦，手机上在底部），左上角菜单收着卡片列表、标签、回收站、导出和设置，左下角是缩放和撤销。选中对象时才出现属性面板，面板和输入框会让开被操作的对象。布局与视角自动保存。
- **像白板一样顺手**　快捷键 V／1 选择、L 套索、H 平移、R／2 卡片、A／5 箭头、T／8 文字、F 分组框、9 图片、E／0 橡皮擦，画完自动回到选择，按 Q 或双击工具按钮可以锁定连续画。双击空白处新建卡片，双击卡片直接改名，回车打开完整编辑面板。支持框选、套索（按住拖出任意形状，松手自动闭合，选中被圈住的对象）、Shift 加选、拖动时的对齐参考线（按住 Ctrl／⌘ 暂时不吸附）、方向键微移、Ctrl／⌘ + D 复制一份、复制粘贴和撤销重做。滚轮或双指滑动平移，Ctrl／⌘ + 滚轮或捏合缩放，Shift + 1 适应全部内容；拖到画布边缘时自动滚动。
- **套索选择**　用套索可以圈出不规则的一片：卡片、文字、图片和分组框按中心点是否在圈内判定，箭头要起点、终点和中点都在圈内。画的时候显示虚线轨迹，松手后淡出，自动回到选择工具，可以直接拖动整组。手机上选择和套索共用一个按钮，再点一次切换，长按可直接选。
- **箭头连线**　用箭头工具从卡片里或边缘附近拖出，靠近另一张卡片、文字或连线时高亮，松手就建立关系；松在空白处则留下终点悬空的箭头，之后可再拖过去。箭头两端始终贴在卡片边缘，卡片移动或改变大小时跟着走。选中箭头后可拖两端改连、拖中点调成弧线，双击箭头在中间写关系名。同一对卡片同方向的关系不会重复建立，提示里可选「仍然新建」；反方向或多条关系自动错开成弧线。线宽和箭头在缩小时仍清楚可见。
- **自由卡片**　卡片只需填写名称，可添加别名、多个自定义彩色标签、任意键值字段和正文，人物、地点模板可以随意修改。画布上的卡片只显示名称和第一个标签的颜色，鼠标停在卡片上可在旁边看到别名、字段和正文，手机上选中卡片时在底部面板里显示。卡片列表可按名称或别名定位，删除的卡片可在回收站恢复。
- **关联章节**　卡片可以关联全书（在每一章都有效）、一个或多个章节，也可以不关联，仍可添加从某章起生效的状态。新卡默认关联编辑器正在写的那一章，编辑器换章节时跟着变；在设定窗口里手动改成全书、其他章节或多选几章后，就保持手动选的，也可以改回跟随编辑器。左上角只显示小说名，选中卡片时后面跟上卡片名；鼠标停在小说名上（手机上点一下）会浮出新卡默认关联，点开即可修改。编辑器「设定」按钮上的数字是本章有效的卡片数，全书卡片也算在内。
- **多个窗口**　左上角菜单的「新窗口」可以为同一本书再开一个设定窗口（Web 版是新标签页），各自保留自己的位置和缩放，内容实时同步。从编辑器点「设定」时会回到已经打开的窗口，不会每次都多开一个。
- **导出**　菜单里可以把整张画布或选中的内容导出为 PNG 图片，也可以直接导出本书的 `.newworld` 工程。

### 升级与回退

- 新版把本地书库升级到 IndexedDB v13，添加画布表和回收站的作品索引。v0.30.0 及更早版本无法直接打开升级后的书库。
- 新导出的全库备份使用格式 4，单部 `.newworld` 工程使用 Schema 4。两者保存画布、布局、视角和卡片回收记录。v0.30.0 及更早版本会拒绝这两种新格式。新版仍可读取全库备份格式 1–3 和工程 Schema 1–3。
- 全库恢复会替换当前书库的画布。旧备份恢复后画布为空。需要回退时，请在升级前用旧版保留一份全库备份。

## Unreleased

- **Story canvas**　Open a work’s whiteboard from **Story settings** in the editor toolbar. The desktop app opens a separate window, and the web app opens a new tab. The canvas fills the window and every control floats on it: one row of tools at the top (Select, Lasso, Hand, Card, Arrow, Text, Frame, Image, Eraser; at the bottom on phones), a menu at the top left with the card list, tags, Trash, export and settings, and zoom and undo at the bottom left. Properties appear only for a selection, and panels and fields move aside from what you are editing. Layout and view are saved automatically.
- **Whiteboard feel**　Shortcuts: V/1 select, L lasso, H hand, R/2 card, A/5 arrow, T/8 text, F frame, 9 image, E/0 eraser. Drawing switches back to Select; press Q or double-click a tool to keep it. Double-click the background for a new card, double-click a card to rename it, and press Enter for the full editor. Marquee, lasso and Shift selection, alignment guides while dragging (hold Ctrl/⌘ to turn snapping off), arrow-key nudging, Ctrl/⌘+D to duplicate, copy and paste, undo and redo. Scroll or swipe with two fingers to pan, Ctrl/⌘+scroll or pinch to zoom, Shift+1 to fit everything; the canvas scrolls when you drag to its edge.
- **Lasso selection**　Draw a free-form loop with the lasso; it closes when you let go. Cards, text, images and frames are picked when their middle is inside, arrows when their start, end and middle all are. The dashed trail fades after release, the Select tool comes back, and the group can be dragged right away. On phones Select and Lasso share one button: tap it again to switch, or hold it to choose.
- **Arrows**　With the Arrow tool, drag from inside or near a card. Cards, text and lines highlight as you approach, and releasing connects them; releasing on the background leaves a loose end you can attach later. Arrow ends stay on card edges when cards move or resize. Select an arrow to drag its ends to other cards or curve it from the middle, and double-click it to name it in place. A second arrow in the same direction between two cards is caught, with **Add anyway** in the note; opposite or extra arrows curve apart. Lines and arrowheads stay clear when zoomed out.
- **Free-form cards**　Cards require a name and can carry aliases, multiple custom colored tags, key/value fields and body text. Character and location templates are editable starting points. On the canvas a card shows its name and its first tag’s color; hover it to see aliases, fields and text beside it, or select it on a phone to see them in the bottom panel. Find cards by name or alias in the card list and restore deleted cards from Trash.
- **Chapter links**　A card can apply to the whole work (in every chapter), to one or more chapters, or to no chapter, and can still carry states that start at a chapter. New cards link to the chapter open in the editor and follow it as the editor moves; choose the whole work, other chapters or several chapters in the story window and that choice stays, until you switch back to following the editor. The top left shows only the work’s name, followed by the selected card’s name; hover the name (tap it on a phone) to see and change where new cards link. The number on the editor’s **Story settings** button counts the cards in effect in the current chapter, whole-work cards included.
- **Several windows**　**New window** in the top-left menu opens another story window on the same work (a new tab on the web). Each keeps its own position and zoom, and the content stays in sync. **Story settings** in the editor brings back the window already open instead of opening another each time.
- **Export**　From the menu, export the whole canvas or the selection as a PNG image, or export the work as a `.newworld` project.

### Upgrade and rollback

- The local library upgrades to IndexedDB v13, adding a canvas store and a work index for Trash. New World v0.30.0 and earlier cannot open the upgraded library.
- Full-library backups use format 4 and `.newworld` projects use Schema 4. Both preserve the canvas, layout, view and trashed cards. New World v0.30.0 and earlier reject these exports. The new version still reads backup formats 1–3 and project Schemas 1–3.
- A full-library restore replaces the current canvases. Restoring a legacy backup leaves an empty canvas. Keep a backup made in the older app before upgrading if you need to roll back.
