# New World

[简体中文](README.md)

New World is a local novel manager. The original library is for writing and managing your own novels; the continuation/imitation library organizes continuation projects by source work. The latest version is on [GitHub Releases](https://github.com/littleboylinlin/New_World/releases/latest); what changed in each version is in the [release notes](docs/releases).

## Smooth writing (v0.20.1)

The editor caret follows the current line's text size and theme. Typing on the same line uses smooth frame-by-frame following; clicks, navigation, undo/redo and line changes position it immediately. It hides for a selection or loss of focus. During IME composition it follows the native input position without changing the platform's selection. Window zoom, scrolling, fonts, images and table layout changes resynchronize its position.

“Settings → Appearance → Typewriter mode” is off by default. When enabled, typing and newlines keep the current line near the middle of the editor. Scrolling to browse pauses following until you type again. Caret transitions and centering respect the system's reduced-motion preference.

“Settings → Appearance → Smooth caret and typing” is on by default. Turn it off to use the system caret in the text and in every field; the change applies at once and is saved on this device.

Word counts, the chapter outline and search results update after about 400ms without typing; autosave waits about 500ms. Manual saves and leaving a chapter still save immediately. Continuous typing no longer repeatedly scans the whole chapter or serializes save snapshots, so displayed counts may lag slightly. Database v9, project Schema 3 and full-library backup format 2 remain as in v0.19.0. See the [v0.20.1 release notes](docs/releases/v0.20.1.md).

## Local task workspace (v0.19.0)

v0.19.0 ships an offline task workspace. It needs no account and has no Todoist cloud sync or account system. Projects, subtasks, filters, recurrence, reminders while running, four shared views, comments, attachments, templates, completion statistics and structured JSON transfer integrate with work/chapter links and manual idea conversion.

**Back up in v0.18.1 before upgrading and keep that backup.** v0.19.0 upgrades IndexedDB v8 to v9, reads `.newworld` Schema 1/2/3 and writes Schema 3. Full-library backups use format 2 while the reader still accepts format 1. v0.18.1 cannot directly open v9, import Schema 3 or restore format 2; rolling back requires a pre-upgrade backup. Novel projects include only confirmed work-owned tasks; personal tasks and device preferences are excluded. See [task behavior, ownership, tests and limits](docs/tasks.md) and the [Schema 3 sample](docs/examples/雾港-创作任务.newworld). Local reminders are checked only while the app is running and the renderer is active. Background checks may be delayed; fully exiting, closing the browser or shutting down stops notifications. See the [v0.19.0 release notes](docs/releases/v0.19.0.md) for downloads and upgrade guidance.

## Native projects

Export a complete `.newworld` project from a work's shelf menu; import from the home or library page. Projects retain editions, sources, rich text, annotations, covers and related history. Imports are validated and previewed before a single atomic library transaction; conflicts can be skipped or imported as independent copies. Desktop file associations open the import flow.

Editing continues in the local library. Export again to save an updated project file; changes are not automatically written back. Existing manuscript exports remain available and do not carry complete project state. See the [format specification](docs/newworld-format.md) and [Schema 1 sample](docs/examples/雾港.newworld). v0.18.0 introduced IndexedDB v8; v0.19.0 upgrades it to v9 by adding task stores without rewriting existing works. Older apps cannot directly open the upgraded library; rolling back requires a pre-upgrade backup.

## Work information (introduced in v0.18.1)

v0.18.1 adds optional author, subtitle, multiline synopsis, tags and creative status to original and continuation works. Enter them during creation or use “Edit work information” from the work menu or details to update or clear them. Existing works receive no default author or status. TXT, Markdown, HTML, DOCX, PDF and EPUB exports offer three optional work-information switches, all off by default, using the existing converters.

v0.18.1 reads Schema 1 and 2, and writes Schema 2. Work information and safe, bounded unknown JSON extensions survive project round trips; unsupported structures are explicitly rejected. Older v0.18.0 only reads Schema 1 and cannot read Schema 2. That release used database v8 without rewriting existing records; the current database is v11, projects write Schema 3, and full-library backups write format 3 (see compatibility below). See the [compatibility rules](docs/newworld-format.md), [Schema 2 metadata sample](docs/examples/雾港-作品信息.newworld) and [v0.18.1 release notes](docs/releases/v0.18.1.md).

## Windows desktop

The current stable release for Windows and macOS is the [latest GitHub release](https://github.com/littleboylinlin/New_World/releases/latest); both platforms ship the same version, and what changed in each one is in the [release notes](docs/releases). Read the backup guidance above before upgrading or rolling back. Existing complete project migration, file associations, reading annotations and manuscript exports remain available. See the [project format specification](docs/newworld-format.md) and [Reading annotations](docs/reading-annotations.md) for usage and limitations, and `AI_INTEGRATION.md` for the AI protocol. Update checks select only the installer for the current platform.

Download `New-World-Setup-<version>-x64.exe` from [GitHub Releases](https://github.com/littleboylinlin/New_World/releases). The target platform is Windows 11 x64; it installs for the current user and does not require Node.js. The installer is not Authenticode-signed, so Windows may warn about an unknown publisher. Verify it with PowerShell's `Get-FileHash <installer> -Algorithm SHA256` against `SHA256SUMS.txt` on the same release page.

The setup wizard accepts a new or empty install directory. Upgrades keep the existing install location by default. The finish page shows the actual path and offers "Create a desktop shortcut" and "Launch New World". A Start Menu entry is always created.

Both libraries, editing, and export work offline. Desktop data is stored in `%APPDATA%\NewWorld` by default; overwrite installs and normal uninstalls keep this directory. Use "Settings" in the bottom-left to change the library storage location and to choose whether closing the window quits the app or keeps it running in the background. The footer shows the current storage location.

The standalone Settings page organizes General, Appearance, Quick capture, Storage, Backup & restore, AI integration, and Updates & about. The web version explains that closing and storage are managed by the browser.

## macOS desktop

macOS 13 Ventura and later are supported, with separate DMGs for Apple Silicon (arm64) and Intel (x64). Download the DMG matching your chip — `New-World-<version>-macos-arm64.dmg` or `New-World-<version>-macos-x64.dmg` — from [GitHub Releases](https://github.com/littleboylinlin/New_World/releases), open it, and drag New World into Applications.

The app is locally signed, not yet signed or notarized with an Apple Developer ID, so macOS may ask you to confirm the source on first launch. Verify downloads with `shasum -a 256 <installer>` against `SHA256SUMS.txt` on the same release.

Libraries are stored in `~/Library/Application Support/NewWorld` by default; language selection and cache live in `~/Library/Application Support/NewWorld-languages`. Replacing or deleting the app does not delete your libraries. On first launch the app downloads only the language pack matching the system language, and works offline afterwards.

The title bar leaves room for the red/yellow/green window buttons. "Settings" in the app menu opens with `⌘ + ,`; editing and saving use `⌘` shortcuts. Close behavior, storage location, and Chinese/English switching are all in the same settings page; after choosing "Keep running", reopen the app from the menu bar icon or the Dock.

Mac update checks match only the DMG for the current chip. After clicking "Update and restart", downloading and verification happen in the app cache while you can keep writing. The app prepares the complete new app bundle and the selected language pack, saves your text, quits, and atomically swaps the whole bundle; the old bundle is removed only after the new interface opens successfully, and a failed launch restores the old version. The install location must be writable — you cannot update directly from a read-only DMG. Windows installers and DMGs for other chips never trigger a Mac update.

Mac users upgrading from v0.9.x still follow the old flow once: download the DMG and replace the existing app manually. Later updates use the whole-bundle swap. Manually saved installers are kept.

## Interface language

Simplified Chinese and English are supported. The Windows installer bundles both language packs (since v0.27.1), while first Mac launch downloads only the pack matching the system language from the mirror with GitHub fallback (Chinese systems get Simplified Chinese, others get English). Language packs are also published alongside installers; the app and installer verify size and SHA-256 and retry on failure before continuing.

Pick a language in "Settings → General" and apply it. The app saves your text first, then fetches any language pack not yet downloaded; if the download fails, the current language is kept. Downloaded languages work offline, and the selected language persists across restarts and upgrades. Work titles, chapter titles, and body text never change with the interface language. The web version picks the browser language on first visit and requests only the pack it needs.

Language preferences and the desktop language cache are stored in `%APPDATA%\NewWorld-languages`, unaffected by library storage changes. Normal uninstalls keep the cache. For offline pack placement, put the required pack from the same release at `%APPDATA%\NewWorld-languages\packs\0.30.0\zh-CN.json` or `en.json`; it is used once verification passes.

The app bar at the top of the window doubles as the title bar and can be dragged to move the window; the minimize, maximize/restore, and close buttons at the top-right are drawn by the app and show no system tooltip on hover. Zoom with `Ctrl` + `+`, `-`, `0`; fullscreen with `F11`. In full screen the top-right buttons become “Exit full screen” and close, and on macOS the app bar takes back the space of the traffic lights. Desktop libraries and browser libraries are stored separately; existing browser data remains accessible in the original browser and address.

## Appearance

"Settings → Appearance" sets the theme, English font, Chinese font and text size. Changes apply right away. The "Aa" button in the reading and editor toolbars opens a small panel for the theme, text size and English font; "More settings…" opens the full settings.

- Theme: Match system, White, Dark, Beige, or Soft Paper (introduced in v0.28.0), applied to the whole app. The default follows the system's light or dark mode. The app bar doubles as the window title bar and stays dark in every theme.
- English font: Times New Roman (default), Georgia, Lora, Inter or System Sans. Lora and Inter ship with the app and work offline; their licenses are in `src/fonts/` and in `licenses/` of the build.
- Chinese font: Auto (default; Song with serif English fonts, otherwise Hei), Song, Hei or Kai, using the fonts installed on the system. Chinese characters, which the English fonts do not contain, use the chosen Chinese font.
- Text size: shared by reading and writing, 14 to 28 px, with a reset to the default.
- Layout: line spacing (compact, standard, relaxed), paragraph spacing (none, standard, wide), a two-character first-line indent, and text width (narrow, standard, wide).
- Spell check: off by default. When on, only the English spelling of the chapter text is checked; titles and form fields are not. Right-click a marked word to pick a suggestion or add it to the dictionary. The Windows app ships US and UK English dictionaries, so it works offline and never downloads one on its own. Other Chromium `.bdic` dictionaries can be imported in the settings or downloaded from an https link you enter (the file name must match the one in Electron's `hunspell_dictionaries.zip`, such as `fr-FR-3-0.bdic`). The link itself must be https; if the server redirects to plain http the download still completes, with a warning to check the source. Added dictionaries are used together with the built-in ones and can be removed at any time, which deletes the file right away; macOS uses the system spell checker and the web version the browser's.

Appearance is saved on this device. On the desktop it moves together with the library storage location, and the chosen theme is also kept in `NewWorld-appearance.json` so the window opens with the matching background instead of flashing light first. Exported DOCX and PDF files and printing always use black text on white paper with the fonts of the export style; EPUB fonts and colors are controlled by the reader.

## Running

Node.js 22.16 or newer is required. CI runs on Node.js 24.

```sh
npm ci
npm run dev
```

Open the local address printed in the terminal in a browser. `npm run build` produces a static site that can be hosted over HTTPS; `npm run preview` serves the production build locally.

## Version updates

On every launch the app checks this repository's GitHub Releases once in the background. The running version shown in the interface comes from `package.json` at build time. Checks compare by SemVer; ordinary commits, standalone Git tags, drafts, and prereleases never trigger update notifications. If there is no update or the network fails, the library opens normally.

"Updates & about" in Settings offers a manual check, the version number, and release notes. When a new version is found, a non-modal notice appears; you can dismiss the same version for the current session. "View update" opens the release notes in Settings directly.

- The desktop app first reads `https://dl.writenewworld.com/latest.json`, an R2 mirror updated when a stable release is published, and asks the GitHub API only when that fails or has no installer for this platform. Downloads start from GitHub and the mirror at once; whichever delivers the first 1 MB continues and the other is stopped. The file is always checked against the size and SHA-256 in latest.json, and a failed or interrupted download is retried from the other source; only when both fail is an error shown.
- The Windows version picks the stable Windows x64 installer with a SHA-256 checksum from the latest 100 GitHub Releases. After clicking "Update and restart", download progress is shown in the app. You can keep writing during the download. Once the installer passes verification, the app saves your text, closes the window, and overwrites the original install directory, then launches automatically after installation.
- If saving fails, the window stays open; save or save-as, then continue the update. Versions v0.6.0 and earlier need one manual overwrite install of v0.7.0 or newer first.
- The web version doesn't contact GitHub. When the page opens and when you return to the tab, it quietly compares itself with the `version.json` published with the site; after a new deploy, a small "A new version is ready" note appears in the corner and saves your text before reloading.
- The web version keeps data in the browser: it requests persistent storage at start (see Settings → Storage). In Chrome and Edge you can choose a local folder on the same page, where each work is written as a `.newworld` file after every autosave, and choosing that folder again brings back works the browser doesn't have. If nothing has been exported for 7 days, it reminds you once, with a one-click download and a way to turn the reminder off. For long-term writing, use the desktop app.

After a normal update, the Windows installer removes old program files; both platforms reclaim update-download caches managed by the app and clean up older language packs after the new interface opens successfully. Version changes also refresh stale page and compilation caches without clearing the IndexedDB library. Mac also cleans recognizable interrupted old-version downloads from the default Downloads directory. Files temporarily locked by the system are retried and, if still failing, kept for a later launch. Libraries, settings, the current version's language pack, manually saved installers, and unknown files are all kept.

Checks fetch only public version metadata anonymously. Novels, source files, and manuscripts stay on your machine.

## Reading and editing

A work page in the original library switches between the **source file** and each **edited version**. Convertible sources use "Convert to manuscript" to create an independent body of text; PDFs use "Extract text as manuscript". Works in any format can also get a new blank manuscript. "Save as independent version" copies the current chapter and text so you can try a different approach.

After importing a source work into the continuation/imitation library, each work gets a project. The project's "Continuations" list creates and opens independent continuation drafts; the "Sources" list reads, downloads, and adds files for the same source work. When needed, choose "Continue from this source" on the source reading page. Source works and manuscripts imported by older versions appear directly in the corresponding lists, and previously standalone drafts can add sources within their project.

- The chapter table of contents supports creating, renaming, moving up/down, switching, and confirmed deletion, and shows each chapter's word count. Above the text, chapter and whole-book counts are shown. The chapter title can be used for navigation; counts follow word processors: each Chinese character or Chinese punctuation mark counts as one, each English (or other space-separated) word counts as one, and mixed text adds both.
- The editor provides paragraphs, headings, bold, italic, underline, lists, quotes, horizontal rules, and local images. Native browser selection, clipboard, and Chinese IME input are supported.
- `Ctrl / ⌘ + S` saves, `Ctrl / ⌘ + F` finds within the chapter, `Ctrl / ⌘ + B/I/U` toggles inline styles, `Ctrl / ⌘ + Z` undoes, `Ctrl / ⌘ + Shift + Z` redoes. Find matches literally and can replace one or all occurrences. Undo history belongs to the current chapter's editing session.
- "Reading mode" keeps the table of contents and find; editing can be restored with "Edit text". At phone widths the chapter list can be expanded and the toolbar scrolls horizontally.
- Reading mode and text source previews let you select text to add annotations, with lightweight inline previews or color highlights, hover previews, click-to-pin, multiline editing, deletion, and persistence after reopening. Overlapping ranges retain every annotation. PDF canvas previews are currently unsupported; source or formatting changes invalidate old anchors and display a notice. See [Reading annotations](docs/reading-annotations.md).
- "Focus" hides the chapter list, the buttons around the text and the footer, leaving only the chapter; the toolbar fades until pointed at. Press `Esc` or click again to leave; leaving the page also ends it.
- Right-click a chapter in the chapter list to add, rename, move or delete chapters.
- Page navigation, chapter switching, dialogs, and notices have transition animations. Animations are skipped when the system's "reduce motion" is enabled.

## Work cards

Each work card on the shelves shows the cover with the title below it. Click the arrow next to the title, or right-click the card, to open, rename, change the cover, archive or delete the work.

- The default cover is drawn from the title. "Change Cover…" uploads a PNG, JPEG, WebP, GIF, AVIF or BMP image (up to 32 MB), kept locally at full quality without compression; "Use Default Cover" switches back.
- Custom covers are saved and restored with backups.

## Quick notes

Jot an idea down the moment it comes, and pick it up later while writing.

- Desktop: press the global shortcut anywhere (`Ctrl + Alt + N` by default, `⌃⌥N` on a Mac) to open a small window. `Enter` saves, `Shift + Enter` adds a line, `Esc` closes. "Settings → Quick capture" switches it to `Ctrl + Shift + Space`, `Alt + Shift + N` or off, and warns when another app already uses it. The tray menu, the right-click menu of the Windows taskbar icon and the Mac Dock menu open it too.
- Web: press `Ctrl + Alt + N` on a New World page to open the quick note dialog.
- A note is linked to the work opened most recently, or to none. "Notes" on the home page lists every note with unused ones first; mark them used, link them to another work, copy them, or delete them (with undo).
- "Notes for this work" sits under the chapter list and stays beside the text as it scrolls. "Insert" puts a note at the cursor and marks it used, and a new note can be written there too; the "Notes" toolbar button shows how many are unused and folds the list.
- On the desktop, right-click selected text to "Save as Note". Notes are saved and restored with backups.

## Desktop menus

- Tray menu: Quick note, New novel, Recent Works (up to 5), Notes, Back Up Now, Open Folder, Settings, Show New World and Quit completely.
- Text right-click menu: spelling suggestions and Add to Dictionary, Cut, Copy, Paste, Select all, and Save as Note.

## Writing stats

The home page shows writing stats below the library lists: a heatmap that records words per day, plus cards for the day streak and total words.

“Reminders and tasks” on the home page lists tasks that are overdue, due today, or due or reminding within the next 7 days, up to 8; “View all” opens the rest on the task page. Tick one to complete it (with undo). A task linked to a work opens that chapter and passage; any other task opens its details. On wide windows the card takes a column of its own on the right. “Recent projects” switches between a list and covers, remembered on this device.

- The heatmap covers the past year; each square is one day, and darker means more written that day. Pointing at a square or focusing it with the arrow keys shows that day's date and word count; days with no writing show "No writing", and today is marked separately.
- Counts follow the editor: each Chinese character or Chinese punctuation mark counts as one, and each English (or other space-separated) word counts as one. A day is credited only when a save increases the word count; deleting or editing text never subtracts.
- The day streak counts back over consecutive days with writing, starting today (or yesterday if today has none yet); total words is the sum across every chapter currently in the library.
- Writing days are global history stored separately, so deleting a work or emptying the trash never erases them. At phone widths the heatmap scrolls horizontally, colors follow the White, Dark and Beige themes, and animations are skipped when the system's "reduce motion" is enabled.

## Trash

Deleting a work, a continuation project's source, an edited version, or a chapter moves the content to the trash. The notice at the bottom of the page right after deletion can undo it directly. "Trash" in the header lists deleted content, which can be restored to its original place, permanently deleted, or emptied all at once.

- Trash keeps deleted items indefinitely without automatic expiration until you restore them or permanently delete them after secondary confirmation. Trashed content still occupies local storage.
- Restored chapters return to their original order. When restoring an edited version whose name already exists, "restored" is appended to the name.
- If the owning work or version was also deleted, restore it first. If the same source file was re-imported after deletion, delete the newly imported copy first.

## Archive

Every work card's menu has "Archive". Archived works disappear from the original and continuation/imitation libraries and the home counts but keep everything; the notice at the bottom of the page can undo it. "Archive" on the home page and "View archive" beside each library list show all archived works, which can still be opened, edited and exported, moved back to their library with "Unarchive", or deleted to the trash.

## Version history

Since v0.15.1, complete pre-edit chapter and idea revision snapshots (`revisions`, deduplicated compressed `revisionBlobs`, and `ideaRevisions`) are recorded automatically in a strict IndexedDB transaction before AI edits or restorations, along with persistent per-client AI cumulative-loss baselines (`aiBaselines`) to catch gradual content loss across edits or restarts.

- Open “⋯ → History” in the editor or history on Ideas to preview snapshots, restore an older version (automatically backing up the current text first), or prune older revisions after confirmation.
- Permanently deleting a work or emptying the trash cascades safely to unreferenced revisions and baselines using reference counts.

## AI assistance and local integration

- **Built-in AI services (v0.27.0)**: Connect your own API endpoints and keys in “Settings → AI integration” (`OpenAI Chat Completions`, `OpenAI Responses`, `Anthropic Messages`, and `Gemini`). Save multiple profiles, assign different profiles to polishing, asking, proofreading, and summaries, and import or export profiles without keys. On desktop, keys are encrypted in the system keychain; on the web, keys stay unsaved unless you opt in on that device. Requests go only to your configured endpoint, with a confirmation prompt before first use.
- **In-editor and web-pane assistance**: Select text to polish, rewrite, expand, shorten, change tone, or ask questions; proofread a selection or chapter; or summarize a selection, chapter, or the whole book (caching per-chapter summaries locally so unchanged chapters are skipped). Polishing, rewriting, and proofreading open in a side-by-side diff view where you can accept all, accept or reject individual changes, insert below, or discard, saving a pre-edit revision snapshot first. On desktop, web panes can also summarize the selection or page into ideas or tasks.
- **Writing styles library**: Create, edit, import, and export writing styles, summarize a style from sample chapters, assign default styles per work, and carry styles in full-library backups (v0.27.0).
- **Local AI integration API (`v1`)**: Desktop settings offer an optional loopback-only HTTP JSON API (off by default) for external local tools with per-client Bearer tokens, granular permissions and work scopes, mandatory manual confirmation for deletions and major reductions, and local audit logs; see `AI_INTEGRATION.md`.

## Backup and restore

"Settings → Backup & restore" packs both libraries, every edition, the original files, custom covers, the trash, quick notes, writing stats, chapter and idea revision history, writing styles, AI cumulative-loss baselines (`aiBaselines`), and all task data (including projects, labels, templates, filters, completion history and attachments) into one `.zip` file.

- Back Up Now: the desktop app saves to the backup folder; the web version downloads the file.
- Automatic backups (desktop): daily (default), weekly or off. When one is due it runs while the app is open; the newest 10 are kept, and backups made by hand or before a restore are never deleted automatically.
- Backup location (desktop): `New World Backups` in Documents by default; choose another folder, go back to the default, or open the folder.
- Encryption: none, or a password (AES-256, which tools such as 7-Zip can open). The desktop app keeps the password encrypted with the system keychain, so automatic backups are encrypted too; the web version asks for a password with each backup. A forgotten password cannot be recovered.
- Restore from Backup: choose a backup file and enter its password if it is encrypted. After confirming, the backup replaces the current library, all at once or not at all. The desktop app first backs up the current library to the backup folder (`New-World-before-restore-…zip`).
- v0.30.0 writes backup format 3, packing AI cumulative-loss baselines (`aiBaselines`) and restoring them together; it continues reading formats 1 and 2 (format 1 keeps existing tasks; legacy formats 1 and 2 without `aiBaselines` clear local baselines to empty instead of attaching mismatched local baselines to restored chapters). Older apps reject format 3; keep a pre-upgrade backup if you might roll back.
- Local-only data such as appearance, language, storage location, AI service configurations, API keys, and chapter summary caches are not included in backups.

## Format support

"Edit" means a source can be converted into an independent manuscript. "Export" means a manuscript can produce a new file in that format. Downloading the original is a separate operation that preserves the imported file name and bytes.

When exporting you can select chapters and preview the first selected one. PDF, DOCX, and HTML default to a standard black-on-white style, with compact and relaxed alternatives. TXT keeps paragraph spacing and Markdown keeps headings, lists, and other markup; both offer text previews. EPUB exports EPUB 3 (one file per chapter, with cover, local illustrations, title/author/language/unique identifier, and `toc.ncx` for older readers); fonts and colors are controlled by the reader.

| Format | Import source | Source preview | Convert to manuscript | Export manuscript | Known limits |
| --- | --- | --- | --- | --- | --- |
| TXT | Yes | Text | Yes | UTF-8 TXT | Manually switch between UTF-8, GB18030/GBK, Big5, UTF-16 LE/BE, and Windows-1252. Long paragraphs are split into chapters; export simplifies rich text and images to plain text. |
| Markdown | Yes | Source | Yes | Markdown | Keeps common headings, lists, quotes, and styles. Export simplifies underlines, images, and complex tables. |
| HTML | Yes | Body text | Yes | Standalone HTML | Converts common structure and embedded raster images; strips scripts, web styles, and remote resources. |
| RTF | Yes | Body text | Partial | — | Supports text, Unicode and common ANSI encodings, and basic inline styles. Images, complex lists, and tables stay in the source. |
| DOCX | Yes | Body text | Yes | DOCX | Common text styles, headings, lists, tables, and decodable embedded images. Pagination, footnotes, headers/footers, revisions, and complex layouts may be simplified. |
| DOC | Yes | — | — | — | Stores and downloads legacy Word sources. |
| ODT | Yes | Body text | Partial | — | Extracts headings, paragraphs, basic lists, tables, common styles, and package images. Page layout, repeated cells, and complex styles may be simplified. |
| EPUB | Yes | Text in reading order | Partial | EPUB 3 (with `toc.ncx`) | Import converts chapters, common styles, and package images while fixed layout, external resources, and DRM content stay in the source; export builds per-chapter e-books with metadata, cover, and local illustrations. |
| PDF | Yes | Page-by-page render | Partial | Desktop saves PDF directly; web uses print-to-save | Extracts readable text; order may need adjustment. Scans need OCR first, encrypted files need unlocking. Export re-paginates. |
| MOBI, AZW3 | Yes | — | — | — | Stores and downloads e-book sources. |

Single-file import is capped at 128 MiB, PDF preview and conversion at 64 MiB, individual text parts of regular text and compressed documents at 16 MiB, and RTF at 8 MiB. Each embedded PNG, JPEG, GIF, or WebP image is capped at 4 MiB, with a 24 MiB total for converted images. For oversized books or corrupted/encrypted files, the app reports the limit and keeps the source.

## Saving and privacy

Text is auto-saved after about 500 ms without changes, and saving is also attempted before switching chapters or returning to the library. Save status is visible. When saving fails (such as when storage is full), the last committed content and current in-memory changes are kept, and the failure banner offers Retry and Export this chapter directly while demoting Discard unsaved changes behind secondary confirmation. Editing the same chapter from different pages raises a conflict notice; you can save as an independent version. If the browser or device is force-quit, uncommitted input may need to be re-entered.

The current database is IndexedDB v11 (v0.19.0 adds task stores in v9, v0.21.0 adds a trash deletion-time index in v10, and v0.27.0 adds writing styles in v11). Historical upgrade rules: IndexedDB v4 adds a global `writingDays` store alongside the works, files, edited versions, chapters, and trash stores; v3 libraries upgrade automatically on open. The trash store was introduced in v3, and upgraded libraries require v0.5.0 or newer to open. The two libraries are isolated by composite keys, and source files are deduplicated per library by SHA-256. Manuscripts and sources are stored separately; deleting a work moves its local copy, edited versions, and chapters to the trash in a single transaction. The desktop version uses a fixed local directory and app address; web data is isolated by browser profile and site address. Clearing browser site data also deletes that browser's library.

Import, conversion, editing, and export all happen locally. Illustrations are stored in manuscripts; HTML import and rich-text paste strip executable content and remote addresses.

## Engineering and verification

Built with Vite, TypeScript, and Tiptap/ProseMirror. The editor uses a structured chapter model independent of source formats; format conversion, persistence, and export are maintained under `src/documents/`. Build output includes third-party license and attribution files. Character profiles are planned for later.

```sh
npm ci
npx playwright install --with-deps chromium
npm test
```

Playwright runs against the production build and covers legacy library migration, format conversion and source verification, chapter management, IME composition, copy/paste, save failures, concurrent conflicts, reopen recovery, and phone viewports. CI keeps screenshots and exported files for public test samples. An existing Chromium can be used via `CHROMIUM_PATH`.

Update-check tests inject controlled stable, prerelease, and failure responses by intercepting the GitHub API. At runtime the app reads the real GitHub Releases API.

The desktop app opens the same production build with Electron. On Windows, `npm run desktop` starts a development build and `npm run build:windows` produces the x64 NSIS installer in `dist-windows/`. CI runs the actual installer on Windows, verifying offline read/write, PDF export, in-app updates, overwrite in the original directory, and data retention across restarts. Mac uses `npm run build:macos` and `npm run test:macos`, installing from the DMG and verifying on native Apple Silicon and Intel runners.

To publish a new version, specify the version and `windows`/`macos` target platforms explicitly in `release.json`; Mac-only releases do not upload a Windows installer. Bump `package.json` and the lockfile in the same PR and add `docs/releases/v<version>.md`. After merging to `main`, CI creates the official Release once Web, Windows, and both Mac chip checks pass, uploading installers and SHA-256 checksum files. You can also run Checks manually on `main` with a matching stable version tag to retry publishing. The artifact manifest is verified before publishing, rejecting files that do not match the target platforms.

Interface copy lives in `locales/zh-CN.json` and `locales/en.json`. The build checks that keys and interpolation parameters match, then generates standalone language packs and a verification manifest. Desktop installers include the manifest but not the packs; the Release provides both language files, and the installer and app fetch only the selected language. After changing copy, update both source files and ship them with the next release.

## License

New World is released under the [GNU General Public License v3.0 or later (GPL-3.0-or-later)](LICENSE). You are free to use, modify, and distribute it; if you distribute a modified version, you must make its source code available under the same license. Third-party dependencies and fonts keep their own licenses.
