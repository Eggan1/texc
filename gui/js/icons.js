/* texc icon set: 24x24 line icons, 1.6px stroke, currentColor. */
(function () {
  "use strict";
  const T = (window.T = window.T || {});
  const P = (d) => `<path d="${d}"/>`;
  const FILE = P("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z") + P("M14 3v5h5");
  const dot = (x, y, r = 1.3) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;

  const ICONS = {
    menu: P("M4 6h16M4 12h16M4 18h16"),
    compose: P("M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6") + P("M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"),
    chat: P("M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z"),
    file: FILE,
    "file-tex": FILE + P("M9 13h6M9 17h4"),
    "file-bib": FILE + P("M9 12h6M9 15h6M9 18h3"),
    "file-image": FILE + P("M8 18l3-3 2 2 3-3") + `<circle cx="10" cy="12.5" r="1.2"/>`,
    folder: P("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"),
    "folder-open": P("M3 17V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1") + P("M3 19l2.6-7.2A1.2 1.2 0 0 1 6.7 11H21l-2.6 7.2a1.2 1.2 0 0 1-1.1.8H3z"),
    "chevron-right": P("M9 6l6 6-6 6"),
    "chevron-down": P("M6 9l6 6 6-6"),
    "chevron-up": P("M6 15l6-6 6 6"),
    grid: P("M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z"),
    alert: `<circle cx="12" cy="12" r="9"/>` + P("M12 7.5v5.5") + dot(12, 16.3, 1.1),
    refresh: P("M20 11a8 8 0 0 0-14.9-3.5L4 9") + P("M4 4v5h5") + P("M4 13a8 8 0 0 0 14.9 3.5L20 15") + P("M20 20v-5h-5"),
    download: P("M12 4v11") + P("M7 10l5 5 5-5") + P("M5 20h14"),
    more: dot(5.5, 12) + dot(12, 12) + dot(18.5, 12),
    image: `<rect x="3" y="4" width="18" height="16" rx="2"/>` + `<circle cx="9" cy="10" r="1.6"/>` + P("M21 16l-5-5-9 9"),
    wave: P("M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"),
    send: P("M21 3L10 14") + P("M21 3l-7 18-4-7-7-4z"),
    stop: `<circle cx="12" cy="12" r="9"/>` + `<rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/>`,
    "file-plus": FILE + P("M12 11v6M9 14h6"),
    upload: P("M12 16V5") + P("M7 10l5-5 5 5") + P("M5 20h14"),
    doc: FILE + P("M9 12.5h6M9 16.5h6"),
    code: P("M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"),
    history: P("M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5") + P("M3.5 3.5v5h5") + P("M12 7.5V12l3 2"),
    dock: `<rect x="3" y="4" width="18" height="16" rx="2"/>` + P("M15 4v16"),
    collapse: P("M6 9l6 6 6-6"),
    expand: P("M6 15l6-6 6 6"),
    close: P("M6 6l12 12M18 6L6 18"),
    search: `<circle cx="11" cy="11" r="7"/>` + P("M20 20l-4-4"),
    check: P("M5 12.5l4.5 4.5L19 7.5"),
    copy: `<rect x="9" y="9" width="11" height="11" rx="2"/>` + P("M5 15V6a2 2 0 0 1 2-2h8"),
    settings: P("M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1") + `<circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>`,
    book: P("M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z") + P("M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"),
    spell: P("M3.5 17l4-10 4 10M5 13.5h5") + P("M13.5 15l2.5 2.5 5-5.5"),
    count: P("M5 9h14M5 15h14M10.5 4l-2 16M15.5 4l-2 16"),
    wand: P("M4 20L15 9") + P("M17 3v3M15.5 4.5h3") + P("M20 9v2M19 10h2") + P("M11 3.5v1.5M10.25 4.25h1.5"),
    trash: P("M4 7h16") + P("M10 11v6M14 11v6") + P("M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12") + P("M9 7V4h6v3"),
    edit: P("M4 20h4L19 9l-4-4L4 16z") + P("M13.5 6.5l4 4"),
    star: P("M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"),
    external: P("M14 4h6v6") + P("M20 4l-9 9") + P("M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"),
    plus: P("M12 5v14M5 12h14"),
  };

  T.icon = function (name, size) {
    const s = size || 16;
    const body = ICONS[name] || ICONS.file;
    return `<svg class="ic ic-${name}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };
  T.icon.names = Object.keys(ICONS);
})();
