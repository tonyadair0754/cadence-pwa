/* ============================================================
   Cadence — app.js
   Firebase-backed version: Firestore for data (syncs automatically
   across every device you're signed into), FCM for push notifications.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, linkWithPopup, signInWithRedirect, linkWithRedirect,
  getRedirectResult, signInWithCredential, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage, isSupported as messagingIsSupported
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

/* ---------------- REPLACE with your Firebase project's config ---------------- */
/* Firebase Console > Project settings > General > Your apps > SDK setup */
const firebaseConfig = {
  apiKey : "AIzaSyAzmRA26ZM_h7ICSjrmzejjk2sFYIWpyPE" , 
  authDomain : "cadence-fad9c.firebaseapp.com" , 
  projectId : "cadence-fad9c" , 
  storageBucket : "cadence-fad9c.firebasestorage.app" , 
  messagingSenderId : "751914840809" , 
  appId : "1:751914840809:web:6f0827e76cc44962fdf678" , 
  measurementId : "G-5NNP868M9M"
};
/* Firebase Console > Project settings > Cloud Messaging > Web configuration > Generate key pair */
const VAPID_KEY = "BP7oRLpOGPeW4hMNKA05aH7GXcd75iKZOQ34-64dE-YagyH3-YAlladM2OsyY6jRhnPWnfLyNpWO4iTRzrDzUJg";
/* -------------------------------------------------------------------------- */

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

let uid = null;
let messaging = null;

/* ============ Utilities ============ */
function pad(n){return n<10?'0'+n:''+n;}
function todayStr(){const d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
function parseLocal(dateStr){const [y,m,d]=dateStr.split('-').map(Number); return new Date(y,m-1,d);}
function toDateStr(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
function addDays(dateStr, n){const d=parseLocal(dateStr); d.setDate(d.getDate()+n); return toDateStr(d);}
function addMonths(dateStr, n){const d=parseLocal(dateStr); d.setMonth(d.getMonth()+n); return toDateStr(d);}
function dayDiff(aStr,bStr){return Math.round((parseLocal(bStr)-parseLocal(aStr))/86400000);}

// One step forward per the recurrence rule for daily/monthly (weekly with custom
// days is handled separately below via a day-by-day scan, since "every Mon/Wed/Fri"
// isn't a fixed-size jump).
function nextOccurrence(dateStr, freq){
  if(freq==='daily') return addDays(dateStr, 1);
  if(freq==='weekly') return addDays(dateStr, 7);
  if(freq==='monthly') return addMonths(dateStr, 1);
  return addDays(dateStr, 1);
}

// All occurrence dates from `anchor` up to whichever comes first: the recurrence's
// end date, or `horizonDays` out from today. Capped at 200 dates as a hard safety limit
// (e.g. daily-forever shouldn't ever generate an unbounded batch write).
function generateOccurrenceDates(anchor, recurrence, horizonDays){
  const horizon = addDays(todayStr(), horizonDays);
  const cutoff = recurrence.endDate ? (recurrence.endDate < horizon ? recurrence.endDate : horizon) : horizon;
  const dates = [];
  if(recurrence.freq === 'weekly' && recurrence.daysOfWeek && recurrence.daysOfWeek.length){
    let cur = anchor;
    while(cur <= cutoff && dates.length < 200){
      if(recurrence.daysOfWeek.includes(parseLocal(cur).getDay())) dates.push(cur);
      cur = addDays(cur, 1);
    }
  } else {
    let cur = anchor;
    while(cur <= cutoff && dates.length < 200){
      dates.push(cur);
      cur = nextOccurrence(cur, recurrence.freq);
    }
  }
  return dates;
}

// Same idea, but starting strictly after an existing date — used when topping up
// a recurring task that already has some occurrences generated.
function generateOccurrenceDatesAfter(afterDate, recurrence, cutoff){
  const dates = [];
  if(recurrence.freq === 'weekly' && recurrence.daysOfWeek && recurrence.daysOfWeek.length){
    let cur = addDays(afterDate, 1);
    while(cur <= cutoff && dates.length < 200){
      if(recurrence.daysOfWeek.includes(parseLocal(cur).getDay())) dates.push(cur);
      cur = addDays(cur, 1);
    }
  } else {
    let cur = nextOccurrence(afterDate, recurrence.freq);
    while(cur <= cutoff && dates.length < 200){
      dates.push(cur);
      cur = nextOccurrence(cur, recurrence.freq);
    }
  }
  return dates;
}
function formatDisplay(dateStr){return parseLocal(dateStr).toLocaleDateString('en-US',{month:'short', day:'numeric'});}
function formatFull(dateStr){return parseLocal(dateStr).toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'});}
function escapeHtml(s){const d=document.createElement('div'); d.textContent=s; return d.innerHTML;}

const CATEGORY_COLORS = ['#3B6E64','#4C5A9C','#B8754A','#7A5980','#55707D','#8A8340'];
function formatTime(hhmm){
  if(!hhmm) return '';
  const [h,m] = hhmm.split(':').map(Number);
  const period = h>=12?'PM':'AM';
  const h12 = h%12===0?12:h%12;
  return `${h12}:${m<10?'0':''}${m} ${period}`;
}

/* ============ Local mirror of Firestore state ============ */
let state = { categories: [], projects: [], subtasks: [], settings: { autoDeleteCompleted: false } };
let ui = {
  tab: 'today', todayView: 'today', calMonth: new Date().getMonth(), calYear: new Date().getFullYear(),
  selectedDay: null, expandedProjects: {}, notifBannerDismissed: false,
  projectSort: 'due', groupByCategory: true, collapsedProjectCategories: {},
  todaySort: 'due', todayGroupByCategory: true, todayCollapsedCategories: {}
};
let currentUser = null;

/* ============ Auth: anonymous by default, upgradeable to Google ============ */
let unsubscribeFns = [];
function detachListeners(){ unsubscribeFns.forEach(fn=>fn()); unsubscribeFns = []; }

// Register the listener before triggering any sign-in call, so we never miss a state change.
onAuthStateChanged(auth, (user) => {
  if (!user) return;
  currentUser = user;
  const changedAccount = uid !== null && uid !== user.uid;
  uid = user.uid;
  if (changedAccount) { state = { categories: [], projects: [], subtasks: [], settings: { autoDeleteCompleted: false } }; detachListeners(); subtasksLoadedOnce = false; }
  if (unsubscribeFns.length === 0) attachListeners();
  initMessaging();
  render();
});

// Resolve any pending redirect (from a fallback sign-in) BEFORE deciding whether
// to start an anonymous session — otherwise the two can race on some browsers.
(async () => {
  try {
    await getRedirectResult(auth);
  } catch (err) {
    if (err.code === 'auth/credential-already-in-use') {
      const cred = GoogleAuthProvider.credentialFromError(err);
      if (confirm('This Google account already has a Cadence account. Switch to it? Any guest tasks on this device that aren\'t synced will stay here but won\'t be part of that account.')) {
        await signInWithCredential(auth, cred).catch((e)=>console.error('Switch failed', e));
      }
    } else if (err.code === 'auth/missing-initial-state' || err.code === 'auth/web-storage-unsupported') {
      // The browser lost session state across the redirect (common in some installed-PWA
      // and storage-partitioned contexts). Nothing to recover here — signInWithGoogle()
      // tries popup first specifically to avoid this, so this path should be rare.
      console.warn('Redirect sign-in could not complete (lost session state).', err);
    } else if (err.code) {
      console.error('Google sign-in failed', err);
    }
  }
  if (!auth.currentUser) {
    signInAnonymously(auth).catch((err) => {
      console.error('Sign-in failed', err);
      document.getElementById('content').innerHTML =
        `<div class="empty-state"><h3>Couldn't connect</h3><p>${escapeHtml(err.message)}</p></div>`;
    });
  }
})();

async function signInWithGoogle(){
  const provider = new GoogleAuthProvider();
  const isLink = currentUser && currentUser.isAnonymous;
  try {
    // Popup first: it avoids the cross-domain redirect dance (your app's origin →
    // authDomain → Google → authDomain → your app's origin) that installed PWAs and
    // storage-partitioned browsers on Android can lose track of mid-flight.
    if (isLink) await linkWithPopup(currentUser, provider);
    else await signInWithPopup(auth, provider);
    closeModal();
  } catch (err) {
    if (err.code === 'auth/credential-already-in-use') {
      const cred = GoogleAuthProvider.credentialFromError(err);
      if (confirm('This Google account already has a Cadence account. Switch to it? Any guest tasks on this device that aren\'t synced will stay here but won\'t be part of that account.')) {
        await signInWithCredential(auth, cred);
        closeModal();
      }
    } else if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      // Genuine incapability (not the user just closing the window) — fall back to redirect.
      if (isLink) await linkWithRedirect(currentUser, provider);
      else await signInWithRedirect(auth, provider);
    } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      alert('Sign-in failed: ' + err.message);
    }
  }
}
window.signInWithGoogle = signInWithGoogle;

async function signOutOfAccount(){
  if(!confirm('Sign out? A new guest session will start and your synced tasks will no longer be visible on this device unless you sign back in.')) return;
  await signOut(auth);
  await signInAnonymously(auth);
  closeModal();
}
window.signOutOfAccount = signOutOfAccount;

/* ============ Firestore listeners (live sync) ============ */
let subtasksLoadedOnce = false;
function attachListeners() {
  unsubscribeFns.push(onSnapshot(query(collection(db, 'categories'), where('uid', '==', uid)), (snap) => {
    state.categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }));
  unsubscribeFns.push(onSnapshot(query(collection(db, 'projects'), where('uid', '==', uid)), (snap) => {
    state.projects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }));
  unsubscribeFns.push(onSnapshot(query(collection(db, 'subtasks'), where('uid', '==', uid)), (snap) => {
    state.subtasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rollover();
    // Only run the recurring top-up once per session, off the FIRST snapshot after
    // sign-in. Running it on every snapshot (including ones caused by its own writes,
    // or by a brand-new recurring task's own initial batch) is exactly what caused
    // duplicated occurrences — overlapping calls each independently decided "not
    // enough occurrences yet" before the other's write had synced back.
    if (!subtasksLoadedOnce) {
      subtasksLoadedOnce = true;
      extendRecurringProjects();
    }
    cleanupCompleted(); // safe to call on every snapshot: deleting an already-gone doc is a no-op
    render();
  }));
  unsubscribeFns.push(onSnapshot(doc(db, 'settings', uid), (snap) => {
    state.settings = { autoDeleteCompleted: false, ...(snap.exists() ? snap.data() : {}) };
    cleanupCompleted();
    render();
  }));

  // Seed default categories once, if this is a brand new account.
  setTimeout(async () => {
    if (state.categories.length === 0) {
      const defaults = [
        { name: 'School', color: '#3B6E64', order: 0 },
        { name: 'Home', color: '#B8754A', order: 1 },
        { name: 'Church', color: '#7A5980', order: 2 }
      ];
      for (const c of defaults) await addDoc(collection(db, 'categories'), { ...c, uid });
    }
  }, 1200);
}

/* ============ Rollover: push incomplete subtasks forward to today ============ */
let rolloverRan = false;
async function rollover() {
  const t = todayStr();
  const stale = state.subtasks.filter((s) => !s.completed && s.date < t);
  if (stale.length === 0) return;
  const batch = writeBatch(db);
  stale.forEach((s) => {
    batch.update(doc(db, 'subtasks', s.id), {
      date: t,
      deferredCount: (s.deferredCount || 0) + 1,
      originalDate: s.originalDate || s.date
    });
  });
  await batch.commit();
}

/* ============ Push notifications ============ */
async function initMessaging() {
  try {
    if (!(await messagingIsSupported())) return;
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    if (!messaging) {
      messaging = getMessaging(fbApp);
      onMessage(messaging, (payload) => {
        // Foreground push: show it ourselves since the browser won't.
        const title = payload.data?.title || 'Cadence';
        const body = payload.data?.body || '';
        const tag = payload.data?.tag || ('cadence-' + Date.now());
        const subtaskId = payload.data?.subtaskId || null;
        if (Notification.permission === 'granted') {
          reg.showNotification(title, {
            body, icon: '/icons/icon-192.png', tag,
            data: { subtaskId },
            actions: subtaskId ? [{ action: 'complete', title: '✓ Mark complete' }] : []
          });
        }
      });
    }
    // If notifications were already granted (e.g. before switching accounts),
    // silently re-save the token under the current uid so it keeps working.
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if (token) {
        await setDoc(doc(db, 'tokens', token), {
          uid, token, platform: navigator.platform || 'web', createdAt: serverTimestamp()
        });
      }
    }
    render(); // now that messaging exists, the permission banner can show/hide correctly
  } catch (err) {
    console.error('Messaging init failed', err);
  }
}

async function enableNotifications() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      ui.notifBannerDismissed = true;
      render();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (token) {
      await setDoc(doc(db, 'tokens', token), {
        uid, token, platform: navigator.platform || 'web', createdAt: serverTimestamp()
      });
    }
    ui.notifBannerDismissed = true;
    render();
  } catch (err) {
    console.error('Could not enable notifications', err);
    alert('Notifications could not be enabled: ' + err.message);
  }
}
window.enableNotifications = enableNotifications;
window.dismissNotifBanner = () => { ui.notifBannerDismissed = true; render(); };

function notifBannerHTML() {
  if (ui.notifBannerDismissed) return '';
  if (typeof Notification === 'undefined') return '';
  if (Notification.permission === 'granted') return '';
  const iosNote = (/iPhone|iPad|iPod/.test(navigator.userAgent) && !window.navigator.standalone)
    ? '<br>On iPhone: add Cadence to your Home Screen first (Share → Add to Home Screen), then open it from there to turn this on.'
    : '';
  return `<div class="notif-banner">
    <p>Turn on notifications to get a daily nudge for what's on your list.${iosNote}</p>
    <button onclick="enableNotifications()">Turn on</button>
    <button class="dismiss" onclick="dismissNotifBanner()">Not now</button>
  </div>`;
}

/* ============ Account modal ============ */
function openAccountModal(){
  const isGoogle = currentUser && currentUser.providerData.some(p=>p.providerId==='google.com');
  const overlay = document.getElementById('modalOverlay');
  let body;
  if(isGoogle){
    const info = currentUser.providerData.find(p=>p.providerId==='google.com');
    body = `
      <h2>Account</h2>
      <div class="account-row">
        <div class="account-avatar">${info.photoURL?`<img src="${info.photoURL}">`:escapeHtml((info.displayName||'?')[0])}</div>
        <div>
          <div style="font-weight:600; font-size:14.5px;">${escapeHtml(info.displayName||'Signed in')}</div>
          <div style="font-size:12.5px; color:var(--text-muted);">${escapeHtml(info.email||'')}</div>
        </div>
      </div>
      <p class="helper-text" style="margin:12px 0 16px 0;">Your tasks sync to any device signed into this Google account.</p>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">Close</button>
        <button class="btn-primary" style="background:var(--danger);" onclick="signOutOfAccount()">Sign out</button>
      </div>`;
  } else {
    body = `
      <h2>Account</h2>
      <p class="helper-text" style="margin-bottom:14px;">You're using Cadence as a guest — your tasks are only saved on this device. Sign in with Google to back them up and see them on your other devices too.</p>
      <button class="google-btn" onclick="signInWithGoogle()">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.5 6 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.5 6 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.5-5.2l-6.2-5.2C29.3 35.4 26.8 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.3 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.6l6.2 5.2C40.9 36 44 30.5 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>
        Sign in with Google
      </button>
      <div class="modal-actions" style="margin-top:16px;">
        <button class="btn-secondary" style="flex:1;" onclick="closeModal()">Stay as guest</button>
      </div>`;
  }
  document.getElementById('modalBody').innerHTML = body;
  overlay.classList.add('open');
}
window.openAccountModal = openAccountModal;
document.getElementById('accountBtn').addEventListener('click', openAccountModal);

/* ============ Settings modal ============ */
function openSettingsModal(){
  const enabled = !!state.settings.autoDeleteCompleted;
  document.getElementById('modalBody').innerHTML = `
    <h2>Settings</h2>
    <div class="field">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:14px;">
        <div>
          <div style="font-weight:600; font-size:14px;">Auto-delete completed tasks</div>
          <div class="helper-text" style="margin-top:4px; line-height:1.5;">
            Once a completed task's day has fully passed, it's removed instead of sitting there checked off.
            For multi-step projects, this only clears the whole project once every step is done — an
            in-progress project and its progress bar are never touched. For repeating tasks, each finished
            occurrence is cleared as its day passes, but the repeating rule keeps going.
          </div>
        </div>
        <div class="switch ${enabled?'on':''}" id="autoDeleteSwitch" onclick="toggleAutoDelete()">
          <div class="switch-knob"></div>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" style="flex:1;" onclick="closeModal()">Close</button>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('open');
}
window.openSettingsModal = openSettingsModal;

async function toggleAutoDelete(){
  const next = !state.settings.autoDeleteCompleted;
  document.getElementById('autoDeleteSwitch').classList.toggle('on', next); // instant visual feedback
  await setDoc(doc(db,'settings',uid), { autoDeleteCompleted: next }, { merge: true });
}
window.toggleAutoDelete = toggleAutoDelete;

document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);


function catById(id){return state.categories.find(c=>c.id===id);}
function projectById(id){return state.projects.find(p=>p.id===id);}
function subtasksForProject(id){return state.subtasks.filter(s=>s.projectId===id);}

/* ============ Rendering ============ */
function render(){
  document.querySelectorAll('.nav-item').forEach(el=>{
    el.classList.toggle('active', el.dataset.tab===ui.tab);
  });
  const titleMap = {today:'Today', calendar:'Calendar', projects:'Projects'};
  document.getElementById('pageTitle').textContent = titleMap[ui.tab];
  document.getElementById('pageSub').textContent = ui.tab==='today' ? formatFull(todayStr()) : '';

  const isGoogle = currentUser && currentUser.providerData.some(p=>p.providerId==='google.com');
  const accountBtn = document.getElementById('accountBtn');
  accountBtn.classList.toggle('signed-in', !!isGoogle);
  accountBtn.innerHTML = isGoogle
    ? escapeHtml((currentUser.displayName||'?')[0].toUpperCase())
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;

  const content = document.getElementById('content');
  let html = notifBannerHTML();
  if(ui.tab==='today') html += renderTodayTab();
  else if(ui.tab==='calendar') html += renderCalendar();
  else html += renderProjects();
  content.innerHTML = html;

  attachContentHandlers();
}

function renderTodayTab(){
  let html = `<div class="view-toggle">
    <button class="${ui.todayView==='today'?'active':''}" onclick="setTodayView('today')">Today</button>
    <button class="${ui.todayView==='week'?'active':''}" onclick="setTodayView('week')">This Week</button>
  </div>`;
  html += ui.todayView==='today' ? renderToday() : renderWeek();
  return html;
}
window.setTodayView = (v)=>{ ui.todayView = v; render(); };

function sortTaskItems(items){
  const copy = [...items];
  if(ui.todaySort==='due') copy.sort((a,b)=> a.project.dueDate.localeCompare(b.project.dueDate));
  else if(ui.todaySort==='time') copy.sort((a,b)=> (a.reminderTime||'99:99').localeCompare(b.reminderTime||'99:99'));
  else if(ui.todaySort==='alpha') copy.sort((a,b)=> a.project.title.localeCompare(b.project.title));
  return copy;
}

function todayToolbarHTML(){
  return `<div class="toolbar-row">
    <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--text-muted);">
      <input type="checkbox" ${ui.todayGroupByCategory?'checked':''} onchange="setTodayGroup(this.checked)">
      Group by category
    </label>
    <select class="sort-select" onchange="setTodaySort(this.value)">
      <option value="due" ${ui.todaySort==='due'?'selected':''}>Sort: Project due date</option>
      <option value="time" ${ui.todaySort==='time'?'selected':''}>Sort: Reminder time</option>
      <option value="alpha" ${ui.todaySort==='alpha'?'selected':''}>Sort: Project name</option>
    </select>
  </div>`;
}
window.setTodaySort = (v)=>{ ui.todaySort=v; render(); };
window.setTodayGroup = (v)=>{ ui.todayGroupByCategory=v; render(); };
window.toggleTodayCategoryCollapse = (cid)=>{
  ui.todayCollapsedCategories[cid] = !ui.todayCollapsedCategories[cid];
  render();
};

function renderToday(){
  const t = todayStr();
  let items = [];
  state.subtasks.forEach(s=>{
    if(s.date===t){
      const project = projectById(s.projectId);
      if(project) items.push({...s, project});
    }
  });
  const dueTodayProjects = state.projects.filter(p=>p.dueDate===t && p.taskType==='staged');

  if(items.length===0 && dueTodayProjects.length===0){
    return `<div class="empty-state">
      <div class="icon">◎</div>
      <h3>Nothing on deck today</h3>
      <p>Add a project and break it into steps — they'll show up here on the days you planned to work on them.</p>
      <button class="btn-primary" style="max-width:200px;margin:0 auto;" onclick="openModal()">+ New project</button>
    </div>`;
  }

  let html = todayToolbarHTML();

  if(dueTodayProjects.length){
    html += `<div class="cat-group">`;
    dueTodayProjects.forEach(p=>{
      const cat = catById(p.categoryId);
      html += `<div class="milestone-card">
        <div class="milestone-icon">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z"/></svg>
        </div>
        <div>
          <div class="milestone-title">${escapeHtml(p.title)} is due today</div>
          <div class="milestone-sub">${cat?cat.name:''} · final deadline</div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  items = sortTaskItems(items);

  if(ui.todayGroupByCategory){
    const groups = {};
    items.forEach(it=>{
      const cid = it.project.categoryId;
      groups[cid] = groups[cid] || [];
      groups[cid].push(it);
    });
    const catOrder = (cid) => { const c = catById(cid); return c ? (c.order??0) : 999; };
    const catIds = Object.keys(groups).sort((a,b)=> catOrder(a)-catOrder(b));
    catIds.forEach(cid=>{
      const cat = catById(cid) || {name:'Other', color:'#999'};
      const collapsed = !!ui.todayCollapsedCategories[cid];
      html += `<div class="cat-group">
        <div class="cat-label" style="cursor:pointer; user-select:none;" onclick="toggleTodayCategoryCollapse('${cid}')">
          <span class="cat-dot" style="background:${cat.color}"></span>${cat.name}
          <span style="margin-left:auto; color:var(--text-faint); font-size:11px;">${collapsed?'▸':'▾'} ${groups[cid].length}</span>
        </div>`;
      if(!collapsed){
        groups[cid].forEach(it=>{ html += taskCardHTML(it); });
      }
      html += `</div>`;
    });
  } else {
    html += `<div class="cat-group">`;
    items.forEach(it=>{ html += taskCardHTML(it); });
    html += `</div>`;
  }
  return html;
}

function renderWeek(){
  const t = todayStr();
  const start = addDays(t, -parseLocal(t).getDay()); // Sunday of this week
  let html = '';
  for(let i=0;i<7;i++){
    const dStr = addDays(start, i);
    const isToday = dStr === t;
    const dayTasks = state.subtasks.filter(s=>s.date===dStr).map(s=>({...s, project: projectById(s.projectId)})).filter(s=>s.project);
    const dueHere = state.projects.filter(p=>p.dueDate===dStr && p.taskType==='staged');
    const d = parseLocal(dStr);
    html += `<div class="week-day-block">
      <div class="week-day-header ${isToday?'is-today':''}">
        <span class="wd-name">${d.toLocaleDateString('en-US',{weekday:'long'})}</span>
        <span class="wd-date">${formatDisplay(dStr)}${isToday?' · today':''}</span>
      </div>`;
    if(dayTasks.length===0 && dueHere.length===0){
      html += `<div class="week-day-empty">Nothing scheduled</div>`;
    } else {
      dueHere.forEach(p=>{
        const cat = catById(p.categoryId);
        html += `<div class="milestone-card">
          <div class="milestone-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z"/></svg></div>
          <div><div class="milestone-title">${escapeHtml(p.title)} is due</div><div class="milestone-sub">${cat?cat.name:''} · final deadline</div></div>
        </div>`;
      });
      dayTasks.sort((a,b)=>a.project.title.localeCompare(b.project.title)).forEach(t=>{ html += taskCardHTML(t); });
    }
    html += `</div>`;
  }
  return html;
}

function taskCardHTML(it){
  const overdueBadge = it.deferredCount ? `<span class="badge warn">carried over ×${it.deferredCount}</span>` : '';
  const timeBadge = it.reminderTime ? `<span class="badge">⏰ ${formatTime(it.reminderTime)}</span>` : '';
  const freqLabel = { daily:'repeats daily', weekly:'repeats weekly', monthly:'repeats monthly' };
  const projectLabel = it.project.taskType === 'staged' ? `<div class="task-project">${escapeHtml(it.project.title)}</div>` : '';
  let dueBadge = '';
  if(it.project.recurrence){
    dueBadge = `<span class="badge">${freqLabel[it.project.recurrence.freq]||'repeats'}</span>`;
  } else if(it.project.taskType === 'staged'){
    dueBadge = `<span class="badge">project due ${formatDisplay(it.project.dueDate)}</span>`;
  }
  return `<div class="task-card ${it.completed?'done':''}">
    <div class="checkbox ${it.completed?'checked':''}" onclick="toggleSubtask('${it.id}')">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>
    </div>
    <div class="task-body" onclick="openModal('${it.project.id}')" style="cursor:pointer;">
      <div class="task-title ${it.completed?'done':''}">${escapeHtml(it.title)}</div>
      ${projectLabel}
      <div class="task-meta">
        ${dueBadge}
        ${timeBadge}
        ${overdueBadge}
      </div>
    </div>
  </div>`;
}

function renderCalendar(){
  const y = ui.calYear, m = ui.calMonth;
  const first = new Date(y,m,1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(y,m+1,0).getDate();
  const daysInPrevMonth = new Date(y,m,0).getDate();
  const monthLabel = first.toLocaleDateString('en-US',{month:'long', year:'numeric'});

  const byDate = {};       // subtasks scheduled that day
  const dueByDate = {};    // projects whose FINAL due date is that day
  state.subtasks.forEach(s=>{
    const p = projectById(s.projectId);
    if(!p) return;
    byDate[s.date] = byDate[s.date] || [];
    byDate[s.date].push({...s, project:p});
  });
  state.projects.forEach(p=>{
    if(p.taskType!=='staged') return; // only multi-step projects have a "final deadline" distinct from their one task
    dueByDate[p.dueDate] = dueByDate[p.dueDate] || [];
    dueByDate[p.dueDate].push(p);
  });

  let cells = '';
  const totalCells = Math.ceil((startWeekday+daysInMonth)/7)*7;
  for(let i=0;i<totalCells;i++){
    const dayNum = i - startWeekday + 1;
    let cellDate, inMonth;
    if(dayNum<1){ cellDate = new Date(y,m-1,daysInPrevMonth+dayNum); inMonth=false; }
    else if(dayNum>daysInMonth){ cellDate = new Date(y,m+1,dayNum-daysInMonth); inMonth=false; }
    else { cellDate = new Date(y,m,dayNum); inMonth=true; }
    const dStr = toDateStr(cellDate);
    const isToday = dStr === todayStr();
    const isSelected = dStr === ui.selectedDay;
    const tasks = byDate[dStr]||[];
    const dueHere = dueByDate[dStr]||[];
    const dots = [...new Set(tasks.map(t=>t.project.categoryId))].slice(0,4)
      .map(cid=>{const c=catById(cid); return `<span style="background:${c?c.color:'#999'}"></span>`}).join('');
    const dueMarker = dueHere.length ? `<span class="cal-due-marker" title="Project due"></span>` : '';
    cells += `<div class="cal-cell ${inMonth?'in-month':'out-month'} ${isToday?'today':''} ${isSelected?'selected':''}" data-date="${dStr}">
      <div class="cal-daynum">${cellDate.getDate()}</div>
      <div class="cal-dots">${dots}${dueMarker}</div>
    </div>`;
  }

  let panel = '';
  if(ui.selectedDay){
    const tasks = byDate[ui.selectedDay]||[];
    const dueHere = dueByDate[ui.selectedDay]||[];
    panel = `<div class="day-panel">
      <h4>${formatFull(ui.selectedDay)}</h4>
      ${dueHere.map(p=>`<div class="milestone-card">
        <div class="milestone-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z"/></svg></div>
        <div><div class="milestone-title">${escapeHtml(p.title)} is due</div><div class="milestone-sub">final deadline</div></div>
      </div>`).join('')}
      ${tasks.length? tasks.map(t=>taskCardHTML(t)).join('') : (dueHere.length?'':'<div style="color:var(--text-muted); font-size:13.5px;">Nothing scheduled.</div>')}
    </div>`;
  }

  return `
    <div class="cal-header">
      <button class="cal-nav-btn" onclick="shiftMonth(-1)">‹</button>
      <div class="month-label">${monthLabel}</div>
      <button class="cal-nav-btn" onclick="shiftMonth(1)">›</button>
    </div>
    <div class="cal-grid">
      ${['S','M','T','W','T','F','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    ${panel}
  `;
}

function sortProjects(list){
  const copy = [...list];
  if(ui.projectSort==='due') copy.sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  else if(ui.projectSort==='alpha') copy.sort((a,b)=>a.title.localeCompare(b.title));
  else if(ui.projectSort==='progress'){
    const pct = (p)=>{ const s=subtasksForProject(p.id); return s.length? s.filter(x=>x.completed).length/s.length : 0; };
    copy.sort((a,b)=>pct(b)-pct(a));
  } else if(ui.projectSort==='recent'){
    const ms = (p)=> p.createdAt ? (p.createdAt.seconds||0) : 0;
    copy.sort((a,b)=> ms(b)-ms(a));
  }
  return copy;
}

function projectCardHTML(p, cat){
  const t = todayStr();
  const allSubs = subtasksForProject(p.id);
  // For recurring tasks, "progress" against every generated future occurrence would
  // always look mostly incomplete (they're not due yet) — so it's measured only
  // against occurrences that have actually come due so far.
  const relevantSubs = p.recurrence ? allSubs.filter(s=>s.date<=t) : allSubs;
  const total = relevantSubs.length;
  const done = relevantSubs.filter(s=>s.completed).length;
  const pct = total? Math.round(done/total*100) : 0;
  const isOpen = ui.expandedProjects[p.id];

  const freqLabel = { daily:'Repeats daily', weekly:'Repeats weekly', monthly:'Repeats monthly' };
  const dueBadge = p.recurrence
    ? `<span class="project-due badge">${freqLabel[p.recurrence.freq]||'Repeats'}</span>`
    : `<span class="project-due badge due-final">due ${formatDisplay(p.dueDate)}</span>`;

  // A recurring task can have many months of generated occurrences — showing all of
  // them inline isn't useful, so the expanded view is windowed to a ~4 week span.
  const visibleSubs = p.recurrence
    ? allSubs.filter(s=> s.date >= addDays(t,-7) && s.date <= addDays(t,21))
    : allSubs;

  return `<div class="project-card">
    <div class="project-card-top" onclick="toggleProjectExpand('${p.id}')">
      <div class="project-title-row">
        <span class="cat-dot" style="background:${cat?cat.color:'#999'}"></span>
        <span class="project-title">${escapeHtml(p.title)}</span>
      </div>
      ${dueBadge}
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="project-subtasks ${isOpen?'open':''}">
      ${p.recurrence ? `<div class="helper-text" style="margin-bottom:6px;">Showing the past week through the next three weeks.</div>` : ''}
      ${visibleSubs.sort((a,b)=>a.date.localeCompare(b.date)).map(s=>`
        <div class="sub-row ${s.completed?'done':''}">
          <div class="checkbox ${s.completed?'checked':''}" style="width:17px;height:17px;border-radius:5px;" onclick="event.stopPropagation(); toggleSubtask('${s.id}')">
            ${s.completed?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="4"><path d="M20 6L9 17l-5-5"/></svg>':''}
          </div>
          <span class="sub-title">${escapeHtml(s.title)}</span>
          <span class="sub-date">${formatDisplay(s.date)}${s.reminderTime?' · '+formatTime(s.reminderTime):''}</span>
        </div>
      `).join('')}
      ${p.notes? `<div style="margin-top:10px; font-size:12.5px; color:var(--text-muted);">${escapeHtml(p.notes)}</div>` : ''}
      <div style="margin-top:10px; display:flex; gap:14px;">
        <span class="add-subtask-link" onclick="event.stopPropagation(); openModal('${p.id}')">Edit</span>
        <span class="add-subtask-link" style="color:var(--danger);" onclick="event.stopPropagation(); deleteProject('${p.id}')">Delete</span>
      </div>
    </div>
  </div>`;
}

function renderProjects(){
  if(state.projects.length===0){
    return `<div class="empty-state">
      <div class="icon">◎</div>
      <h3>No projects yet</h3>
      <p>Add anything with a deadline — a midterm, a home repair, a form due at church — and break it into steps.</p>
      <button class="btn-primary" style="max-width:200px;margin:0 auto;" onclick="openModal()">+ New project</button>
    </div>`;
  }

  const sortLabel = `<div class="toolbar-row">
    <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--text-muted);">
      <input type="checkbox" ${ui.groupByCategory?'checked':''} onchange="setGroupByCategory(this.checked)">
      Group by category
    </label>
    <select class="sort-select" onchange="setProjectSort(this.value)">
      <option value="due" ${ui.projectSort==='due'?'selected':''}>Sort: Due date</option>
      <option value="alpha" ${ui.projectSort==='alpha'?'selected':''}>Sort: Alphabetical</option>
      <option value="progress" ${ui.projectSort==='progress'?'selected':''}>Sort: % complete</option>
      <option value="recent" ${ui.projectSort==='recent'?'selected':''}>Sort: Recently added</option>
    </select>
  </div>`;

  let html = sortLabel;

  if(ui.groupByCategory){
    const catOrder = [...state.categories].sort((a,b)=> (a.order??0)-(b.order??0));
    catOrder.forEach(cat=>{
      const projs = sortProjects(state.projects.filter(p=>p.categoryId===cat.id));
      if(projs.length===0) return;
      const collapsed = !!ui.collapsedProjectCategories[cat.id];
      html += `<div class="section-title" style="display:flex; align-items:center; gap:0; cursor:pointer; user-select:none;" onclick="toggleProjectCategoryCollapse('${cat.id}')">
        <span class="cat-dot" style="background:${cat.color}; display:inline-block; margin-right:6px; cursor:pointer;" onclick="event.stopPropagation(); openCategoryEditModal('${cat.id}')"></span>${escapeHtml(cat.name)}
        <span style="margin-left:auto; color:var(--text-faint); font-size:11px;">${collapsed?'▸':'▾'} ${projs.length}</span>
      </div>`;
      if(!collapsed){
        projs.forEach(p=>{ html += projectCardHTML(p, cat); });
      }
    });
  } else {
    sortProjects(state.projects).forEach(p=>{ html += projectCardHTML(p, catById(p.categoryId)); });
  }

  html += `<div class="section-title">Categories</div>
    <div class="cat-manage-row">
      ${state.categories.map(c=>`<div class="cat-chip" onclick="openCategoryEditModal('${c.id}')"><span class="cat-dot" style="background:${c.color}"></span>${escapeHtml(c.name)}</div>`).join('')}
      <span class="add-subtask-link" onclick="promptNewCategory()">+ Add category</span>
    </div>`;

  return html;
}
window.setProjectSort = (v)=>{ ui.projectSort=v; render(); };
window.setGroupByCategory = (v)=>{ ui.groupByCategory=v; render(); };
window.toggleProjectCategoryCollapse = (cid)=>{
  ui.collapsedProjectCategories[cid] = !ui.collapsedProjectCategories[cid];
  render();
};

/* ---- Category edit modal: rename, recolor, delete ---- */
let editingCategoryColor = null;
function openCategoryEditModal(catId){
  const cat = catById(catId);
  if(!cat) return;
  editingCategoryColor = cat.color;
  const inUseCount = state.projects.filter(p=>p.categoryId===catId).length;
  const sorted = [...state.categories].sort((a,b)=>(a.order??0)-(b.order??0));
  const idx = sorted.findIndex(c=>c.id===catId);
  document.getElementById('modalBody').innerHTML = `
    <h2>Edit category</h2>
    <div class="field">
      <label>Name</label>
      <input type="text" id="f-cat-name" value="${escapeHtml(cat.name)}">
    </div>
    <div class="field">
      <label>Color</label>
      <div class="color-picker" id="catColorPicker">
        ${CATEGORY_COLORS.map(c=>`<div class="color-swatch ${c===cat.color?'selected':''}" style="background:${c}" onclick="pickModalCategoryColor(this,'${c}')"></div>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Display order</label>
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn-ghost" style="${idx<=0?'opacity:.4; cursor:not-allowed;':''}" ${idx<=0?'disabled':''} onclick="moveCategoryOrder('${catId}',-1)">↑ Move up</button>
        <button type="button" class="btn-ghost" style="${idx>=sorted.length-1?'opacity:.4; cursor:not-allowed;':''}" ${idx>=sorted.length-1?'disabled':''} onclick="moveCategoryOrder('${catId}',1)">↓ Move down</button>
      </div>
      <div class="helper-text">This controls the order categories appear in on the Today and Projects tabs.</div>
    </div>
    ${inUseCount>0
      ? `<p class="helper-text">Used by ${inUseCount} project${inUseCount>1?'s':''}. Move or delete ${inUseCount>1?'them':'it'} before this category can be deleted.</p>`
      : ''}
    <div class="modal-actions">
      <button class="btn-secondary" style="${inUseCount>0?'color:var(--text-faint); cursor:not-allowed;':'color:var(--danger);'}" ${inUseCount>0?'disabled':''} onclick="deleteCategory('${catId}')">Delete</button>
      <button class="btn-primary" onclick="saveCategoryEdit('${catId}')">Save</button>
    </div>
  `;
  document.getElementById('modalOverlay').classList.add('open');
}
window.openCategoryEditModal = openCategoryEditModal;

async function moveCategoryOrder(catId, direction){
  const sorted = [...state.categories].sort((a,b)=>(a.order??0)-(b.order??0));
  const idx = sorted.findIndex(c=>c.id===catId);
  const swapIdx = idx + direction;
  if(swapIdx < 0 || swapIdx >= sorted.length) return;
  const a = sorted[idx], b = sorted[swapIdx];
  const aOrder = a.order ?? idx, bOrder = b.order ?? swapIdx;
  await Promise.all([
    updateDoc(doc(db,'categories',a.id), { order: bOrder }),
    updateDoc(doc(db,'categories',b.id), { order: aOrder })
  ]);
  openCategoryEditModal(catId); // refresh the modal with the new position
}
window.moveCategoryOrder = moveCategoryOrder;

function pickModalCategoryColor(el, color){
  editingCategoryColor = color;
  el.parentElement.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
  el.classList.add('selected');
}
window.pickModalCategoryColor = pickModalCategoryColor;

async function saveCategoryEdit(catId){
  const name = document.getElementById('f-cat-name').value.trim();
  if(!name){ alert('Give the category a name.'); return; }
  await updateDoc(doc(db,'categories',catId), { name, color: editingCategoryColor });
  closeModal();
}
window.saveCategoryEdit = saveCategoryEdit;

async function deleteCategory(catId){
  if(state.projects.some(p=>p.categoryId===catId)) return; // guarded in UI too
  if(!confirm('Delete this category? This can\'t be undone.')) return;
  await deleteDoc(doc(db,'categories',catId));
  closeModal();
}
window.deleteCategory = deleteCategory;

/* ============ Interaction handlers ============ */
function attachContentHandlers(){
  document.querySelectorAll('.cal-cell').forEach(cell=>{
    cell.addEventListener('click', ()=>{ ui.selectedDay = cell.dataset.date; render(); });
  });
}

async function toggleSubtask(subtaskId){
  const s = state.subtasks.find(x=>x.id===subtaskId);
  const completed = !s.completed;
  await updateDoc(doc(db, 'subtasks', subtaskId), {
    completed, completedAt: completed ? todayStr() : null
  });
}
window.toggleSubtask = toggleSubtask;

function toggleProjectExpand(id){ ui.expandedProjects[id] = !ui.expandedProjects[id]; render(); }
window.toggleProjectExpand = toggleProjectExpand;

async function deleteProject(id){
  if(!confirm('Delete this project and all its steps?')) return;
  const batch = writeBatch(db);
  subtasksForProject(id).forEach(s => batch.delete(doc(db,'subtasks',s.id)));
  batch.delete(doc(db,'projects',id));
  await batch.commit();
}
window.deleteProject = deleteProject;

function shiftMonth(delta){
  ui.calMonth += delta;
  if(ui.calMonth<0){ui.calMonth=11; ui.calYear--;}
  if(ui.calMonth>11){ui.calMonth=0; ui.calYear++;}
  render();
}
window.shiftMonth = shiftMonth;

async function promptNewCategory(){
  const name = prompt('Category name:');
  if(!name) return;
  const color = CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length];
  const maxOrder = state.categories.reduce((m,c)=>Math.max(m, c.order??0), -1);
  await addDoc(collection(db,'categories'), {name, color, uid, order: maxOrder+1});
}
window.promptNewCategory = promptNewCategory;

/* ============ Tab navigation ============ */
document.querySelectorAll('.nav-item').forEach(el=>{
  el.addEventListener('click', ()=>{ ui.tab = el.dataset.tab; ui.selectedDay = null; render(); });
});

/* ============ Modal: add/edit project ============ */
// modalSubtasks lives on window because the modal's inline `oninput` handlers
// execute in global scope and can't see this module's local variables.
let editingProjectId = null;
window.modalSubtasks = [];
function getModalSubtasks(){ return window.modalSubtasks; }
function setModalSubtasks(arr){ window.modalSubtasks = arr; }

let modalTaskType = 'staged';

function openModal(projectId){
  editingProjectId = projectId || null;
  const overlay = document.getElementById('modalOverlay');
  const p = projectId ? projectById(projectId) : null;
  setModalSubtasks(p ? JSON.parse(JSON.stringify(subtasksForProject(p.id))) : []);
  modalTaskType = p ? (p.taskType || 'staged') : 'staged';
  renderProjectModalBody(p);
  overlay.classList.add('open');
}
window.openModal = openModal;

function setModalTaskType(type){
  modalTaskType = type;
  const p = editingProjectId ? projectById(editingProjectId) : null;
  renderProjectModalBody(p, true);
}
window.setModalTaskType = setModalTaskType;

function renderProjectModalBody(p, preserveInputs){
  // Preserve whatever's already typed when switching task type mid-creation.
  const prevTitle = preserveInputs ? (document.getElementById('f-title')?.value ?? (p?p.title:'')) : (p?p.title:'');
  const prevCategory = preserveInputs ? document.getElementById('f-category')?.value : (p?p.categoryId:'');
  const prevDue = preserveInputs ? (document.getElementById('f-due')?.value ?? (p?p.dueDate:'')) : (p?p.dueDate:'');
  const prevNotes = preserveInputs ? (document.getElementById('f-notes')?.value ?? (p?p.notes:'')) : (p&&p.notes?p.notes:'');

  const catOptions = state.categories.map(c=>`<option value="${c.id}" ${prevCategory===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')
    + `<option value="__new__">+ Add new category…</option>`;

  let typeFields = '';
  if(modalTaskType === 'single'){
    const rt = p && p.taskType==='single' ? (subtasksForProject(p.id)[0]?.reminderTime||'') : '';
    typeFields = `
      <div class="row-2">
        <div class="field">
          <label>Due date</label>
          <input type="date" id="f-due" value="${prevDue}">
        </div>
        <div class="field">
          <label>Remind me at (optional)</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="time" id="f-single-time" value="${rt}" style="flex:1;">
            <span class="add-subtask-link" style="white-space:nowrap;" onclick="document.getElementById('f-single-time').value=''">Clear</span>
          </div>
        </div>
      </div>
      <p class="helper-text">A single task with no separate steps — it'll show up on your list on its due date.</p>`;
  } else if(modalTaskType === 'staged'){
    typeFields = `
      <div class="row-2">
        <div class="field">
          <label>Due date</label>
          <input type="date" id="f-due" value="${prevDue}">
        </div>
        <div class="field">
          <label>Start working this many days before it's due</label>
          <input type="number" id="f-startdays" min="0" value="${p? dayDiff(p.startDate||p.dueDate,p.dueDate) : 7}">
        </div>
      </div>
      <div class="field">
        <label>Steps</label>
        <div id="subtaskList"></div>
        <div style="display:flex; gap:14px; margin-top:6px;">
          <span class="add-subtask-link" onclick="addModalSubtask()">+ Add step</span>
          <span class="add-subtask-link" onclick="autoGenSubtasks()">✦ Auto-space steps</span>
        </div>
      </div>`;
  } else if(modalTaskType === 'recurring'){
    const rec = p && p.recurrence ? p.recurrence : { freq:'weekly', endDate:'' };
    const anchorWeekday = prevDue ? parseLocal(prevDue).getDay() : new Date().getDay();
    const initialDays = (rec.daysOfWeek && rec.daysOfWeek.length) ? rec.daysOfWeek : [anchorWeekday];
    window.modalSelectedDays = [...initialDays];
    const dayAbbrev = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    typeFields = `
      <div class="row-2">
        <div class="field">
          <label>First occurrence</label>
          <input type="date" id="f-due" value="${prevDue}">
        </div>
        <div class="field">
          <label>Repeats</label>
          <select id="f-rec-freq" onchange="document.getElementById('recDaysField').style.display = this.value==='weekly' ? 'block' : 'none'">
            <option value="daily" ${rec.freq==='daily'?'selected':''}>Daily</option>
            <option value="weekly" ${rec.freq==='weekly'?'selected':''}>Weekly</option>
            <option value="monthly" ${rec.freq==='monthly'?'selected':''}>Monthly (same date)</option>
          </select>
        </div>
      </div>
      <div class="field" id="recDaysField" style="display:${rec.freq==='weekly'?'block':'none'}">
        <label>On which days</label>
        <div class="day-picker">
          ${[0,1,2,3,4,5,6].map(d=>`<button type="button" class="day-pill ${initialDays.includes(d)?'active':''}" onclick="toggleModalDay(${d}, this)">${dayAbbrev[d]}</button>`).join('')}
        </div>
      </div>
      <div class="row-2">
        <div class="field">
          <label>Ends on (optional)</label>
          <input type="date" id="f-rec-end" value="${rec.endDate||''}">
        </div>
        <div class="field">
          <label>Remind me at (optional)</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="time" id="f-rec-time" value="${rec.reminderTime||''}" style="flex:1;">
            <span class="add-subtask-link" style="white-space:nowrap;" onclick="document.getElementById('f-rec-time').value=''">Clear</span>
          </div>
        </div>
      </div>
      <p class="helper-text">Leave "Ends on" blank to repeat indefinitely. We generate the next few months of occurrences at a time and keep extending automatically as they pass.${p?' Editing only changes today\'s and future occurrences — anything already past or completed stays untouched.':''}</p>`;
  }

  document.getElementById('modalBody').innerHTML = `
    <h2>${p? 'Edit task' : 'New task'}</h2>
    <div class="view-toggle modal-toggle" style="margin-bottom:16px;">
      <button type="button" class="${modalTaskType==='single'?'active':''}" onclick="setModalTaskType('single')">Single task</button>
      <button type="button" class="${modalTaskType==='staged'?'active':''}" onclick="setModalTaskType('staged')">Multi-step</button>
      <button type="button" class="${modalTaskType==='recurring'?'active':''}" onclick="setModalTaskType('recurring')">Repeating</button>
    </div>
    <div class="field">
      <label>Title</label>
      <input type="text" id="f-title" placeholder="e.g. Data Structures Midterm" value="${escapeHtml(prevTitle||'')}">
    </div>
    <div class="field">
      <label>Category</label>
      <select id="f-category" onchange="handleCategorySelectChange(this)">${catOptions}</select>
    </div>
    ${typeFields}
    <div class="field">
      <label>Notes (optional)</label>
      <textarea id="f-notes" placeholder="Anything else worth remembering">${escapeHtml(prevNotes||'')}</textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveProject()">${p?'Save changes':'Create task'}</button>
    </div>
  `;
  if(modalTaskType==='staged') renderModalSubtasks();
}

async function handleCategorySelectChange(sel){
  if(sel.value !== '__new__') return;
  const name = prompt('Category name:');
  if(!name){
    sel.value = state.categories[0] ? state.categories[0].id : '';
    return;
  }
  const color = CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length];
  const maxOrder = state.categories.reduce((m,c)=>Math.max(m, c.order??0), -1);
  const ref = await addDoc(collection(db,'categories'), {name, color, uid, order: maxOrder+1});
  const opt = document.createElement('option');
  opt.value = ref.id; opt.textContent = name;
  sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
  sel.value = ref.id;
}
window.handleCategorySelectChange = handleCategorySelectChange;

function renderModalSubtasks(){
  const el = document.getElementById('subtaskList');
  const subs = getModalSubtasks();
  if(subs.length===0){
    el.innerHTML = `<div class="helper-text" style="margin-bottom:6px;">No steps yet — add one, or auto-space them below.</div>`;
    return;
  }
  el.innerHTML = subs.map((s,i)=>`
    <div class="subtask-row">
      <input type="text" value="${escapeHtml(s.title)}" placeholder="Step description" oninput="modalSubtasks[${i}].title=this.value">
      <input type="date" value="${s.date}" oninput="modalSubtasks[${i}].date=this.value">
      <input type="time" id="sub-time-${i}" value="${s.reminderTime||''}" oninput="modalSubtasks[${i}].reminderTime=this.value" title="Remind me at (leave blank for no reminder)">
      <span class="add-subtask-link" style="font-size:11px; white-space:nowrap;" onclick="modalSubtasks[${i}].reminderTime=''; document.getElementById('sub-time-${i}').value='';">Clear</span>
      <button class="icon-btn" onclick="removeModalSubtask(${i})" title="Remove this step">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `).join('');
}

function addModalSubtask(){
  getModalSubtasks().push({id:'new-'+Math.random(), title:'', date: todayStr(), completed:false, deferredCount:0, reminderTime:''});
  renderModalSubtasks();
}
window.addModalSubtask = addModalSubtask;

function toggleModalDay(d, el){
  window.modalSelectedDays = window.modalSelectedDays || [];
  const i = window.modalSelectedDays.indexOf(d);
  if(i>=0) window.modalSelectedDays.splice(i,1); else window.modalSelectedDays.push(d);
  el.classList.toggle('active');
}
window.toggleModalDay = toggleModalDay;

function removeModalSubtask(i){ getModalSubtasks().splice(i,1); renderModalSubtasks(); }
window.removeModalSubtask = removeModalSubtask;

function autoGenSubtasks(){
  const due = document.getElementById('f-due').value;
  const startDays = parseInt(document.getElementById('f-startdays').value || '0');
  if(!due){ alert('Set a due date first.'); return; }
  const start = addDays(due, -startDays);
  const countStr = prompt('How many steps should we space between '+formatDisplay(start)+' and '+formatDisplay(due)+'?','4');
  const count = parseInt(countStr);
  if(!count || count<1) return;
  const span = Math.max(dayDiff(start,due),0);
  const newSubs = [];
  for(let i=0;i<count;i++){
    const offset = count===1 ? 0 : Math.round(span * i/(count-1));
    newSubs.push({id:'new-'+Math.random(), title:`Step ${i+1}`, date: addDays(start, offset), completed:false, deferredCount:0, reminderTime:''});
  }
  setModalSubtasks(newSubs);
  renderModalSubtasks();
}
window.autoGenSubtasks = autoGenSubtasks;

async function saveProject(){
  const title = document.getElementById('f-title').value.trim();
  const categoryId = document.getElementById('f-category').value;
  const dueDate = document.getElementById('f-due').value;
  const notes = document.getElementById('f-notes').value.trim();

  if(!title){ alert('Give the task a title.'); return; }
  if(!dueDate){ alert('Set a date.'); return; }
  if(!categoryId){ alert('Choose or add a category first.'); return; }

  let projectFields, newSubs;

  if(modalTaskType === 'single'){
    const reminderTime = document.getElementById('f-single-time').value || '';
    projectFields = { title, categoryId, dueDate, startDate: dueDate, notes, taskType:'single', recurrence:null };
    newSubs = [{ title, date: dueDate, reminderTime, completed:false, deferredCount:0 }];
  } else if(modalTaskType === 'recurring'){
    const freq = document.getElementById('f-rec-freq').value;
    const endDate = document.getElementById('f-rec-end').value || null;
    const reminderTime = document.getElementById('f-rec-time').value || '';
    const daysOfWeek = freq==='weekly' ? [...(window.modalSelectedDays||[])].sort() : null;
    if(freq==='weekly' && (!daysOfWeek || daysOfWeek.length===0)){ alert('Pick at least one day of the week.'); return; }
    const recurrence = { freq, endDate, reminderTime, daysOfWeek };
    projectFields = { title, categoryId, dueDate, startDate: dueDate, notes, taskType:'recurring', recurrence };
    const dates = generateOccurrenceDates(dueDate, recurrence, 90);
    newSubs = dates.map(d => ({ title, date: d, reminderTime, completed:false, deferredCount:0 }));
  } else {
    const startDays = parseInt(document.getElementById('f-startdays').value || '0');
    const startDate = addDays(dueDate, -startDays);
    projectFields = { title, categoryId, dueDate, startDate, notes, taskType:'staged', recurrence:null };
    newSubs = getModalSubtasks().filter(s=>s.title.trim().length>0)
      .map(s => ({ title: s.title, date: s.date, reminderTime: s.reminderTime||'', completed: !!s.completed, deferredCount: s.deferredCount||0 }));
  }

  let projectId = editingProjectId;
  if(editingProjectId){
    await updateDoc(doc(db,'projects',editingProjectId), projectFields);
    if(modalTaskType === 'recurring'){
      // Preserve history: only clear today-and-future occurrences, then regenerate.
      const t = todayStr();
      const batchDel = writeBatch(db);
      subtasksForProject(editingProjectId).filter(s=>s.date>=t).forEach(s => batchDel.delete(doc(db,'subtasks',s.id)));
      await batchDel.commit();
      newSubs = newSubs.filter(s=>s.date>=t);
    } else {
      // Single/staged: small, fully user-edited lists — simplest correct approach is replace-all.
      const batchDel = writeBatch(db);
      subtasksForProject(editingProjectId).forEach(s => batchDel.delete(doc(db,'subtasks',s.id)));
      await batchDel.commit();
    }
  } else {
    const ref = await addDoc(collection(db,'projects'), { ...projectFields, uid, createdAt: serverTimestamp() });
    projectId = ref.id;
  }

  const batch2 = writeBatch(db);
  newSubs.forEach(s=>{
    const ref = doc(collection(db,'subtasks'));
    batch2.set(ref, { projectId, uid, ...s });
  });
  await batch2.commit();

  closeModal();
}
window.saveProject = saveProject;

// Keeps recurring tasks populated on the calendar as time passes, without needing
// a backend job — runs client-side whenever projects/subtasks refresh, and is a
// no-op once a project's generated occurrences already reach far enough ahead.
// Auto-deletes completed tasks once their day has fully passed, IF the user has
// opted in via Settings. Deliberately asymmetric by task type:
//  - single: the whole project is deleted (it only ever existed for that one task).
//  - recurring: each finished occurrence is deleted individually; the recurrence
//    rule and project keep going indefinitely.
//  - staged (multi-step): individual completed STEPS are never deleted mid-project —
//    doing so would make the progress bar look like nothing had been done. Instead
//    the whole project is deleted only once every one of its steps is completed
//    and past, i.e. once it's genuinely finished.
async function cleanupCompleted(){
  if(!state.settings.autoDeleteCompleted) return;
  const t = todayStr();
  const batch = writeBatch(db);
  let count = 0;
  const CAP = 400; // Firestore batches max at 500 writes; this is safely under that,
                    // and since cleanup runs on every snapshot, any backlog beyond
                    // the cap just gets picked up on the next pass.

  outer:
  for(const s of state.subtasks){
    if(!s.completed || s.date >= t) continue;
    const p = projectById(s.projectId);
    if(p && p.recurrence){
      batch.delete(doc(db,'subtasks',s.id));
      count++;
      if(count>=CAP) break outer;
    }
  }

  if(count<CAP){
    for(const p of state.projects){
      if(p.recurrence) continue;
      const subs = state.subtasks.filter(s=>s.projectId===p.id);
      if(subs.length===0) continue;
      const allDoneAndPast = subs.every(s=>s.completed && s.date < t);
      if(allDoneAndPast){
        subs.forEach(s=>batch.delete(doc(db,'subtasks',s.id)));
        batch.delete(doc(db,'projects',p.id));
        count += subs.length + 1;
        if(count>=CAP) break;
      }
    }
  }

  if(count>0) await batch.commit();
}

let extendInFlight = false;
async function extendRecurringProjects(){
  if(extendInFlight) return; // defense in depth against any future double-invocation
  extendInFlight = true;
  try{
    const recurringProjects = state.projects.filter(p=>p.recurrence);
    for(const p of recurringProjects){
      const occ = state.subtasks.filter(s=>s.projectId===p.id);
      const maxDate = occ.length ? occ.reduce((a,b)=> a.date>b.date?a:b).date : p.dueDate;
      const horizon = addDays(todayStr(), 90);
      const cutoff = p.recurrence.endDate ? (p.recurrence.endDate < horizon ? p.recurrence.endDate : horizon) : horizon;
      if(maxDate >= cutoff) continue;
      if(p.recurrence.endDate && maxDate >= p.recurrence.endDate) continue;

      const newDates = generateOccurrenceDatesAfter(maxDate, p.recurrence, cutoff);
      if(newDates.length === 0) continue;
      const batch = writeBatch(db);
      newDates.forEach(d=>{
        const ref = doc(collection(db,'subtasks'));
        batch.set(ref, {
          projectId: p.id, uid, title: p.title, date: d,
          completed:false, deferredCount:0, reminderTime: p.recurrence.reminderTime||''
        });
      });
      await batch.commit();
    }
  } finally {
    extendInFlight = false;
  }
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('open');
  editingProjectId = null;
  editingCategoryColor = null;
  setModalSubtasks([]);
}
window.closeModal = closeModal;
document.getElementById('modalOverlay').addEventListener('click', (e)=>{
  if(e.target.id==='modalOverlay') closeModal();
});
document.getElementById('fabMobile').addEventListener('click', ()=>openModal());
document.getElementById('fabDesktop').addEventListener('click', ()=>openModal());

/* ============ ICS export (still useful as a backup/complement to push) ============ */
function icsEscape(s){ return String(s).replace(/[,;]/g,'\\$&').replace(/\n/g,'\\n'); }
function dateToIcsDate(dateStr){ return dateStr.replace(/-/g,''); }

document.getElementById('exportIcsBtn').addEventListener('click', ()=>{
  let events = [];
  const now = new Date().toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
  state.projects.forEach(p=>{
    const cat = catById(p.categoryId);
    events.push(`BEGIN:VEVENT
UID:${p.id}-due@cadence
DTSTAMP:${now}
DTSTART;VALUE=DATE:${dateToIcsDate(p.dueDate)}
SUMMARY:${icsEscape('DUE: '+p.title)}
DESCRIPTION:${icsEscape((cat?cat.name+' — ':'')+'Final due date'+(p.notes?'\\n\\n'+p.notes:''))}
END:VEVENT`);
    subtasksForProject(p.id).forEach(s=>{
      const dtLine = s.reminderTime
        ? `DTSTART:${dateToIcsDate(s.date)}T${s.reminderTime.replace(':','')}00`
        : `DTSTART;VALUE=DATE:${dateToIcsDate(s.date)}`;
      events.push(`BEGIN:VEVENT
UID:${s.id}@cadence
DTSTAMP:${now}
${dtLine}
SUMMARY:${icsEscape(s.title+' ('+p.title+')')}
DESCRIPTION:${icsEscape((cat?cat.name:'')+' — step toward: '+p.title)}
END:VEVENT`);
    });
  });
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Cadence//Planner//EN
CALSCALE:GREGORIAN
${events.join('\n')}
END:VCALENDAR`;
  const blob = new Blob([ics], {type:'text/calendar'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'cadence-schedule.ics';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});