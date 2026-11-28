# DropWave roadmap

Where DropWave is, what's being worked on, and what comes next. Updated with every release.
The reasoning and sources behind this plan: [reports/DropWave growth and earning plan.md](reports/DropWave%20growth%20and%20earning%20plan.md).

## Shipped

| Version | Highlights |
|---|---|
| 1.6 – 1.9 | Phone on PC: notifications and replies, SMS, call popups, OTP copy, webcam and mic, screen mirroring and control, apps in PC windows, PC↔PC/phone file transfer |
| 1.10 | Print and scan, one mouse for two PCs, 3D Nearby view, copy/paste files between PCs |
| 1.11 | Phone to phone without internet (own hotspot + QR, iPhone via browser, ask before receiving, trusted phones, Nearby without QR), TV remote for Android/Google TV on phone and PC (voice, typing, apps, several TVs), Vault (send later), new look (themes, accents, font) |

## Done, not released yet

- PC TV remote: responsive layout and a mouse pad
- TV apps open through https links (no more disconnects) and auto-reconnect
- WhatsApp / app call popup that stayed after the call ended, plus a hide button
- Duplicate `call:dismiss` handler removed

## Main idea

The biggest thing stopping people is **install warnings**, not missing features. SHAREit and Phone Link grew because they came preinstalled; a one-person app grows by word of mouth, and that only works once installs are clean and trusted. So trust and distribution come first, features second.

## Phase 1: next month (trust and reach)

- [x] Back up the release keystore offline (losing it blocks Google registration forever)
- [x] Build Windows + Android in GitHub Actions, with SignPath signing ready for release tags (`.github/workflows/build.yml`)
- [x] Apply to SignPath Foundation (free code signing for open source), applied 28 Nov 2026; waiting for their reply. Steps after approval in `docs/distribution.md`
- [x] Microsoft Store package, tiles, listing text and privacy policy
- [x] Microsoft Store developer account and the name "DropWave" reserved (28 Nov 2026, Store ID 9MT1LJ95VB1H; submit within 3 months)
- [ ] First Microsoft Store submission (free for individuals; the Store signs it, so no SmartScreen warning)
- [ ] Play Console account ($25, also covers Android developer verification)
- [ ] Release the done-but-unreleased fixes (1.11.1)
- [ ] Reliability check: reconnect after reboot, sleep and Windows update, published as a table in the README
- [ ] Donations: GitHub Sponsors + UPI QR, and a "free features stay free" pledge
- [ ] AlternativeTo listings (alternative to SHAREit, Xender, Phone Link, AirDroid)

## Phase 2: 3 months (grow)

- [ ] Register the Android app with developer verification
- [ ] Play Store build without the risky permissions (no remote control, all-files access, APK installs or self-updater); full build stays on GitHub
- [ ] F-Droid build without Google libraries (IzzyOnDroid likely won't accept AI-assisted code)
- [ ] Launch: Show HN, a Hindi demo video, one-line pitch "SHAREit without the ads, plus your PC and TV"
- [ ] Phone to phone: resume after a drop, skip files already received
- [ ] Choose SIM for calls and SMS (dual SIM)
- [ ] Windows on ARM build
- [ ] More Indian languages
- [ ] First Supporter unlock (new convenience features only)

## Phase 3: 6–12 months (earn and scale)

- [ ] Apply for Play's SMS/call exception (as KDE Connect did)
- [ ] winget, Scoop, Chocolatey, Indus Appstore
- [ ] Call audio on PC (listen-only first)
- [ ] Phone as gamepad and key mapping
- [ ] Remote access outside home Wi-Fi (self-hosted / Tailscale) as a paid feature
- [ ] Classroom / Office pack pilot with 2–3 sites
- [ ] GST check with a CA before the first foreign sale, then re-price from real numbers

## Earning model

- **No ads, ever.** That's the difference from SHAREit/Xender.
- **Nothing free today goes behind a paywall** (Pushbullet's 2015 backlash).
- **One-time Supporter unlock** for new convenience features, like Join and Tasker:

| Offer | India | Abroad | Where |
|---|---|---|---|
| Android Supporter | ₹149 (test ₹99–199) | $4.99 | Play Billing |
| Windows Supporter | ₹399 (test ₹299–499) | $7.99 | Microsoft Store |
| All-devices family | ₹499 | $9.99 | Razorpay UPI page |
| Classroom / Office (yearly) | ₹4,999 per site | $99 per site | Direct invoice |

Prices are starting points to test, not proven numbers.

## Other ideas (not scheduled)

Scam Shield, Wake PC from phone, keep photo dates, Bluetooth mouse/keyboard, Help Mode for parents, tablet as second screen, clipboard history, battery alerts, taskbar panel, photo map, Samsung/LG TV remote, storage cleaner.

## Known limits

- Settings can't be opened directly on the Mi TV Stick
- No real mouse pointer on the TV yet
- No call audio on the PC yet
- Windows installer isn't code-signed yet, so Windows shows a warning
