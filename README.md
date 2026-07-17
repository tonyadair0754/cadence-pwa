# Cadence — deployment guide

**New in this update:** Google Sign-In for multi-device sync, a redesigned app icon/favicon, per-step custom reminder times, inline category creation, editable category colors, project sorting/grouping controls, and a weekly view. If you're updating an existing deployment, skip to [Updating an existing deployment](#updating-an-existing-deployment) at the bottom — you don't need to redo the whole setup.

This turns the app into a real installable PWA with push notifications, backed
by Firebase (Firestore for data, Cloud Functions for the daily reminder,
Firebase Cloud Messaging for the push itself). Follow these in order —
each step depends on the one before it.

**Time to first deploy: ~30–45 minutes**, almost all of it clicking through
the Firebase console once.

---

## 0. What you'll have accounts/tools for
- A Google account (for Firebase — free to start)
- Node.js installed on your computer (v18 or newer)
- A terminal

---

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project** → name it (e.g. "cadence") → finish the wizard (Analytics is optional, skip it).
2. In the left sidebar: **Build → Firestore Database → Create database** → start in **production mode** → pick a location close to you.
3. In the left sidebar: **Build → Cloud Messaging** — nothing to configure yet, just confirm it's enabled.
4. **Project settings** (gear icon, top left) → **General** tab → scroll to "Your apps" → click the **`</>`** (web) icon → register an app (nickname "cadence-web", no hosting setup needed here) → you'll see a `firebaseConfig` object. Copy it.
5. Still in Project settings → **Cloud Messaging** tab → scroll to **Web configuration** → **Generate key pair**. Copy the key that appears — this is your `VAPID_KEY`.

## 2. Drop your keys into the code

Open these two files and replace the placeholder `firebaseConfig` object and `VAPID_KEY`/`YOUR_...` values with what you copied in step 1:

- `public/app.js` (top of the file — both `firebaseConfig` and `VAPID_KEY`)
- `public/firebase-messaging-sw.js` (`firebaseConfig` only — must match `app.js` exactly)

## 3. Turn on sign-in methods

This app signs you in anonymously by default so your data has an owner without forcing a login screen — and now also supports upgrading that to Google Sign-In so your tasks follow you across devices.

In the console: **Build → Authentication → Get started → Sign-in method**:
- Enable **Anonymous**
- Enable **Google** (pick a support email when prompted)

## 4. Install the Firebase CLI and connect the project

```bash
npm install -g firebase-tools
firebase login
```

In this project's root folder (the one with `firebase.json`):

```bash
firebase use --add
```

Pick the project you created in step 1, give it an alias like `default`.

## 5. Deploy Firestore security rules and indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Rules make sure only you (via your account) can read or write your own data. The indexes are required for the reminder queries the backend runs — deploying without them will make the scheduled functions error out the first time they run, so don't skip this even though nothing visibly changes yet.

## 6. Install and deploy the backend function

```bash
cd functions
npm install
cd ..
```

**Important:** scheduled Cloud Functions (the kind that runs once a day on a timer) require the **Blaze (pay-as-you-go)** plan, not the free Spark plan. The console will prompt you to upgrade when you deploy. For a single-user daily reminder like this, you'll stay comfortably within the free tier included in Blaze — realistically $0/month — but Google requires a billing method on file. Set a budget alert if you want peace of mind (**Billing → Budgets & alerts**).

```bash
firebase deploy --only functions
```

This deploys two scheduled functions:
- **`dailyReminders`** — runs once a day at 8:00 AM (`TIMEZONE` constant at the top of `functions/index.js` — change it to your own, e.g. `America/New_York`), and sends one digest push for anything due or overdue that doesn't have its own custom reminder time.
- **`hourlyReminders`** — runs on the hour, every hour, and sends an individual push for any step where you picked a specific reminder time when creating it.

## 7. Deploy the frontend

```bash
firebase deploy --only hosting
```

You'll get a live URL like `https://your-project-id.web.app`. That's your app.

---

## 8. Install it and turn on notifications

**Android (Chrome):**
1. Visit the URL. Chrome may offer "Add to Home screen" automatically, or use the menu (⋮) → **Add to Home screen**.
2. Open it from the home screen icon, go to any tab, and tap **Turn on** on the notifications banner.

**iPhone (Safari) — Apple requires one extra step:**
Web push on iOS *only* works from an app that's been added to the Home Screen — it won't work in a normal Safari tab, and Chrome-on-iOS can't do it at all (Apple's rule, not ours).
1. Open the URL in **Safari**.
2. Tap the Share icon → **Add to Home Screen**.
3. Open Cadence from the icon that appears on your Home Screen (not from Safari).
4. Tap **Turn on** on the notifications banner and allow when prompted.

**Desktop (Chrome/Edge/Firefox):** just visit the URL and tap **Turn on** — installing to the dock is optional but available from the browser's install icon in the address bar.

---

## How the notification actually gets to you

1. When you tap "Turn on," the browser gives the app a unique **FCM token**, which gets saved to a `tokens` collection in Firestore, tied to your account.
2. Every day at the time you set, the `dailyReminders` Cloud Function runs on Google's servers (not your phone — it works even if the app is closed), checks Firestore for anything due today or still incomplete from before, and sends one push per token through FCM.
3. Your phone/browser receives it via the service worker (`firebase-messaging-sw.js`) and shows it, even if Cadence isn't open.
4. Tapping the notification opens the app.

If you ever uninstall the app or deny permission, that token stops working — the function detects the failure and automatically removes stale tokens on its next run.

## Multi-device sync (Google Sign-In)

Tap the account icon (top right, any tab) → **Sign in with Google**. This uses a redirect, not a popup — you'll briefly leave the app and come back, which is more reliable than a popup once the app is installed to your home screen.

- If you're currently a guest, this **links** Google to your existing anonymous account, so all your current tasks carry over.
- If that Google account already has Cadence data from somewhere else (e.g. you signed in on a different device first), you'll be asked whether to switch to that account instead — your guest data on *this* device stays put but won't merge automatically.
- Once signed in with Google, open the same URL on any other device and sign in with the same account — your categories, projects, and steps sync live via Firestore.

---

## Production workflow

Once the app is live, you'll want a way to test changes before your actual daily task list is affected by a half-finished feature. Here's a workflow that fits a solo project without over-engineering it:

**1. Keep changes in a git repo.** If you haven't already:
```bash
git init
git add .
git commit -m "Initial deploy"
```
Push it to a private GitHub repo so you have history and can undo mistakes.

**2. Test locally first.**
```bash
firebase emulators:start
```
Catches most bugs — data logic, UI, rendering — without touching production data. (Push notifications don't emulate; test those against a real deploy.)

**3. Use a preview channel for anything you're not sure about.** Instead of deploying straight to your main URL:
```bash
firebase hosting:channel:deploy preview-feature-x
```
This gives you a temporary, shareable URL (something like `cadence-fad9c--preview-feature-x-xxxxx.web.app`) running your latest code against the **same live database**, so you can click around on your phone exactly like production, without touching the URL you actually rely on day to day. Preview channels expire automatically after a set number of days.

**4. Promote to production once it looks right.**
```bash
firebase deploy --only hosting
```

**5. Functions don't have a preview-channel equivalent** the way Hosting does — changes to `functions/` go live immediately on deploy. For anything risky, test the logic locally first with:
```bash
firebase emulators:start --only functions,firestore
```
or just read through the diff carefully before running `firebase deploy --only functions`, since a bad scheduled function can silently fail to notify you rather than error loudly.

**6. Optional next step — auto-deploy on push.** Once this feels routine, `firebase init hosting:github` sets up a GitHub Action that deploys a preview channel on every pull request and deploys to production automatically when you merge to `main`. Worth doing once you're making changes often enough that typing `firebase deploy` gets old — not necessary before then.

## Local testing before you deploy

```bash
firebase emulators:start
```

Runs Hosting + Firestore locally. Push notifications themselves still need a real deploy (FCM doesn't emulate), but everything else — adding projects, rollover, the calendar — works fully offline against the emulator.

---

## Updating an existing deployment

You already have this project running, so you don't need to repeat steps 1–4. Just:

1. **Enable Google sign-in** (new step 3 above): Console → Authentication → Sign-in method → enable **Google**.
2. **Replace your local files** with the ones in this update (`public/`, `functions/index.js`, `firestore.indexes.json`, `firebase.json`). If you changed anything of your own in `app.js` or elsewhere, diff before overwriting.
3. Re-check that your `firebaseConfig` and `VAPID_KEY` are still filled in at the top of `public/app.js` and `public/firebase-messaging-sw.js` — copying the new files will restore the placeholder values, so paste your real ones back in.
4. Deploy everything:
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
   ```
5. Hard-refresh the app on each device (or fully close and reopen it if installed) so the new service worker takes over — service workers update in the background and need a reload to activate.
