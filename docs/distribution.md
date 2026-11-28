# Getting DropWave signed and into the stores

How the builds are made, and the one-time steps the maintainer has to do by hand.

## How the builds work

`.github/workflows/build.yml` runs on GitHub for every push, pull request and `v*` tag:

| Job | What it makes |
|---|---|
| **windows** | Builds the C++ helpers (camera, two-PC mouse), runs the tests, then makes `DropWave-Setup-<version>.exe`, `latest.yml` and the Microsoft Store package `DropWave-Store-<version>.appx` |
| **android** | Builds the phone pages and an **unsigned** APK (the release key stays on the maintainer's PC) |

Download the results from the run's **Artifacts** section.

On a `v*` tag, if SignPath is set up (below), the Windows app files and the installer are code-signed, and `latest.yml` is rewritten for the signed installer (`scripts/update-latest-yml.cjs`).

Local equivalents: `npm run dist` (installer) and `npm run dist:store` (Store package). Store tiles come from `build/icon.png` with `npx electron scripts/store-assets.cjs`.

## 1. SignPath (free code signing for open source)

1. Apply at https://signpath.org/apply with the text below.
2. When approved, in SignPath create:
   - project slug `dropwave`
   - signing policy slug `release-signing`
   - artifact configurations `app` and `installer`, from `.signpath/artifact-configurations/`
   - link the project to GitHub (trusted build system: GitHub.com) for `lalitaryan1993/dropwave`
3. In the GitHub repo, **Settings › Secrets and variables › Actions**:
   - secret `SIGNPATH_API_TOKEN` (a CI user token from SignPath)
   - variable `SIGNPATH_ORGANIZATION_ID`
4. Push a tag (`git tag v1.12.0 && git push origin v1.12.0`). The workflow signs automatically.

The certificate will name **SignPath Foundation** as the publisher. SmartScreen warnings fade as the signed installer gets downloads.

### Application text (draft)

> **Project:** DropWave, https://github.com/lalitaryan1993/dropwave
> **License:** MIT (OSI approved). All code, including the C++ helpers in `native/`, is in the repository.
> **What it is:** A Windows + Android app that connects a phone and PCs over the user's own Wi-Fi: notifications, SMS, calls, file transfer between PCs, phones and TVs, phone as webcam, TV remote. No server, no account, no telemetry.
> **What to sign:** `DropWave.exe` (Electron), `dwkvm.exe` and `dwcam.exe` / `DropWaveCam.dll` (our own C++ helpers), and the NSIS installer. All are built by GitHub Actions from the public repository (`.github/workflows/build.yml`).
> **Releases:** GitHub Releases, with an in-app updater (electron-updater).
> **Maintainer:** one developer in India; MFA is on for GitHub.

## 2. Microsoft Store (free for individual developers)

1. Sign up from https://developer.microsoft.com/microsoft-store/register (individual account, free). You do the sign-up and verification.
2. **Reserve the name** "DropWave" in Partner Center.
3. Open **Product identity** and copy three values into `package.json` › `build.appx`:
   - `Package/Identity/Name` → `identityName`
   - `Package/Identity/Publisher` → `publisher` (looks like `CN=XXXXXXXX-...`)
   - `Package/Properties/PublisherDisplayName` → `publisherDisplayName`
4. Build (`npm run dist:store` or take the `.appx` from the workflow) and upload it in a new submission.
5. Fill the listing with the text below, the screenshots in `docs/readme/`, and the privacy policy link: https://github.com/lalitaryan1993/dropwave/blob/main/PRIVACY.md
6. Category: **Productivity**. Age rating: answer the questionnaire (no user-generated content shared publicly, no purchases).

The Store signs the package itself, so Store installs show no warning, and the Store keeps the app updated (the GitHub updater is off in the Store build).

**Not in the Store build yet:** the Explorer right-click "Send with DropWave" (the installer adds it; a packaged app needs a shell extension) and the automatic firewall rule (Windows asks once instead; DropWave's Network check can fix it).

### Store listing text (draft)

**Short description**
Your Android phone on your PC, and files to any PC, phone or TV. On your own Wi-Fi: no cloud, no account, no ads.

**Description**
DropWave puts your Android phone on your Windows PC and moves files between all your devices over your own Wi-Fi.

On your PC:
• See and reply to phone notifications, read and send SMS, copy OTPs in one click
• Answer calls from a popup, use the phone as a webcam and mic
• Mirror and control the phone screen, open phone apps in PC windows

Files everywhere:
• Drag and drop files between PCs, phones and TVs on the same Wi-Fi
• Phone to phone without internet: DropWave makes its own Wi-Fi, the other phone scans a QR code (iPhones too, no app needed)
• Vault: anything you send while a device is away goes by itself later

And more:
• Remote for Android TV and Google TV, with voice search
• One mouse and keyboard for two PCs, copy and paste across them
• Print and scan from the phone

Private by design: no server, no account, no tracking. Free and open source (MIT).

**Keywords**
phone link, file transfer, share files, android, sms, notifications, tv remote, webcam, airdrop, nearby share

**What's new** (fill per release from the GitHub release notes)
