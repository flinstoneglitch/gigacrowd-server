// Shared config for both the phone client and the broadcast overlay.
//
// When these pages are served live from the production site, this is just
// the page's own origin. When they're bundled inside the native iOS app
// (Capacitor loads them from a local capacitor:// origin, not this one),
// the Socket.IO client needs an explicit absolute URL to reach the real
// backend — so both cases pass this same constant to io(...) rather than
// relying on same-origin defaults.
window.GIGACROWD_SERVER_URL = 'https://gigacrowd-server-production.up.railway.app';
