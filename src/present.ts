/**
 * Pure helpers for the presentation player: turn ordinary share links into
 * embeddable URLs and classify uploaded files. No DOM, so they're unit tested.
 */

export type MediaKind = 'embed' | 'pdf' | 'image' | 'video' | 'poll';

export type Presentation = {
  id: string;
  name: string;
  kind: MediaKind;
  /** For links: the embeddable URL. For files: empty (the blob lives in IndexedDB). */
  src: string;
  /** For links: what the user pasted, for "open original". */
  original?: string;
  /** Short label of the provider/file type, e.g. "Google Slides", "PDF". */
  source: string;
  /** For live polls: the join code and the presenter's secret key (kept only in this browser). */
  poll?: { code: string; hostKey: string };
};

export type ParsedLink = { src: string; source: string; name: string } | { error: string };

const withParams = (u: URL, params: Record<string, string>) => {
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/**
 * Converts a link to something that can be shown inside the player.
 * Share/edit links from common tools are rewritten to their embed form;
 * anything else is passed through as-is.
 */
export function toEmbed(raw: string): ParsedLink {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: 'That doesn’t look like a link. Paste the full address, starting with https://' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http(s) links can be shown.' };
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname;

  // Google Slides — published (/d/e/<id>/pub) or regular (/d/<id>/edit) links.
  if (host === 'docs.google.com' && path.startsWith('/presentation/')) {
    const pub = /^\/presentation\/d\/e\/([\w-]+)/.exec(path);
    if (pub) return { src: `https://docs.google.com/presentation/d/e/${pub[1]}/embed?start=false&loop=false&delayms=3000`, source: 'Google Slides', name: 'Google Slides deck' };
    const id = /^\/presentation\/d\/([\w-]+)/.exec(path);
    if (id) return { src: `https://docs.google.com/presentation/d/${id[1]}/embed?start=false&loop=false&delayms=3000`, source: 'Google Slides', name: 'Google Slides deck' };
  }

  // Canva — /design/<id>/<token>/view → ?embed
  if (host === 'canva.com' && /^\/design\/[\w-]+\/[\w-]+\/(view|watch|edit)/.test(path)) {
    const base = path.replace(/\/(watch|edit)(\/.*)?$/, '/view').replace(/\/view\/.*$/, '/view');
    return { src: `https://www.canva.com${base}?embed`, source: 'Canva', name: 'Canva design' };
  }

  // Pitch — /public/<id> → /embed/<id>
  if (host === 'pitch.com' && path.startsWith('/public/')) {
    return { src: `https://pitch.com${path.replace(/^\/public\//, '/embed/')}`, source: 'Pitch', name: 'Pitch deck' };
  }

  // Figma (files, prototypes, Slides) — wrapped in Figma's embed host.
  if (host === 'figma.com' && /^\/(file|design|proto|slides|deck|board)\//.test(path)) {
    return { src: `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(u.toString())}`, source: 'Figma', name: 'Figma file' };
  }

  // YouTube
  const yt = host === 'youtu.be' ? path.slice(1) : (host === 'youtube.com' || host === 'm.youtube.com') && path === '/watch' ? u.searchParams.get('v') : null;
  if (yt) return { src: `https://www.youtube.com/embed/${yt}?rel=0&enablejsapi=1`, source: 'YouTube', name: 'YouTube video' };
  if (host === 'youtube.com' && path.startsWith('/embed/')) return { src: u.toString(), source: 'YouTube', name: 'YouTube video' };

  // Vimeo
  const vimeo = host === 'vimeo.com' ? /^\/(\d+)/.exec(path) : null;
  if (vimeo) return { src: `https://player.vimeo.com/video/${vimeo[1]}?api=1`, source: 'Vimeo', name: 'Vimeo video' };

  // PowerPoint for the web (SharePoint / OneDrive for Business) — force the embed view.
  if (/sharepoint\.com$/.test(host) && /\/_layouts\/15\/Doc\.aspx$/i.test(path)) {
    return { src: withParams(u, { action: 'embedview' }), source: 'PowerPoint', name: 'PowerPoint deck' };
  }
  if (host === 'onedrive.live.com' && path.startsWith('/embed')) {
    return { src: u.toString(), source: 'PowerPoint', name: 'PowerPoint deck' };
  }
  if (host === '1drv.ms' || (host === 'onedrive.live.com' && !path.startsWith('/embed'))) {
    return { error: 'OneDrive share links can’t be embedded. In PowerPoint use File → Share → Embed, and paste the link from the embed code (it contains onedrive.live.com/embed).' };
  }

  // Direct links to media files.
  if (/\.pdf$/i.test(path)) return { src: u.toString(), source: 'PDF', name: decodeURIComponent(path.split('/').pop() ?? 'PDF') };

  return { src: u.toString(), source: host, name: host };
}

/** Classifies an uploaded file, or explains why it can't be shown. */
export function fileKind(name: string, mime: string): { kind: MediaKind; source: string } | { error: string } {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mime === 'application/pdf' || ext === 'pdf') return { kind: 'pdf', source: 'PDF' };
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return { kind: 'image', source: 'Image' };
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return { kind: 'video', source: 'Video' };
  if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) {
    return { error: `${name}: browsers can’t open ${ext.toUpperCase()} files directly. Export it as PDF (File → Export / Save as PDF) and upload that, or paste an embed link.` };
  }
  return { error: `${name}: unsupported file type. Use PDF, an image, or a video.` };
}

/** Strips the extension for a friendlier default name. */
export const baseName = (file: string) => file.replace(/\.[^.]+$/, '') || file;

/** Moves item `from` to index `to`, returning a new array. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}
