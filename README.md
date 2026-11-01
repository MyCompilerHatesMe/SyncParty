# SyncParty

Watch party extension for Chrome and Firefox (MV3) + a Node WebSocket relay server. Built for sketchy streaming sites where the actual `<video>` is buried 3 iframes deep behind fake ad overlays.

## Features

- **Runs in all nested frames (`all_frames: true`)**: Finds the real video element inside nested iframes and dynamic sandboxes.
- **Ad hygiene**: Auto-skips short (<180s) pre-roll ads and tiny ad banners. If an ad ends and swaps to the real movie, it re-binds on the feature video automatically.
- **Manual element picker**: If a site hides the video or uses a custom wrapper, click **Select video** and click the player directly (it sees through transparent overlay ads).
- **Anti-echo mutex + drift governor**: Prevents infinite event bouncing. Nudges playback rate (`0.95x` / `1.05x`) for small drift (`0.25s - 1.5s`) so audio doesn't pop, and hard seeks if you're `>1.5s` off.
- **Host page link & mismatch warning**: Non-host peers see what page the host is on. If your video length doesn't match the host's, you'll get a warning with a direct link to the host's video (opens in the same tab so you keep your room session and auto-sync on load).
- **"Sync to host" button**: If a peer ever gets desynced, clicking **Sync to host** pings the host for their exact timestamp and force-seeks right to it.
- **Hidden by default**: Stays out of the way until you click the SyncParty extension icon in your browser toolbar.
- **uBlock Origin friendly**: Mounted inside custom `<sp-ext-dock>` and `<sp-ext-picker>` tags with zero inline styles on the host element so cosmetic filter lists don't hide the dock.

## Setup & Build

```bash
# install deps in both folders
npm run install:all

# build server + chrome & firefox extensions
npm run build
```

Build outputs:
- `extension/dist/chrome`
- `extension/dist/firefox`
- `server/dist`

## Running locally

Start the relay server (port 8080 by default):
```bash
npm run start:server
```

Run test suite:
```bash
npm run test:server
```

Load the extension:
- **Chrome / Brave**: Go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, pick `extension/dist/chrome`.
- **Firefox**: Go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, pick `extension/dist/firefox/manifest.json`.

Click the SyncParty extension icon in your toolbar on any video page to toggle the menu.

## uBlock Origin note

Pirate streaming sites have aggressive uBlock cosmetic filters that nuke any `<div style="position: fixed; z-index: 2147483647">` appended to `<html>` (because that's how popunder ads work).

SyncParty already works around this by mounting inside custom `<sp-ext-dock>` and `<sp-ext-picker>` elements with no inline styles on the outer tag and all positioning inside the Shadow DOM `:host` stylesheet.

If a site has a nuclear uBlock rule like `*##body > *:not(#app)` that still hides the dock, add this to uBlock Origin -> **My filters**:

```text
*#@#sp-ext-dock
*#@#sp-ext-picker
```

## Deploying to production

1. **Host the relay server (`server/`)**:
   Push `server/` to Railway, Render, or Fly.io (`npm install && npm run build`, start with `npm start`). They give you a free `wss://` URL automatically (browsers block plain `ws://` on real websites unless it's localhost).
2. **Set the server URL**:
   Either paste your `wss://...` URL into the **Server** input inside the extension UI, or change `DEFAULT_URL` in `extension/src/background/service-worker.ts` and `draftServerUrl` in `extension/src/content/ui/dock.ts` before running `npm run build`.
3. **Share with friends**:
   - **Chrome / Brave**: Zip `extension/dist/chrome`, send it to them, load unpacked.
   - **Firefox**: Zip the files inside `extension/dist/firefox`, upload to [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) under **"On your own" (self-distributed)**. Mozilla auto-signs it in ~2 minutes and gives you a `.xpi` file anyone can drag into Firefox to install permanently.
