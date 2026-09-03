# Releasing Inspect It

This document explains how to produce and publish installers for **Windows,
macOS, and Linux** to GitHub Releases. The whole pipeline is driven by tags:
push a `v1.x.x` tag and CI builds all three platforms and attaches the
installers to a GitHub Release.

## Quick summary

`package.json` is the single source of truth for the version (it is baked into
the app and into artifact names). CI fails loudly if a tag does not match it.

```bash
# 1. Bump package.json `version` (e.g. 1.0.1) and commit it
npm version 1.0.1 --no-git-tag-version   # or edit package.json manually
git add package.json package-lock.json
git commit -m "release: 1.0.1"
git push origin main

# 2. Tag exactly v<version> and push the tag
git tag v1.0.1
git push origin v1.0.1

# 3. CI verifies tag == package.json version, builds all installers, and
#    creates the GitHub Release with them attached.
```

Artifacts produced:

| Platform | Files | Notes |
| --- | --- | --- |
| Windows x64 | `Inspect-It-<ver>-Windows-x64.exe` | NSIS installer |
| macOS x64 + arm64 | `Inspect-It-<ver>-macOS-<arch>.dmg`, `.zip` | Signed + notarized only when Apple credentials are configured |
| Linux x64 | `Inspect-It-<ver>.AppImage`, `inspect-it_<ver>_amd64.deb` | Not signed (Linux has no standard code-signing requirement) |

## 0. Before the first release (one-time setup)

1. **Set the real repository URL.** Edit `package.json` -> `repository.url` and
   `homepage` to your actual GitHub repository. This powers the "Repository"
   link in the app's About dialog and is injected at build time.
2. **Create the `main` branch on GitHub** and push this repository (the CI
   workflow in `.github/workflows/build.yml` runs on `main`/`master` and on tags).

## 1. Version flow

- The release version is `package.json` -> `version` (semver, e.g. `1.0.1`).
- The git tag must be exactly `v` + that version (`v1.0.1`). CI keys the
  release off `refs/tags/v*`.
- CI runs `scripts/check-release-version.mjs` before every tag build and fails
  if the tag and `package.json` disagree, so artifacts can never drift from the
  tag again (this fixed the `v1.0.1` tag that previously produced `1.0.0`
  artifacts).
- A tag containing a dash (`v1.0.1-rc.1`) is published as a **pre-release**.
- Bump `version` in `package.json` (and `package-lock.json`) FIRST, commit and
  push, then tag `v<version>` and push the tag.

> Always bump `package.json` before tagging. Deriving the version from the tag
> at build time would leave the in-app version (baked from `package.json`)
> inconsistent with artifact names; keeping `package.json` authoritative and
> verifying the tag against it is the cleanest single-source-of-truth model.

## 2. What CI does (build is separate from publish)

The workflow (`.github/workflows/build.yml`) runs on every push/PR and on tags:

- **Every run**: `npm ci` -> `npx tsc --noEmit` -> `npm test` -> builds the
  platform's installer(s) -> uploads them as workflow artifacts.
- **Tag pushes only**: a dedicated `release` job downloads all three platforms'
  installers and creates a GitHub Release with them attached.

**Build/publish separation:**

- Every build command in `package.json` ends in `--publish never`
  (`npm run dist:win`, `dist:mac`, `dist:linux`, `dist`, `package`, ...), so
  electron-builder never implicitly publishes to GitHub - even when it detects
  a git tag (this removed the "GitHub Personal Access Token is not set" CI
  failure on Windows and Linux).
- No `GH_TOKEN` is set on the build jobs. The `release` job is the ONLY job
  that creates the GitHub Release (via `softprops/action-gh-release`) and the
  only place a token is used.

You can also download the per-OS installers from the workflow "Artifacts"
section on any run, without creating a release.

## 3. macOS signing & notarization

Without a certificate, CI still builds a working macOS app, but users see a
Gatekeeper warning ("cannot verify developer") and must right-click -> Open.

### 3.1 Prerequisites (you must do this once)

1. Join the **Apple Developer Program** (paid) at developer.apple.com.
2. Create a **Developer ID Application** certificate:
   - Apple Developer -> Certificates, Identifiers & Profiles -> Certificates -> `+`
   - Choose **Developer ID Application** (not "Mac App Store").
   - Follow the instructions to generate a CSR from Keychain Access and upload it.
3. Download the certificate and import it into Keychain Access (it must include
   its private key).

### 3.2 Export the certificate for CI

1. In Keychain Access, find the certificate under **My Certificates**.
2. Right-click -> **Export "Developer ID Application: ..."** -> choose
   **Personal Information Exchange (.p12)**.
3. Set a strong password when prompted (this is `CSC_KEY_PASSWORD`).
4. Base64-encode the .p12 file:

   ```bash
   base64 -i your-cert.p12   # macOS/Linux
   # Windows PowerShell:
   #   [Convert]::ToBase64String([IO.File]::ReadAllBytes("your-cert.p12"))
   ```

### 3.3 Create an app-specific password for notarization

1. Sign in at appleid.apple.com -> **Sign-In and Security** -> **App-Specific
   Passwords** -> generate one.
2. Note your **Team ID** (Apple Developer -> Membership details -> Team ID).

### 3.4 Store the secrets

In GitHub: repository **Settings -> Secrets and variables -> Actions**, create
these repository secrets:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | The certificate input: a base64-encoded `.p12`, a URL, or an absolute file path (from step 3.2) |
| `CSC_KEY_PASSWORD` | The .p12 password |
| `APPLE_ID` | The Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from 3.3 |
| `APPLE_TEAM_ID` | Your Team ID |

### 3.5 How it works in CI

- The macOS job exports `CSC_LINK`/`CSC_KEY_PASSWORD` into the environment
  **only when the secrets are non-empty**. A present-but-empty `CSC_LINK`
  makes electron-builder believe a certificate is configured and fails with
  `"... not a file"`; leaving it unset produces a clean ad-hoc (unsigned) build.
- When `CSC_LINK` is set, electron-builder imports it (base64 strings are
  decoded automatically; URLs are downloaded; paths are read directly) and signs
  with `CSC_KEY_PASSWORD`.
- On **release tags only**, if `APPLE_ID` is set, CI also notarizes the app
  (`-c.mac.notarize=true`) and staples the ticket, so the DMG installs without
  Gatekeeper warnings.
- Local/PR builds stay unsigned and unnotarized so CI never fails when
  credentials are missing.

### 3.6 Verifying

```bash
spctl --assess --type execute --verbose Inspect\ This.app
# "accepted source=Notarized Developer ID" means Gatekeeper is satisfied.
```

## 4. Windows code signing (optional)

Set `CSC_LINK` + `CSC_KEY_PASSWORD` to an Authenticode certificate if you have
one. Without it, Windows shows a SmartScreen warning; users click
"More info" -> "Run anyway". No extra secrets are required for an unsigned
build.

## 5. Linux

No signing is required. The AppImage and `.deb` are built on the Ubuntu CI
runner. AppImage requires `libfuse2` on some systems at runtime; see
`docs/PLATFORMS.md`.

## 6. Manual fallback (build locally per OS)

macOS/Linux packages cannot be cross-built; build each on its own OS:

```bash
npm run dist:win     # on Windows
npm run dist:mac     # on macOS (add -c.mac.notarize=true when credentials are set)
npm run dist:linux   # on Linux
```

Then upload `release/*` artifacts to the GitHub Release page manually.

## 7. Troubleshooting

- **"Cannot verify developer" on macOS** -> unsigned build; right-click -> Open,
  or configure signing/notarization (section 3).
- **Notarization fails with "Failed to notarize"** -> check `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; the app-specific password must
  be created for the same Apple ID.
- **Release job skipped** -> the push must be a tag (`v*`) to `main`/`master`;
  PRs never publish.
- **Artifacts missing on the release** -> check the three `build` jobs; each must
  finish. The release job downloads `installers-*` artifacts.
- **deb build fails for missing maintainer** -> `build.linux.maintainer` is set;
  ensure it is not removed.
