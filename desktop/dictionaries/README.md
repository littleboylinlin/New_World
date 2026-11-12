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
