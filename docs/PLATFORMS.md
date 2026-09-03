# Platform support

Inspect It is a cross-platform desktop app (Electron + Vite/React) with a
browser build. The analysis engine is entirely local and platform-neutral; the
desktop shell adds the bubble, tray, global shortcut, and native file access.

## Support matrix

| Capability | Windows | macOS | Linux (X11) | Linux (Wayland) | Browser |
| --- | --- | --- | --- | --- | --- |
| Floating bubble + panel | Yes | Yes | Yes | Yes* | n/a |
| Drag & drop inspection | Yes | Yes | Yes | Yes | Files you select |
| System tray | Yes | Yes | Yes (AppIndicator) | With AppIndicator host | n/a |
| Global shortcut | Ctrl+Space | Control+Space | Ctrl+Space | No (compositor limit) | n/a |
| Launch at login | Yes | Yes | Yes (XDG autostart) | Yes (XDG autostart) | n/a |
| Encrypted API key (safeStorage) | Yes (DPAPI) | Yes (Keychain) | When a keyring is available | Same | Local storage (not encrypted) |
| Local-only analysis | Yes | Yes | Yes | Yes | Yes |

*On Wayland, transparent/frameless windows and always-on-top are limited by
the compositor; the bubble still works but may not stay strictly above other
windows.

## Linux

### System tray
The tray uses the StatusNotifier/AppIndicator protocol. If the icon is
missing:

- GNOME: install the *AppIndicator and KStatusNotifierItem* extension
  (`gnome-shell-extension-appindicator`).
- KDE: enable *System Tray* widgets (usually default).
- Other desktops: ensure `libayatana-appindicator` is installed.

### Global shortcut
`Ctrl+Space` works on X11. Wayland compositors do not allow global key
grabs, so use the bubble or tray on Wayland. (Some compositors support the
`global-shortcuts` portal; support is compositor-specific.)

### Always-on-top
Works on X11. On Wayland, `alwaysOnTop` is a request the compositor may
ignore; GNOME may respect it, others may not.

### AppImage
- Requires FUSE: `sudo apt install libfuse2` on Ubuntu 22.04+.
- If FUSE is unavailable, extract instead:
  `./Inspect-It.AppImage --appimage-extract` then run
  `./squashfs-root/AppRun`.

### Launch at login
Implemented via an XDG autostart entry at
`$XDG_CONFIG_HOME/autostart/inspect-it.desktop`
(usually `~/.config/autostart/inspect-it.desktop`). When running from an
AppImage, the entry points at the AppImage; otherwise at the installed binary.
Disabling it removes the file. If the entry is missing, re-enable launch at
login in Settings.

## macOS

### Gatekeeper
Community (unsigned) builds trigger Gatekeeper. Right-click the app and
choose **Open**, or run `xattr -dr com.apple.quarantine /Applications/Inspect\ This.app`.

### Global shortcut
`Cmd+Space` is reserved by Spotlight, so the app registers `Control+Space`
and falls back to `Cmd+Shift+Space` if that is also taken. You can rebind in
System Settings -> Keyboard if you prefer another combination.

### Launch at login
Uses macOS login items (`app.setLoginItemSettings`), the standard mechanism.

### Tray / menu bar
The icon appears in the menu bar. macOS renders menu-bar icons best as
template images; the current icon is colored and displays as-is.

## Windows

- Global shortcut: `Ctrl+Space`.
- Launch at login: Windows login items.
- Tray: native; the icon lives in the notification area.

## OCR (local, offline)

OCR runs fully on-device with tesseract.js:

- **Desktop (Electron):** OCR runs in the main process (Node), reading the
  worker, WASM, and English language data from the packaged app - no network.
- **Browser:** OCR runs in a web worker using local asset URLs shipped in the
  build (`/ocr/...`); the English language data is bundled.
- **Scanned PDFs:** embedded page images (JPEG/DCTDecode) are extracted and
  OCR'd locally; results appear per page with confidence.
- Adding another language means adding its `traineddata.gz` to `public/ocr/`.

## Building per platform

```bash
npm run dist:win     # Windows NSIS installer (run on Windows)
npm run dist:mac     # macOS DMG + ZIP (run on macOS)
npm run dist:linux   # Linux AppImage + deb (run on Linux)
```

Cross-building is intentionally not supported: macOS builds require macOS
(signing/notarization needs Apple credentials), and Linux packages are built
on Linux. The CI workflow builds and tests all three platforms on every push.
