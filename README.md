# Warehouse DJ

A shared music queue for the IND Technology warehouse. One Spotify Premium account plays through the warehouse speakers. Worker iPads search for songs, add them to the queue, play, pause, skip and 👍 songs. A small backend applies the rules (queueing hours, breaks, how many songs each iPad can add) before anything reaches Spotify.

- **Address:** `https://warehouse-dj-bd640.web.app`. Everyone uses this one address. Admins tap **Admin** at the very bottom of the page and sign in with their PIN (`/admin` also works directly).

## How it fits together

| Piece | What it is | Where it runs |
|---|---|---|
| Speaker iPad | The clock-in iPad, running the Spotify app on the host account, cabled to the speaker | Warehouse |
| Worker iPads | The Warehouse DJ page, opened from a Home Screen icon | Warehouse |
| Backend | Node.js on Firebase Cloud Functions. It holds the Spotify login, checks the rules and talks to Spotify | Sydney (`australia-southeast1`) |
| Live state | One Firestore document with what's playing, what's next and whether queueing is open. Every iPad listens to it | Melbourne (`australia-southeast2`) |
| Pages | Firebase Hosting | Google's CDN |

The iPads never log in to Spotify. They can only read the live-state document, and every action goes through the backend. During music hours the backend checks Spotify once a minute, and again the moment each song ends, so changes made by hand on the speaker iPad show up within a minute. **Outside music hours it doesn't contact Spotify at all**, and the iPads show nothing about what's playing.

Searches go to Spotify as the app itself, not as the host account, so results aren't shaped by the host's own likes and listening history.

The backend runs in Sydney because Google's scheduler isn't offered in Melbourne.

## The rules

All of these can be changed on the admin page and take effect within about 10 seconds.

| Rule | Default |
|---|---|
| Work days | Monday–Friday |
| Music hours | 8:00am–4:00pm (Melbourne time; daylight saving handled). Outside these, nothing is shown or recorded |
| Queueing hours | 9:20am–4:00pm (must sit inside music hours) |
| Breaks | 10:20am for 20 minutes and 1:20pm for 40 minutes. Queueing is closed during breaks |
| Pause at break start, resume at break end | On. It pauses whatever your account is playing, and only resumes music it paused itself. **Test a break** on the admin page tries it out in 15 seconds |
| Songs per iPad | 3 every 30 minutes |
| Most songs in the queue | 20 |
| Longest song | 7 minutes |
| No repeats | Within 2 hours (counts songs that played from the playlist too) |
| Explicit songs | Allowed |
| Play, pause, skip | Anyone, from any iPad. Skip has an 8-second cooldown so a double tap doesn't skip two songs |

---

## One-time setup

This takes about 30 minutes on a Mac or Windows computer. You only do it once.

### 1. Install the tools

1. Install **Node.js 22 LTS** from <https://nodejs.org>.
2. Open Terminal (Mac) or PowerShell (Windows) and run:
   ```sh
   npm install -g firebase-tools
   firebase login
   ```
   Sign in with the Google account that owns the `warehouse-dj-bd640` Firebase project.

### 2. Get the code

```sh
git clone https://github.com/ej-blip/Warehouse-DJ.git
cd Warehouse-DJ
cd functions
npm install
cd ..
```

If you don't use git, download the ZIP from the repository page on GitHub instead, unzip it, and run the `npm install` lines inside the folder.

All the commands below are run from the `Warehouse-DJ` folder.

### 3. Firebase console

You've already switched to the Blaze plan and created Firestore in Melbourne. One more check:

- Go to **Project settings → General → Your apps**. If no web app is listed, click the **`</>`** (Web) button, name it `Warehouse DJ` and register it. You don't need to copy the config it shows, because Hosting supplies it automatically.

### 4. Spotify developer dashboard

Go to <https://developer.spotify.com/dashboard>, open your app, then **Settings → Edit**:

- Under **Redirect URIs**, add exactly `https://warehouse-dj-bd640.web.app/api/auth/callback`. Keep the existing `http://127.0.0.1:8000/callback`; it's harmless.
- Under **APIs used**, make sure **Web API** is ticked.
- Click **Save**.

Your own Spotify account owns the app, so you don't need to add any users. Spotify requires the owner to keep Premium, or the app stops working.

### 5. Store the two secrets

These go into Google Secret Manager, never into the code.

```sh
firebase functions:secrets:set SPOTIFY_CLIENT_SECRET
```

When asked, paste the **Client Secret** from the Spotify dashboard (**Settings → View client secret**).

```sh
firebase functions:secrets:set ADMIN_SETUP_CODE
```

Make up a code, such as three random words, and **save it in your password manager**. You need it to create the first admin, and later if the owner forgets their PIN.

### 6. Deploy

```sh
firebase deploy
```

The first deploy takes about 5 minutes and switches on a few Google Cloud services. If it asks about a **cleanup policy** for container images, answer **yes** with **1 day**; that keeps storage free. When it finishes, it prints `Hosting URL: https://warehouse-dj-bd640.web.app`.

To deploy updates later, run `firebase deploy` again.

### 7. Sign in and connect Spotify

1. Open `https://warehouse-dj-bd640.web.app/admin` on your phone or computer.
2. Enter the setup code, your name and a 6–8 digit PIN. You're now the **owner**.
3. Tap **Connect Spotify** and log in with the Spotify account that will play the music, then tap **Agree**.

### 8. Set up the speaker iPad (the clock-in iPad)

1. Keep it plugged in and cabled to the speaker. Turn **Low Power Mode** off and set **Settings → Display & Brightness → Auto-Lock** to **Never**.
2. In the Spotify app, sign in with the same account and play anything once, so it shows up in Spotify's device list.
   - Make sure **Private Session** is off.
   - Under **Settings → Playback → Autoplay**, choose whether Spotify keeps playing similar music after a playlist ends.
3. On the admin page:
   - Under **Speaker iPad**, choose it from the list.
   - Under **Starting playlist**, tap **Play** on the playlist you want. It plays whenever nobody has queued anything.

**Breaks tip:** after clocking out in Roster Elf, switch the speaker iPad back to the Spotify app and leave it on screen. iOS can close Spotify when it sits paused in the background, and then nothing can start it remotely. If that does happen, the worker iPads say *"Open Spotify on the clock-in iPad and press play"*. Whoever clocks in first can do that.

### 9. Set up each worker iPad

Do this on the iPad itself. There's no link to send around.

1. On the iPad, open `https://warehouse-dj-bd640.web.app` in **Safari** and tap **Share → Add to Home Screen**.
2. Open Warehouse DJ from the new Home Screen icon. It says **Set up this device**.
   - **Set it up inside the icon, not in Safari.** iPads keep the icon's storage separate from Safari's, so setup done in a Safari tab doesn't carry over.
3. Type a name (e.g. *Packing 1*) and an admin PIN, then tap **Set up this device**. The iPad now has its own private key, which never leaves it.
4. Set **Auto-Lock** to **Never** and keep the iPad plugged in. To stop workers leaving the app, you can turn on **Guided Access** (**Settings → Accessibility → Guided Access**).

**Android phones** (e.g. Samsung): open the address in **Chrome** and set it up straight away. Adding it to the home screen is optional, because Chrome shares its storage with the shortcut.

**Test links:** for testing, the admin page can still make a link for a device under **iPads → Or make a test link**. Anyone with a link can use it, so remove test links when you're done.

If an iPad goes missing, use **Switch off** or **Remove** on the admin page. If one is reset, set it up again.

To add more admins, the owner adds them under **Admins**, giving each person their own PIN. If an admin signs in on a worker iPad, admin mode signs itself out after 5 minutes of no use.

---

## Day to day

- **Queueing.** Workers search, tap **Add**, and the song joins the queue. Each iPad shows how many songs it has left and when its next one frees up, so nobody needs to keep checking.
- **Breaks.** Queueing closes at 10:20am and 1:20pm. The music pauses and starts again at 10:40am and 2:00pm, and songs queued before the break are still there afterwards. If Spotify lost them because iOS closed the app, the backend adds them back when the music restarts.
- **Music hours.** Before 8:00am and after 4:00pm, the iPads show a "Music hours" message and can't search, queue or control the music. Admins can still control it from the admin page. "Recently played" starts empty each morning.
- **Admins** can also skip, loop or shuffle the playlist, change the starting playlist and change any rule.

### Weekly favourites

Every **Sunday at 8pm** a private playlist called **Warehouse Favourites** in the host Spotify account is replaced with that week's songs:

- It includes every song queued that week, plus any song that got a 👍 (including songs from the starting playlist).
- The most-liked songs come first, then the ones queued most often. It holds up to 100 songs.
- If nothing was queued or liked that week, last week's playlist is left alone.

On Monday, tap **Weekly favourites → Play it now** to start the shift with it. **Rebuild now** builds it straight away from the week so far.

### Every 6 months: reconnect Spotify

Since July 2026, Spotify ends app logins 6 months after you sign in, however often they're used. The admin page shows the date and starts warning 2 weeks before. Tap **Reconnect Spotify**, log in, and you're good for another 6 months. **Put a reminder in your calendar.** If it does lapse, the iPads say *"Spotify's login has expired"* until someone reconnects.

### When something goes wrong

| What you see | What to do |
|---|---|
| "The speaker isn't reachable…" | Open Spotify on the clock-in iPad and press play. |
| "Spotify's login has expired" | Admin page → **Reconnect Spotify**. |
| "…in a Private Session…" | In Spotify on the speaker iPad, turn off Private Session. |
| "Set up this device" | The iPad was removed or reset. Set it up again with an admin PIN (step 9). |
| Music doesn't pause at a break | Tap **Test a break** on the admin page. If that works, check the break times and work days in **Rules**. |
| "Reconnecting…" banner | The Wi-Fi dropped. It recovers by itself. |
| A Spotify-made playlist won't start from the admin page | Spotify blocks some of its own playlists from apps. Start it in the Spotify app on the speaker iPad instead. |
| Owner forgot their PIN | Admin sign-in → **Owner forgot their PIN?** → enter the setup code. |
| Something else | Firebase console → **Functions → Logs** shows what the backend did. |

## Costs

At this size, everything should stay inside Firebase's free allowances, so expect **$0 a month**. A few cents of image storage is possible if you didn't set the cleanup policy.

Budget alerts only send emails; they don't stop charges. Your $1 alert will tell you early if that ever changes.

## Automatic deploys

Every push to the `claude/sleepy-carson-oatjxh` branch runs the tests on GitHub and, if they pass, deploys to `warehouse-dj-bd640` by itself. Nothing is deployed if a test fails. You can watch runs, or start one by hand, under the repository's **Actions** tab (**Deploy to Firebase → Run workflow**).

One-time setup: a deploy account in Google Cloud, with its key stored in GitHub.

1. Open <https://console.cloud.google.com/iam-admin/serviceaccounts?project=warehouse-dj-bd640> and click **+ Create service account**. Name it `github-deploy`, then click **Create and continue**.
2. Add these roles, then click **Done**:
   - Firebase Admin
   - Cloud Functions Admin
   - Cloud Run Admin
   - Service Account User
   - Cloud Scheduler Admin
   - Secret Manager Admin
   - Artifact Registry Administrator
   - Service Usage Consumer
3. Click the new account, open **Keys → Add key → Create new key → JSON → Create**. A `.json` file downloads.
4. On GitHub, open the repository's **Settings → Secrets and variables → Actions → New repository secret**. Name it `FIREBASE_SERVICE_ACCOUNT`, paste the **entire contents** of the `.json` file, then click **Add secret**.
5. Delete the downloaded `.json` file and empty the Bin. It works like a password.
6. Go to **Actions → Deploy to Firebase → Run workflow** to deploy straight away.

If a run fails with a "permission" error, the log names the missing role; add it to `github-deploy` in Google Cloud (**IAM → edit the account**). If Google refuses to create a key (an organisation policy), use a different way to sign in (Workload Identity Federation) instead.

## Moving to a work Spotify account later

1. Get the work Premium account.
2. In the Spotify dashboard, open **User Management** and add the work account's email. Development Mode allows up to 5 users.
3. On the speaker iPad, sign out of Spotify and sign in with the work account.
4. On the admin page, tap **Reconnect Spotify** and log in with the work account. Then choose the speaker and a starting playlist again.
5. Warehouse Favourites is recreated in the new account the next Sunday, or straight away with **Rebuild now**.

Your personal account must keep Premium while it owns the developer app. Alternatively, create a new developer app under the work account, put its Client ID in `functions/src/config.js`, set its secret again (step 5) and redeploy.

## Things to know

- **Spotify branding.** Spotify's developer terms require attribution. The pages say *"Song info and artwork from Spotify"* and link each song back to Spotify. Spotify's official logo isn't in the repo yet: download it from Spotify's Design & Branding Guidelines and add it to the page footers.
- **Licensing.** Spotify's consumer terms limit Premium to personal, non-commercial use. Check with whoever handles compliance before relying on this long term.
- **The queue can't be edited.** Spotify doesn't let apps remove or reorder queued songs. Skip a song when it comes up.
- **Volume is set by hand** on the speaker iPad or the amp.
- **Search** returns 10 songs at a time (a Spotify Development Mode limit). **Show more** loads the next 10.

---

## For developers

```
firebase.json            Hosting, the /api rewrite, emulator ports
firestore.rules          iPads may read public/state only
functions/
  index.js               api (HTTP), tick (every minute; contacts Spotify only in music hours), weeklyFavourites (Sunday 8pm)
  src/config.js          region, time zone, Spotify client ID, default rules
  src/rules.js           the gatekeeper: schedule, quotas, song checks (pure functions)
  src/core.js            shared queue state and what the iPads see (pure functions)
  src/playback.js        sync, queueing, play/pause/skip, likes, breaks
  src/spotify.js         Spotify client: login, token refresh, retries, 429 handling
  src/auth.js            iPad links, admin PINs and sessions, lockout
  src/api.js             HTTP routes
  src/favourites.js      weekly playlist
  test/                  unit tests
  integration/           end-to-end test against the Firestore emulator and a fake Spotify
public/
  index.html, js/app.js  worker iPad page
  admin.html, js/admin.js admin page
```

### Tests

```sh
cd functions
npm test                    # unit tests
npm run test:integration    # needs Java; runs against the Firestore emulator and a fake Spotify
```

### Running everything locally

1. Create `functions/.env.local`:
   ```
   SPOTIFY_API_BASE=http://127.0.0.1:8787/v1
   SPOTIFY_ACCOUNTS_BASE=http://127.0.0.1:8787
   SITE_URL=http://127.0.0.1:5000
   ```
2. Create `functions/.secret.local`:
   ```
   SPOTIFY_CLIENT_SECRET=test-client-secret
   ADMIN_SETUP_CODE=let-me-in
   ```
3. Start the fake Spotify with `node functions/integration/serve-fake.js`, then run `firebase emulators:start --only functions,firestore,hosting --project demo-warehouse-dj`.
4. Open `http://127.0.0.1:5000/admin` and use the setup code `let-me-in`.

Both `.local` files are git-ignored and never deployed.
