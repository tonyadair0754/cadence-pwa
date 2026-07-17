/* ============================================================
   Cadence backend
   Two scheduled functions:
   - dailyReminders: once a day, a digest of everything due/open
     that does NOT have its own custom reminder time.
   - preciseReminders: every minute, an individual push for any
     step whose custom reminder time (down to the minute) matches
     right now.
   Both require the Blaze (pay-as-you-go) plan — see README.
   ============================================================ */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const logger = require('firebase-functions/logger');

initializeApp();
const db = getFirestore();
const TIMEZONE = 'America/Denver'; // change to your own, e.g. 'America/New_York'

function todayStr() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function sendToUid(uid, title, body, tag, subtaskId) {
  const tokenSnap = await db.collection('tokens').where('uid', '==', uid).get();
  const tokens = tokenSnap.docs.map((d) => d.id);
  if (tokens.length === 0) {
    logger.info(`No tokens on file for uid ${uid} — nothing to send to.`);
    return;
  }
  try {
    // Data-only payload (no top-level "notification" field) is deliberate: when a
    // push includes a "notification" field, FCM's web SDK auto-displays it AND our
    // own onBackgroundMessage handler displays it again — two notifications for one
    // message. Sending data-only means our service worker is the only thing that
    // ever calls showNotification, so there's exactly one.
    // `tag` matters too: a shared tag across sends makes Android collapse them into
    // one stacked notification instead of showing each individually.
    // `subtaskId`, when present, lets the service worker offer a "Mark complete"
    // action right on the notification. Only set for single-task pushes (precise
    // reminders) — the daily digest covers multiple tasks so there's no one task
    // to mark complete from it.
    const data = { title, body, link: '/', tag: tag || 'cadence' };
    if (subtaskId) data.subtaskId = subtaskId;
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data,
      webpush: { fcmOptions: { link: '/' } }
    });
    logger.info(`Sent to uid ${uid}: ${res.successCount} succeeded, ${res.failureCount} failed`);
    const stale = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        logger.warn(`Push failed for a token of uid ${uid}: ${r.error && r.error.message}`);
        stale.push(tokens[i]);
      }
    });
    await Promise.all(stale.map((t) => db.collection('tokens').doc(t).delete()));
  } catch (err) {
    logger.error(`Failed to send to uid ${uid}`, err);
  }
}

// Once a day: digest of anything due today/overdue that has no custom time set.
exports.dailyReminders = onSchedule(
  { schedule: 'every day 08:00', timeZone: TIMEZONE },
  async () => {
    const today = todayStr();

    const [subtaskSnap, projectSnap] = await Promise.all([
      db.collection('subtasks').where('completed', '==', false).where('date', '<=', today).get(),
      db.collection('projects').where('dueDate', '==', today).get()
    ]);

    const byUid = {};
    const bump = (uid) => (byUid[uid] = byUid[uid] || { tasks: [], dueProjects: [] });

    subtaskSnap.forEach((doc) => {
      const d = doc.data();
      if (d.reminderTime) return; // has its own scheduled ping via preciseReminders instead
      bump(d.uid).tasks.push(d.title);
    });
    projectSnap.forEach((doc) => {
      const d = doc.data();
      bump(d.uid).dueProjects.push(d.title);
    });

    const uids = Object.keys(byUid);
    logger.info(`Daily digest: ${uids.length} user(s)`);

    for (const uid of uids) {
      const { tasks, dueProjects } = byUid[uid];
      let body = '';
      if (dueProjects.length) body += `Due today: ${dueProjects.join(', ')}. `;
      if (tasks.length) body += `${tasks.length} task${tasks.length > 1 ? 's' : ''} on today's list.`;
      if (!body) continue;
      await sendToUid(uid, 'Cadence', body.trim(), `daily-digest-${today}`);
    }
  }
);

// Every minute: individual pings for steps whose custom reminder time is right now.
exports.preciseReminders = onSchedule(
  { schedule: '* * * * *', timeZone: TIMEZONE },
  async () => {
    const today = todayStr();
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const nowLabel = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const snap = await db.collection('subtasks')
      .where('completed', '==', false)
      .where('reminderTime', '==', nowLabel)
      .where('date', '==', today)
      .get();

    if (snap.empty) return;
    logger.info(`Precise reminders at ${nowLabel}: ${snap.size} task(s)`);

    // Fetch project titles for context, then send one push per task.
    // For a single (one-off) task, the project's title and its lone step's title
    // are identical by design (see saveProject in app.js) — so that case shows
    // just the title once instead of "Title — Title".
    const projectCache = {};
    for (const doc of snap.docs) {
      const s = doc.data();
      if (!projectCache[s.projectId]) {
        const pDoc = await db.collection('projects').doc(s.projectId).get();
        projectCache[s.projectId] = pDoc.exists ? pDoc.data().title : '';
      }
      const projectTitle = projectCache[s.projectId];
      const body = (projectTitle && projectTitle !== s.title) ? `${s.title} — ${projectTitle}` : s.title;
      await sendToUid(s.uid, 'Cadence', body, `task-${doc.id}`, doc.id);
    }
  }
);