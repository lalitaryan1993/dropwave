# LANDrop

Send files between every device on your Wi-Fi: Windows PCs, phones, tablets and smart TVs.

## Install
Run `release/LANDrop-Setup-1.0.0.exe` on every PC. The installer also allows LANDrop through Windows Firewall on private networks.
Windows will say "Unknown publisher" because the app is not code-signed. Click **More info → Run anyway**.

## Use
**PC ↔ PC**
- Open LANDrop on two PCs on the same network. They find each other automatically.
- Drag files or folders onto a device card, or use the **Files** / **Folder** buttons.
- The receiving PC sees Accept / Decline. Tick "Always accept" to trust a device.
- If a PC doesn't show up, use **Add by IP**.

**Phones, tablets, TVs (no app needed)**
- On the PC, click **Phone or TV** and scan the QR code with the phone camera. You can also open the shown address (e.g. `192.168.1.8:47823`) in any browser and type the 6-digit PIN.
- The phone then appears on the PC as a device. Drag files onto it, and the phone gets Download / Open buttons. Videos and photos can be played right in the browser, which is handy on a TV.
- From the phone, choose files and pick where to send them: the PC, or any other connected phone or TV (relayed through the PC).
- **New PIN** in the dialog or in Settings disconnects every browser.

Received files go to `Downloads\LANDrop`. You can change this in Settings.

## Develop
```bash
npm install
npm run dev            # app with hot reload
npm run dev:second     # a second copy on the same PC (separate profile and port)
npm test               # headless tests: PC transfers + phone/TV browser access
npm run icon           # regenerate icons from build/icon-source.png and build/banner-source.png
npm run dist           # build release/LANDrop-Setup-x.y.z.exe
```

## How it works
| Port | What |
|---|---|
| UDP 47821 | PC discovery (broadcast every 2 s) |
| TCP 47822 | PC-to-PC transfers. The sender offers a file list, the receiver accepts, the bytes are streamed, and SHA-256 checksums are verified at the end |
| HTTP 47823 | Phone/TV web page. PIN-protected (cookie), uploads stream to disk, downloads support range requests, and live updates use Server-Sent Events |

Code: `electron/engine.cjs` (PC network), `electron/webshare.cjs` + `electron/web/` (phone/TV), `electron/main.cjs` (window, tray, settings), `src/` (desktop UI).
The icon and installer artwork were generated with ChatGPT (`build/*-source.png`) and processed by `scripts/process-icons.cjs`.
