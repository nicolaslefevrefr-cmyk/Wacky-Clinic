# Wacky Clinic

A Theme Hospital-inspired hospital management game, built as a static, installable web app
(PWA) with no build step and no backend.

## Project structure

```
.
├── index.html                  entry point
├── manifest.webmanifest        PWA metadata (name, icons, colors)
├── service-worker.js           offline caching (app shell)
├── css/
│   └── style.css               all styling
├── js/
│   └── app.js                  game logic (data, engine, rendering, UI)
└── icons/
    ├── icon-192.png
    ├── icon-512.png
    ├── icon-512-maskable.png
    └── apple-touch-icon.png
```

## Deploying to GitHub Pages

1. Create a new GitHub repository and push the **contents of this folder** to it (i.e. `index.html`
   should sit at the repo root, not inside a subfolder) — or push as-is if you're fine with the
   game living at `/wacky-clinic/` on your Pages site.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to "Deploy from a branch", pick the branch
   (usually `main`) and the `/ (root)` folder, then save.
4. GitHub will publish the site at `https://<your-username>.github.io/<repo-name>/`. It can take
   a minute or two after the first push.
5. Open that URL — the game should load directly, no further configuration needed. All paths in
   `index.html` and `service-worker.js` are relative, so it works whether the site is served from
   a domain root or a project subpath.

## Installing as an app on Android

Once the site is live on GitHub Pages (installability requires HTTPS, which Pages provides
automatically):

1. Open the site's URL in **Chrome on Android**.
2. Chrome will detect the web app manifest and service worker. Tap the **⋮** menu → **Add to Home
   screen** (or you may see an automatic "Install app" banner/prompt).
3. Confirm — the game now has its own icon on the home screen and launches full-screen, like a
   native app, including basic offline support (after the first successful load, the app shell
   is cached and will still open without a network connection).

The same manifest also works on desktop Chrome/Edge (install icon in the address bar) and on
iOS Safari (Share → Add to Home Screen, though iOS doesn't support the install prompt or full
service worker feature set the same way Android does).

## Local development

No build step - just serve the folder statically and open it, e.g.:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

(Opening `index.html` directly via `file://` will mostly work too, but the service worker won't
register under `file://`, and some browsers restrict other features for local files - a local
server is recommended.)

## Notes for further development

- `js/app.js` is a single IIFE containing: the `GAME_DATA` config (rooms, diseases, staff types,
  machines, research, events), the game engine (`Hospital`, `Patient`, `Staff`, `Game` classes),
  rendering, and all UI wiring. It's one file by design (this was split out of a single-file
  prototype) - splitting it further into modules would require converting it to ES modules
  (`type="module"` script tag) and adding explicit imports/exports.
- Bump `CACHE_NAME` in `service-worker.js` (e.g. `wacky-clinic-v2`) whenever you deploy a change,
  so returning visitors actually get the update instead of a stale cached version.
- Save data is stored in the browser's `localStorage`, scoped to the origin the game is served
  from - it will not carry over between e.g. `localhost` during development and the deployed
  GitHub Pages URL.
