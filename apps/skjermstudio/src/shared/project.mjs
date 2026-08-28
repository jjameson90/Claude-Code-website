// Prosjektfilen (project.json) beskriver all redigering. Den peker på
// originalopptakene, som aldri endres eller overskrives.

export const PROJECT_VERSION = 1;

export function createProject({ name, dir, screenFile, cameraFile = null, duration = 0, cameraOffset = 0, width = 1920, height = 1080, cameraStart = null }) {
  return {
    version: PROJECT_VERSION,
    name,
    createdAt: new Date().toISOString(),
    dir,
    source: {
      screen: screenFile,
      camera: cameraFile,
      duration,
      width,
      height,
      // Positivt tall = kameraopptaket startet så mange sekunder etter skjermen.
      cameraOffset,
    },
    edit: {
      cuts: [],
      crop: null, // { x, y, w, h } normalisert 0-1
      cameraKeyframes: cameraFile
        ? [{ t: 0, mode: 'bubble', ...(cameraStart || { x: 0.85, y: 0.8, size: 0.28 }) }]
        : [],
      cameraTransition: 0.6,
      overlays: [], // bilder, tekst, piler, markeringer
    },
    export: { fps: 30, crf: 20, preset: 'medium', audioBitrate: '192k' },
  };
}

export function normalizeProject(raw) {
  const p = { ...raw };
  p.version = PROJECT_VERSION;
  p.edit = { cuts: [], crop: null, cameraKeyframes: [], cameraTransition: 0.6, overlays: [], ...(raw.edit || {}) };
  p.export = { fps: 30, crf: 20, preset: 'medium', audioBitrate: '192k', ...(raw.export || {}) };
  p.source = { duration: 0, cameraOffset: 0, width: 1920, height: 1080, ...(raw.source || {}) };
  return p;
}
