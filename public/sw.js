// Service worker du panel des agents : app installable et notifications push des agents (lib/push.js), même panel
// fermé. Pas de cache : le panel est toujours servi à jour par le serveur.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Agents IA", { body: d.body || "", tag: d.tag, data: { url: d.url || "/" }, icon: "/icon-192.png", badge: "/icon-192.png" }));
});

// Toucher la notification : ouvre le panel à la bonne page (fenêtre déjà ouverte réutilisée).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
