// Inline stroke icons. Each returns an <svg> string that inherits currentColor.
const wrap = (body: string, box = 16) =>
  `<svg viewBox="0 0 ${box} ${box}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  plus: wrap('<path d="M8 3v10M3 8h10"/>'),
  fork: wrap('<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 5.1v5.8M4 11c0-3 8-1.5 8-3.4"/>'),
  stop: `<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>`,
  copy: wrap('<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10V3h7"/>'),
  attach: wrap('<path d="M10.5 5.5L6 10a1.5 1.5 0 002.1 2.1l5-5a3 3 0 00-4.2-4.2L3.4 8.4a4.5 4.5 0 006.4 6.4"/>'),
  send: wrap('<path d="M8 13V3M4 7l4-4 4 4"/>'),
  chevron: wrap('<path d="M3 4.5l3 3 3-3"/>', 12),
  check: wrap('<path d="M2.5 6.5l2.3 2.3L9.5 3.8"/>', 12),
  clock: wrap('<circle cx="6" cy="6" r="5"/><path d="M6 3.2v3.2l2 1.2"/>', 12),
  cross: wrap('<path d="M3 3l6 6M9 3l-6 6"/>', 12),
  spawn: wrap('<circle cx="3" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="5" r="1.4"/><path d="M3 4.4v3.2M3 8c0-2 6-1 6-2.6"/>', 12),
  eye: wrap('<path d="M1.5 6s1.8-3 4.5-3 4.5 3 4.5 3-1.8 3-4.5 3S1.5 6 1.5 6z"/><circle cx="6" cy="6" r="1.4"/>', 12),
  pencil: wrap('<path d="M8.5 1.5l2 2L4 10H2V8z"/>', 12),
  terminal: wrap('<path d="M2 3l3 3-3 3M6.5 9H10"/>', 12),
  coffee: wrap('<path d="M3 6h8v3.5A3.5 3.5 0 017.5 13h-1A3.5 3.5 0 013 9.5z"/><path d="M11 7h.8a1.7 1.7 0 010 3.4H11M6 2.5v1.5M8.5 2.5v1.5"/>'),
  moon: wrap('<path d="M13 9.6A5.5 5.5 0 116.4 3a4.4 4.4 0 006.6 6.6z"/>'),
  claude: wrap('<path d="M6 1.2v9.6M1.2 6h9.6M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/>', 12),
  codex: wrap('<path d="M6 1.2l4.2 2.4v4.8L6 10.8 1.8 8.4V3.6z"/>', 12),
  worktree: wrap('<circle cx="4.5" cy="3" r="1.5"/><circle cx="4.5" cy="13" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 4.5v7M4.5 4.5c0 2.2 7 1.3 7 2M11.5 9.5c0 .7-7-.2-7 2"/>'),
  globe: wrap('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2.2 2.2-2.2 8.8 0 11M8 2.5c2.2 2.2 2.2 8.8 0 11"/>'),
  calendar: wrap('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>'),
  phone: wrap('<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12h2"/>'),
  opinion: wrap('<path d="M2.5 3h11v7.5H8L5 13v-2.5H2.5z"/><path d="M5.5 6.8l1.7 1.7 3.3-3.3"/>'),
  browserAgent: wrap('<rect x="1.5" y="2.5" width="13" height="10.5" rx="1.5"/><path d="M1.5 5.5h13M7 7.5l1.3 4.3.9-1.7 1.9 1.9.8-.8-1.9-1.9 1.7-.9z"/>'),
  bug: wrap('<path d="M6 4.3a2 2 0 014 0"/><rect x="4.5" y="4.3" width="7" height="9.2" rx="3.5"/><path d="M8 7v6.5M4.5 8.5H2M11.5 8.5H14M4.6 11.5l-2 1.2M11.4 11.5l2 1.2M4.8 6l-1.8-1.3M11.2 6l1.8-1.3"/>'),
  timer: wrap('<circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.6 1.2M6.5 2h3"/>'),
};
