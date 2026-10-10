# DroidEye

An Android app built on the open-source
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu
(MIT License). DroidEye is an independent fork by **orailnoor** and is not
affiliated with or endorsed by the original project.

## How it works

```
Android app (Capacitor)  ──loads──▶  DroidEye server (vite preview)
  full-screen, mic permission          serves the globe + /api data proxies
                                       (flights, satellites, weather, quakes…)
```

- `android/`: the native Android project. Open it in Android Studio.
- `capacitor.config.json`: app id `com.orailnoor.droideye`, and the server URL the app loads.
- `droideye/www/`: offline page shown if the server can't be reached.
- `render.yaml`: one-click free hosting on Render.

## Build the APK (one command)

```bash
npm run droideye:apk                                   # app loads your Mac over Wi-Fi
npm run droideye:apk -- https://droideye.onrender.com  # app loads the hosted server
```

Output: `DroidEye-debug.apk` in the project root. Uses Android Studio's bundled
Java and `~/Library/Android/sdk`. No Mac handy? On GitHub: **Actions → DroidEye APK
→ Run workflow**, enter the server URL, and download the APK from the run.

## 1. First run on your phone (same Wi-Fi as the Mac)

```bash
cd ~/workspace/DroidEye
nvm use 24            # or any Node 24.x / 26.x
npm ci                # installs everything for macOS
npm run doctor

# Terminal 1: start the server, reachable from your phone
npm run dev -- --host 0.0.0.0 --port 4173

# Terminal 2: point the app at your Mac's Wi-Fi IP, then open Android Studio
ipconfig getifaddr en0                       # e.g. 192.168.1.23
npm run droideye:server -- http://192.168.1.23:4173
npm run droideye:sync
npm run droideye:open
```

In Android Studio press **Run ▶** with your phone plugged in (USB debugging on).

> Over plain `http`, Android blocks the microphone, so voice only works once the
> app points at the `https` Render server.

## 2. Host it free on Render

1. Push this repo to your GitHub (`git remote add origin <your-repo>` then `git push -u origin droideye`).
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml`.
3. When it's live (e.g. `https://droideye.onrender.com`):

```bash
npm run droideye:server -- https://droideye.onrender.com
npm run droideye:sync
```

4. Android Studio → **Build → Generate App Bundles or APKs → Generate APKs**.
   Share the APK on GitHub Releases.

Free Render limits: sleeps after 15 min idle (about 1 min to wake; the app shows a
retry screen), 512 MB RAM, 5 GB/month bandwidth.

## 3. Next steps (planned)

- **Bring your own key:** a settings screen in the app; keys stay in the
  Android Keystore and voice sessions are started from the phone.
- Phone-friendly HUD: bigger touch targets, fewer default layers.
- App icon and splash screen.

## Data and licence notes

- Keep `LICENSE` (MIT, © 2026 Bilawal Sidhu) and credit the original project.
- See `DATA_SOURCES.md`. OpenSky (flights), Cesium ion's free tier, Google News RSS,
  TeleGeography and the Nepal flood scene are **non-commercial**.
- Pull upstream updates: `git fetch upstream && git merge upstream/main`.
