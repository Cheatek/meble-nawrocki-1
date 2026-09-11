import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const CATEGORIES = ['Kuchnie', 'Szafy', 'Zabudowy', 'Inne'];
export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
const FORMATS = new Map([['.jpg', 'jpeg'], ['.jpeg', 'jpeg'], ['.png', 'png'], ['.webp', 'webp']]);
const START = '<!-- GALLERY:START -->';
const END = '<!-- GALLERY:END -->';
const SITE_PAGES = ['index.html', 'gallery.html', 'contact.html'];

export function imagePath(reference) {
  if (typeof reference !== 'string' || reference.length > 512 ||
      /[\\%?#:\u0000-\u001f\u007f]/u.test(reference)) {
    throw new Error('Invalid image path');
  }
  const relative = reference.replace(/^\//, '');
  const segments = relative.split('/');
  if (segments[0] !== 'images' || segments.length < 2 ||
      segments.some(segment => !segment || segment === '.' || segment === '..') ||
      segments[1] === 'thumbnails') {
    throw new Error(`Unsafe image path: ${reference}`);
  }
  if (!FORMATS.has(path.extname(relative).toLowerCase())) {
    throw new Error(`Unsupported image extension: ${reference}`);
  }
  return relative;
}

export function validateGallery(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.photos) || data.photos.length > 1000) {
    throw new Error('Gallery must contain a photos list (maximum 1000 entries)');
  }
  return data.photos.map((photo, index) => {
    if (!photo || typeof photo !== 'object' || Array.isArray(photo)) {
      throw new Error(`Invalid photo at position ${index + 1}`);
    }
    const image = imagePath(photo.image);
    if (typeof photo.alt !== 'string' || !photo.alt.trim() || photo.alt.length > 300 ||
        /[\u0000-\u001f\u007f]/u.test(photo.alt)) {
      throw new Error(`Photo ${index + 1}: alt must contain 1–300 printable characters`);
    }
    if (!CATEGORIES.includes(photo.category)) {
      throw new Error(`Photo ${index + 1}: invalid category`);
    }
    return { image, alt: photo.alt.trim(), category: photo.category };
  });
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function imageUrl(reference) {
  return imagePath(reference).split('/').map(encodeURIComponent).join('/');
}

export function renderGallery(photos, assets) {
  if (!photos.length) return '<p class="gallery-empty">Nowe realizacje pojawią się wkrótce.</p>';
  return `<ul class="nospace gallery-grid">\n${photos.map(photo => {
    const asset = assets.get(photo.image);
    if (!asset) throw new Error(`Missing optimized image: ${photo.image}`);
    return `  <li><a href="${escapeHtml(imageUrl(photo.image))}"><img src="${escapeHtml(asset.thumbnail)}" alt="${escapeHtml(photo.alt)}" width="${asset.width}" height="${asset.height}" loading="lazy" decoding="async"></a><span class="gallery-category">${escapeHtml(photo.category)}</span></li>`;
  }).join('\n')}\n</ul>`;
}

export function replaceGallery(template, content) {
  if (template.split(START).length !== 2 || template.split(END).length !== 2 ||
      template.indexOf(END) < template.indexOf(START)) {
    throw new Error('Gallery template must contain exactly one ordered marker pair');
  }
  return template.slice(0, template.indexOf(START) + START.length) +
    `\n${content}\n          ` + template.slice(template.indexOf(END));
}

export function resolveBranch({ branch, env = process.env, root = process.cwd() } = {}) {
  const platformBranches = env.NETLIFY
    ? [env.HEAD, env.BRANCH, env.GITHUB_HEAD_REF, env.GITHUB_REF_NAME]
    : [env.GITHUB_HEAD_REF, env.GITHUB_REF_NAME, env.HEAD, env.BRANCH];
  const candidate = branch ?? [env.CMS_BRANCH, ...platformBranches].find(value => value);
  const resolved = candidate ?? execFileSync('git', ['branch', '--show-current'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  if (!resolved || resolved === 'HEAD' || /[\u0000-\u001f\u007f]/u.test(resolved)) {
    throw new Error('No checked-out branch; set CMS_BRANCH explicitly');
  }
  return resolved;
}

export function interpolateBranch(config, branch) {
  if (typeof branch !== 'string' || !branch || branch === 'HEAD' ||
      /[\u0000-\u001f\u007f]/u.test(branch)) throw new Error('Invalid CMS branch');
  const pattern = /^([ \t]{2}branch:[ \t]*)([^#\r\n]*?)[ \t]*$/gm;
  if ([...config.matchAll(pattern)].length !== 1) {
    throw new Error('CMS config must contain exactly one backend branch');
  }
  return config.replace(pattern, (_, prefix) => prefix + JSON.stringify(branch));
}

export function resolveSiteDomain(env = process.env) {
  const domain = env.CMS_SITE_DOMAIN || (env.URL ? new URL(env.URL).hostname : '');
  if (typeof domain !== 'string' || domain.length > 253 ||
      (domain && domain.split('.').some(label =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) {
    throw new Error('CMS_SITE_DOMAIN must be a hostname without scheme, path, port or credentials');
  }
  return domain;
}

export function interpolateSiteDomain(config, domain) {
  if (typeof domain !== 'string') throw new Error('CMS site domain must be a string');
  resolveSiteDomain({ CMS_SITE_DOMAIN: domain });
  const pattern = /^([ \t]{2}site_domain:[ \t]*)([^#\r\n]*?)[ \t]*$/gm;
  const matches = [...config.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error('CMS config must contain exactly one backend site_domain');
  }
  if (!domain && matches[0][2].trim() !== '__CMS_SITE_DOMAIN__') return config;
  return config.replace(pattern, (_, prefix) => prefix + JSON.stringify(domain));
}

export function discoverImages(html) {
  const found = new Set();
  const references = [
    ...html.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi),
    ...html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)
  ];
  for (const [, reference] of references) {
    if (/^\/?images\//.test(reference) || /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(reference)) {
      found.add(imagePath(reference));
    }
  }
  return found;
}

export async function readImage(root, reference) {
  const relative = imagePath(reference);
  const imagesRoot = path.join(root, 'images');
  if (await realpath(imagesRoot) !== imagesRoot) throw new Error('Images directory must not be a symlink');
  const source = await realpath(path.join(root, relative));
  if (!source.startsWith(`${imagesRoot}${path.sep}`)) throw new Error(`Image escapes images directory: ${reference}`);
  const details = await stat(source);
  if (!details.isFile() || details.size > MAX_BYTES) throw new Error(`Image exceeds 20 MB or is not a file: ${reference}`);
  const buffer = await readFile(source);
  if (buffer.length > MAX_BYTES) throw new Error(`Image exceeds 20 MB: ${reference}`);
  // libvips can read an APNG as a single still image, so inspect its animation control chunk.
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset);
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'acTL') {
        throw new Error(`Animated PNG is not supported: ${reference}`);
      }
      offset += length + 12;
    }
  }
  const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS, animated: true }).metadata();
  if (metadata.format !== FORMATS.get(path.extname(relative).toLowerCase())) {
    throw new Error(`Image contents do not match supported extension: ${reference}`);
  }
  if ((metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height ||
      metadata.width * metadata.height > MAX_PIXELS) {
    throw new Error(`Animated, multipage, or oversized image: ${reference}`);
  }
  return buffer;
}

export async function optimizeImage(buffer, reference, thumbnail = false) {
  const format = FORMATS.get(path.extname(imagePath(reference)).toLowerCase());
  const full = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning' })
    .rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .toFormat(format, { quality: 82 }).toBuffer({ resolveWithObject: true });
  if (!thumbnail) return { full };
  const small = await sharp(full.data).resize({
    width: 640, height: 640, fit: 'inside', withoutEnlargement: true
  }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
  const fingerprint = createHash('sha256').update(small.data).digest('hex');
  return { full, small, thumbnail: `images/thumbnails/${fingerprint}.webp` };
}

async function copyAssets(source, destination) {
  const allowed = new Set(['.html', '.css', '.js', '.yml', '.yaml', '.eot', '.ttf', '.woff', '.woff2', '.svg']);
  if ((await lstat(source)).isSymbolicLink()) throw new Error(`Refusing asset symlink: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing asset symlink: ${entry.name}`);
    if (entry.isDirectory()) {
      await copyAssets(path.join(source, entry.name), path.join(destination, entry.name));
    } else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
      await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
    }
  }
}

export async function build({ root = process.cwd(), branch, env = process.env } = {}) {
  root = await realpath(root);
  const photos = validateGallery(JSON.parse(await readFile(path.join(root, 'data/gallery.json'), 'utf8')));
  const cmsBranch = resolveBranch({ root, branch, env });
  const config = interpolateSiteDomain(
    interpolateBranch(await readFile(path.join(root, 'admin/config.yml'), 'utf8'), cmsBranch),
    resolveSiteDomain(env)
  );
  const pages = new Map();
  for (const page of SITE_PAGES) {
    let html = await readFile(path.join(root, page), 'utf8');
    html = html.replace(/(\b(?:src|href)\s*=\s*["'])\.\.\/layout\//gi, '$1layout/');
    if (page === 'gallery.html') html = replaceGallery(html, '');
    pages.set(page, html);
  }
  const galleryImages = new Set(photos.map(photo => photo.image));
  const references = new Set(galleryImages);
  for (const html of pages.values()) {
    for (const reference of discoverImages(html)) references.add(reference);
  }

  // Never follow a pre-existing output symlink, or copy the original upload tree.
  const output = path.join(root, '_site');
  const existing = await lstat(output).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error('Output directory must not be a symlink');
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  await copyAssets(path.join(root, 'layout'), path.join(output, 'layout'));
  await copyAssets(path.join(root, 'admin'), path.join(output, 'admin'));
  await writeFile(path.join(output, 'admin/config.yml'), config);

  const assets = new Map();
  for (const reference of references) {
    const buffer = await readImage(root, reference);
    const result = await optimizeImage(buffer, reference, galleryImages.has(reference));
    const destination = path.join(output, reference);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, result.full.data);
    if (result.small) {
      await mkdir(path.join(output, 'images/thumbnails'), { recursive: true });
      await writeFile(path.join(output, result.thumbnail), result.small.data);
      assets.set(reference, {
        thumbnail: result.thumbnail, width: result.small.info.width, height: result.small.info.height
      });
    }
  }
  pages.set('gallery.html', replaceGallery(pages.get('gallery.html'), renderGallery(photos, assets)));
  for (const [page, html] of pages) await writeFile(path.join(output, page), html);
  return { output, photos: photos.length, images: references.size, branch: cmsBranch };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().then(result => {
    console.log(`Built ${result.photos} gallery entries and ${result.images} optimized images in ${result.output} (CMS branch: ${result.branch})`);
  }).catch(error => {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
