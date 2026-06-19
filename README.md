# Grimmia

A friendly desktop app for the [Internet Archive](https://archive.org) — **search, browse, download, and upload** items without ever touching the command line. It does the same core jobs as the `ia` CLI, in a normal point-and-click app that runs on **macOS and Windows**.

<p align="center"><img src="build/icon.png" width="120" alt="Grimmia icon"></p>

## What it does

- 🔎 **Search** archive.org with sorting and paging, shown as a thumbnail grid
- 🧰 **Advanced search** — combine **title + subject + creator + language**,
  filter by **media type** (texts, audio, video, images, software, data, web),
  and set a **date range**, with a live preview of the query being built
- ☑️ **Select hits** — checkboxes on every result, “select all on page”, and
  **download all selected items** at once
- 🪟 **Two views** — a **grid** with cover previews, or a **very compact list**
  with no previews; toggle anytime. Broken/missing thumbnails are hidden
  automatically (no broken-image boxes). Optional **subject tags** on results.
- 📄 **Item details** — full metadata and a file list, in one click
- ⬇️ **Download** whole items or selected files to a folder you choose, with
  live progress, cancel, and automatic **skip / resume** of files you already have
- ⚙️ **Download preferences:**
  - **Which files** — **PDF only by default**, plus All files, **Searchable text
    PDF** (the OCR’d PDF, ideal for texts), EPUB, or plain text
  - **Filenames** — keep the original, or **replace / append the item title**
    to the filename; illegal characters are stripped and collisions are
    auto-numbered so nothing overwrites
- ⬆️ **Upload** files to a new item with a metadata form (title, creator, date,
  media type, subjects, description) and optional derive
- ✏️ **Edit metadata** of items you own
- 🔐 Signs in with your archive.org **email + password**; your upload keys are
  stored **encrypted** on your device (macOS Keychain / Windows DPAPI via
  Electron `safeStorage`)

No Python, no terminal, no extra runtime — it talks to archive.org's web APIs
directly, so the installer is small (~90 MB).

## Install

> 📄 **Full step-by-step instructions (with the unsigned-app warnings):**
> [`docs/INSTALL.md`](docs/INSTALL.md). Each installer also ships a
> **"Read Me First.txt"** with these steps (inside the DMG window on macOS, and
> in the install folder on Windows).

This is a free, **unsigned** build (no paid Apple/Microsoft certificate), so the
OS shows a one-time "unknown developer" warning. The app is safe; you approve it
once.

### macOS
1. Download `Grimmia-<version>-macOS-arm64.dmg` (Apple Silicon) or
   `…-macOS-x64.dmg` (Intel).
2. Open the `.dmg` and drag **Grimmia** into **Applications**.
3. First launch — macOS shows one of two warnings (both mean "unsigned"; you
   only do this once):
   - **If it says *"Grimmia.app" is damaged and can't be opened… Move it to
     the Bin*** — common when downloaded via a browser / on **Sequoia (15)+**.
     The app is **not** damaged and there's no "Open Anyway" button. Click
     **Cancel**, then run this in **Terminal** and re-open the app:
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Grimmia.app"
     ```
   - **If it says *Apple could not verify…* / *unidentified developer*** —
     **Sequoia (15)+:** open it, click **Done**, then **System Settings →
     Privacy & Security → Open Anyway**. **Sonoma (14) and older:** right-click
     the app → **Open** → **Open**.

   Full step-by-step with both dialogs: [`docs/INSTALL.md`](docs/INSTALL.md).

### Windows
1. Download `Grimmia Setup <version>.exe`.
2. If SmartScreen warns, click **More info → Run anyway**, then follow the
   installer (you can choose the install folder).
3. Launch **Grimmia** from the Start menu or desktop shortcut.

### Linux (untested)
A portable **AppImage** is published with each release. **Note:** the Linux build
is currently **untested** — the test suite runs on Linux in CI, but no one has
verified the packaged AppImage end-to-end, so treat it as experimental.
1. Download `Grimmia-<version>.AppImage`.
2. Make it executable: `chmod +x Grimmia-*.AppImage`.
3. Run it: `./Grimmia-*.AppImage`.

> For wide distribution, add an Apple Developer ID / Windows code-signing
> certificate — see **Building** below.

## Using it

1. **Sign in** with your archive.org email and password.
2. **Search** — type a query (e.g. `grateful dead 1977`), press Enter.
3. **Details** opens metadata + file list. **Download** grabs the whole item.
4. Pick a **download folder** once (Downloads tab → *Change…*); it's remembered.
5. **Upload** tab — pick files, fill in a title and identifier, hit Upload.

## Building from source

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install            # install Electron + builder
npm start              # run the app in dev
npm test               # run the unit test suite
npm run dist:mac       # build macOS .dmg (into dist/)
npm run dist:win       # build Windows .exe  (run on / for Windows)
```

Cross-building the Windows installer is most reliable **on Windows** (or in CI).
macOS `.dmg` builds run on macOS.

### Code signing & notarization (for distribution)

The build is configured for a signed + notarized macOS app and a signed Windows
installer; the config is **inert without credentials**, so a plain
`npm run dist:mac` still produces an unsigned DMG locally (with the Gatekeeper
prompt above). To produce a distributable build, provide the secrets below.

**macOS** (hardened runtime + notarization are pre-wired —
`build/entitlements.mac.plist`, `afterSign: build/notarize.js`):
1. Install your **Developer ID Application** certificate in the build keychain
   (electron-builder signs automatically when it finds one).
2. Install the notarizer once: `npm i -D @electron/notarize`.
3. Set App Store Connect API key env vars before `npm run dist:mac`:
   ```bash
   export APPLE_API_KEY=/abs/path/AuthKey_XXXX.p8   # the .p8 key file
   export APPLE_API_KEY_ID=XXXXXXXXXX               # key ID
   export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-...   # issuer ID
   ```
   With these set, the `afterSign` hook submits the app to Apple and staples the
   ticket; without them it logs "skipping notarization" and the build proceeds
   unsigned.

**Windows** — provide a code-signing certificate via electron-builder's standard
env vars before `npm run dist:win` (SHA-256 is already configured):
```bash
export CSC_LINK=/abs/path/cert.pfx     # or a base64 cert
export CSC_KEY_PASSWORD=...             # cert password
```

> **Why this matters:** unsigned macOS apps are Gatekeeper-blocked ("damaged")
> and Windows builds trip SmartScreen. Note too that `safeStorage` (used for
> saved credentials) is keyed to a stable signing identity — without signing,
> stored logins can be invalidated between builds.

**CI secrets** (for the release job): `APPLE_API_KEY` (base64 of the .p8),
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `CSC_LINK`, `CSC_KEY_PASSWORD`.

## How it works

| Concern        | Where |
| -------------- | ----- |
| Pure logic (URL building, metadata encoding, login parsing) | `src/main/ia-core.js` (unit-tested) |
| Networked client (login, search, metadata, download, upload) | `src/main/ia-client.js` |
| Electron main process + secure IPC | `src/main/main.js` |
| Encrypted credential / settings store | `src/main/store.js` |
| Preload bridge (`window.ia`) | `src/preload/preload.js` |
| UI | `src/renderer/` |

Security posture: `contextIsolation` on, `nodeIntegration` off, a strict
Content-Security-Policy in the renderer, and all privileged work behind IPC.

The app uses these archive.org endpoints, the same ones the official
`internetarchive` library uses:

- Login: `POST https://archive.org/services/xauthn/?op=login`
- Search: `GET https://archive.org/advancedsearch.php`
- Metadata: `GET/POST https://archive.org/metadata/{identifier}`
- Download: `https://archive.org/download/{identifier}/{file}`
- Upload (S3-like): `PUT https://s3.us.archive.org/{identifier}/{file}`

## License

[CC0 1.0 Universal](LICENSE) — dedicated to the public domain by Moss on Stone.
You may copy, modify, and distribute this work, including for commercial
purposes, without asking permission.
