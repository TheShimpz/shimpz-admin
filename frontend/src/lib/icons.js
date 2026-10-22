// The one stroke icon set of Admin (ADR-0086): 24-unit paths, drawn at one stroke weight, and the circles some icons
// add. routines/Icon.svelte draws them by name; any other icon that shows the same mark reads its data here.
export const PATHS = {
  clock: ['M12 7v5l3 2'],
  pause: ['M9 6v12', 'M15 6v12'],
  warning: ['M12 4 3 20h18Z', 'M12 10v4', 'M12 17h.01'],
  check: ['M20 6 9 17l-5-5'],
  failed: ['m15 9-6 6', 'm9 9 6 6'],
  skip: ['M5 5v14l10-7Z', 'M19 5v14'],
  terminal: ['M4 5h16v14H4Z', 'm8 10 2 2-2 2', 'M13 14h3'],
  chevron: ['m9 6 6 6-6 6'],
  back: ['m15 6-6 6 6 6'],
  play: ['M7 5v14l11-7Z'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  stop: ['M7 7h10v10H7Z'],
  approval: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z', 'm9 12 2 2 4-4'],
  lock: ['M5 11h14v10H5Z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  step: ['M5 12h14', 'm13 6 6 6-6 6'],
  spinner: ['M12 3a9 9 0 1 0 9 9'],
  edit: ['M4 20h4L19 9l-4-4L4 16Z', 'm13 7 4 4'],
};

// Icons drawn with a circle as well as paths.
export const CIRCLES = { clock: [12, 12, 9], failed: [12, 12, 9] };
