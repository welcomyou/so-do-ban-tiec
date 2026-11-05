// Router + service worker + install prompt
let viewerInited = false;
let adminInited = false;

function route() {
  const isAdmin = location.hash.startsWith('#/admin');
  document.getElementById('view-viewer').hidden = isAdmin;
  document.getElementById('view-admin').hidden = !isAdmin;
  if (isAdmin) {
    import('./editor.js').then(async (m) => {
      if (!adminInited) { adminInited = true; await m.initAdmin(); }
      m.adminRoute();
    });
  } else if (!viewerInited) {
    viewerInited = true;
    import('./viewer.js').then((m) => m.initViewer());
  }
}

window.addEventListener('hashchange', route);
route();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__installPrompt = e;
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
