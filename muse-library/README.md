# Muse Library

Your Instagram saves, collected by Muse and sorted by you.

## Setup (about 10 minutes, no code, no settings to type)

**1. Put it on GitHub**
1. Go to github.com and click **New repository**. Name it `muse-library`, choose **Private**, click **Create**.
2. Click **uploading an existing file**.
3. Open this folder, select everything inside it, and drag it into the page. Click **Commit changes**.

**2. Deploy on Railway**
1. Go to railway.com and sign in with GitHub.
2. Click **New Project**, then **Deploy from GitHub repo**, then pick `muse-library`. Allow access if asked.
3. When the service box appears, right-click it (or press Cmd/Ctrl+K), choose **Add Volume**. Any mount path works, `/data` is fine. This is the storage that keeps your saves.
4. Click the service, open **Settings**, scroll to **Networking**, click **Generate Domain**.

**3. Open it**
1. Visit your new domain. Create a password. That's your login on every device.
2. A **Connect Muse** window opens. Click **Copy for Muse** and paste it to Muse.
3. Send Muse a reel. It shows up in your Inbox within a few seconds.

On your phone: open the site in Safari, tap Share, then **Add to Home Screen**.

## Good to know
- **Cost:** Railway's trial is free. To keep it running all month, the Hobby plan is $5/month.
- **Backups:** your library keeps a backup copy plus a daily snapshot for 14 days in the volume. Download a full export any time at `/api/export` while signed in.
- **New Muse key:** click Connect Muse in the bottom of the sidebar, then **New Muse key**. Send Muse the updated message.
- **Missing preview:** some posts block previews. The post still saves. Open it and hit Refresh, or use Load embed. Failed previews also retry on their own a few times.
- **Updates:** change files in GitHub and Railway redeploys automatically. Your saves are untouched.
- **Shortcuts:** `/` search, `Esc` close, arrow keys step through posts, Cmd/Ctrl-click to select several, drag posts onto folders.

## Optional settings
Nothing is required. If you want, these Railway variables override the defaults:
`OWNER_KEY` (fixed password), `MUSE_KEY` (fixed Muse key), `DATA_DIR` (storage path).

## Run on your own computer
Install Node 20+, then in this folder run `node server.js` and open http://localhost:3000.
