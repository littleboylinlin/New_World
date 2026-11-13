# Spelling dictionaries

`en-US-10-2.bdic` and `en-GB-10-2.bdic` are copied unchanged from `hunspell_dictionaries.zip` of the
[Electron v45.2.3 release](https://github.com/electron/electron/releases/tag/v45.2.3). They are the
Chromium builds of the Hunspell English dictionaries from
<https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/>; the licence files that
come with the archive are in `licenses/`.

On Windows the desktop app copies them into the profile's `Dictionaries` folder before the first
window opens, so spell checking works offline and never downloads a dictionary. macOS uses the
system spell checker instead. The version in the file names must match the Chromium of the
Electron in use; update both files when upgrading Electron.

`catalog.json` lists every dictionary file name in that archive. Writers can add any of them from
the settings, by importing a file or by entering an https link; the app checks the name and the
`BDic` header and saves the file in the same `Dictionaries` folder. Regenerate the catalog together
with the two files when upgrading Electron.
