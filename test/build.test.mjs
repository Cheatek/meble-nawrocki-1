import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  build, discoverImages, escapeHtml, imagePath, interpolateBranch, interpolateSiteDomain, MAX_BYTES,
  optimizeImage, readImage, renderGallery, replaceGallery, resolveBranch, resolveSiteDomain, validateGallery
} from '../scripts/build.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const photo = { image: '/images/photo.jpg', alt: 'Meble na wymiar', category: 'Inne' };

async function fixture(t) {
  const root = path.join(repository, `.gallery-test-${randomUUID()}`);
  await mkdir(path.join(root, 'images'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function jpeg() {
  return sharp({ create: { width: 12, height: 8, channels: 3, background: 'white' } }).jpeg().toBuffer();
}

test('gallery metadata validates categories, alt text, structure and limits', () => {
  assert.deepEqual(validateGallery({ photos: [photo] }), [{ ...photo, image: 'images/photo.jpg' }]);
  assert.deepEqual(validateGallery({ photos: [] }), []);
  for (const data of [null, [], {}, { photos: {} }, { photos: Array(1001).fill(photo) }]) {
    assert.throws(() => validateGallery(data));
  }
  for (const invalid of [
    null, [], {}, { ...photo, alt: '' }, { ...photo, alt: '  ' },
    { ...photo, alt: 'a'.repeat(301) }, { ...photo, alt: '\u0000oops' },
    { ...photo, alt: 123 }, { ...photo, category: '' }, { ...photo, category: '<script>' }
  ]) assert.throws(() => validateGallery({ photos: [invalid] }));
  for (const category of ['Kuchnie', 'Szafy', 'Zabudowy', 'Inne']) {
    assert.equal(validateGallery({ photos: [{ ...photo, category }] })[0].category, category);
  }
});

test('unsafe image paths and unsupported formats are rejected', () => {
  for (const reference of [
    undefined, '', '/etc/passwd', '//images/photo.jpg', '../images/photo.jpg',
    '/images/../photo.jpg', 'images//photo.jpg', 'images/./photo.jpg',
    'images\\photo.jpg', 'images/%2e%2e/photo.jpg', 'images/photo.jpg?download=1',
    'images/photo.jpg#fragment', 'images/a\u0000.jpg', 'images/a:b.jpg',
    'https://example.org/photo.jpg', 'data:image/jpeg;base64,AA',
    '/images/photo.svg', '/images/photo.gif', '/images/photo.avif',
    'images/thumbnails/photo.webp'
  ]) assert.throws(() => imagePath(reference), String(reference));
  for (const reference of ['images/a.JPG', '/images/a.jpeg', 'images/a.png', 'images/Nowe zdjęcie.webp']) {
    assert.equal(imagePath(reference), reference.replace(/^\//, ''));
  }
});

test('static gallery escapes metadata, uses relative links, lazy loading and dimensions', () => {
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  const photos = validateGallery({ photos: [{ ...photo, alt: '"><script>alert("x")</script> & \'' }] });
  const assets = new Map([['images/photo.jpg', {
    thumbnail: 'images/thumbnails/abc.webp', width: 12, height: 8
  }]]);
  const html = renderGallery(photos, assets);
  assert.match(html, /alt="&quot;&gt;&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|href="\/|src="\//);
  assert.match(html, /width="12" height="8" loading="lazy" decoding="async"/);
  assert.match(html, /href="images\/photo.jpg"/);
  assert.throws(() => renderGallery(photos, new Map()), /Missing optimized/);
});

test('empty galleries and replacement remove every fallback entry', () => {
  const empty = renderGallery([], new Map());
  assert.match(empty, /Nowe realizacje pojawią się wkrótce/);
  assert.doesNotMatch(empty, /<img|<li/);
  const template = 'before<!-- GALLERY:START --><ul><li>old</li></ul><!-- GALLERY:END -->after';
  const result = replaceGallery(template, empty);
  assert.doesNotMatch(result, /old|<li/);
  assert.match(result, /^before/);
  assert.match(result, /after$/);
  for (const invalid of ['', '<!-- GALLERY:END --><!-- GALLERY:START -->', template + template]) {
    assert.throws(() => replaceGallery(invalid, empty), /marker/);
  }
});

test('branch selection respects explicit configuration and each hosting platform', () => {
  assert.equal(resolveBranch({ branch: 'feature/gallery', env: {} }), 'feature/gallery');
  assert.equal(resolveBranch({ env: { CMS_BRANCH: 'override', GITHUB_REF_NAME: 'main' } }), 'override');
  assert.equal(resolveBranch({ env: { GITHUB_HEAD_REF: 'feature/pr', GITHUB_REF_NAME: '4/merge' } }), 'feature/pr');
  assert.equal(resolveBranch({ env: { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'production' } }), 'production');
  assert.equal(resolveBranch({ env: { NETLIFY: 'true', HEAD: 'preview', BRANCH: 'main', GITHUB_REF_NAME: 'stale' } }), 'preview');
  assert.equal(resolveBranch({ env: { HEAD: '', BRANCH: 'netlify-main' } }), 'netlify-main');
  for (const branch of ['', 'HEAD', 'bad\nbranch']) assert.throws(() => resolveBranch({ branch, env: {} }));
});

test('branch configuration is safely replaced and JSON quoted inside YAML', () => {
  const config = 'backend:\n  branch: __CMS_BRANCH__\n  name: git-gateway\n';
  const branch = 'feature/"quoted"#value';
  assert.equal(interpolateBranch(config, branch), `backend:\n  branch: ${JSON.stringify(branch)}\n  name: git-gateway\n`);
  assert.equal(interpolateBranch('backend:\n  branch: master\n', 'preview'),
    'backend:\n  branch: "preview"\n');
  assert.throws(() => interpolateBranch('branch: master\n', 'main'));
  assert.throws(() => interpolateBranch(config + config, 'main'));
  assert.throws(() => interpolateBranch(config, 'HEAD'));
  assert.throws(() => interpolateBranch(config, 'main\ninjected: true'));
});

test('CMS site domain resolves explicit overrides, Netlify URLs and empty local setup', () => {
  assert.equal(resolveSiteDomain({}), '');
  assert.equal(resolveSiteDomain({ CMS_SITE_DOMAIN: 'gallery.example.org', URL: 'https://other.example.org' }), 'gallery.example.org');
  assert.equal(resolveSiteDomain({ URL: 'https://site-name.netlify.app/path' }), 'site-name.netlify.app');
  assert.equal(resolveSiteDomain({ CMS_SITE_DOMAIN: '', URL: 'https://site.netlify.app' }), 'site.netlify.app');
  for (const domain of [
    'https://site.netlify.app', 'site.netlify.app/path', 'user@site.netlify.app',
    'site.netlify.app:443', '-site.example', 'site-.example', 'site..example',
    'site.example\nbad', ' site.example', 'site.example?key=1', 'a'.repeat(64) + '.example'
  ]) assert.throws(() => resolveSiteDomain({ CMS_SITE_DOMAIN: domain }), /must be a hostname/);
  assert.throws(() => resolveSiteDomain({ URL: 'not a URL' }));
});

test('CMS site domain configuration is safely replaced and JSON quoted', () => {
  const config = 'backend:\n  site_domain: __CMS_SITE_DOMAIN__\n';
  assert.equal(interpolateSiteDomain(config, ''), 'backend:\n  site_domain: ""\n');
  assert.equal(interpolateSiteDomain(config, 'site.netlify.app'), 'backend:\n  site_domain: "site.netlify.app"\n');
  assert.equal(interpolateSiteDomain('backend:\n  site_domain: old.netlify.app\n', 'site.netlify.app'),
    'backend:\n  site_domain: "site.netlify.app"\n');
  assert.equal(interpolateSiteDomain('backend:\n  site_domain: existing.netlify.app\n', ''),
    'backend:\n  site_domain: existing.netlify.app\n');
  assert.throws(() => interpolateSiteDomain(config, 'site"\ninjected'));
  assert.throws(() => interpolateSiteDomain(config, undefined));
  assert.throws(() => interpolateSiteDomain('site_domain: old.netlify.app', 'site.netlify.app'));
  assert.throws(() => interpolateSiteDomain(config + config, 'site.netlify.app'));
});

test('shared image discovery includes HTML image links and background URLs', () => {
  assert.deepEqual([...discoverImages(`<img src="images/a.JPG"><a href="images/b.webp">x</a>
    <div style="background-image:url('images/bg.png')"></div><script src="layout/a.js"></script>`)],
  ['images/a.JPG', 'images/b.webp', 'images/bg.png']);
  assert.throws(() => discoverImages('<img src="images/../a.jpg">'));
});

test('optimized images rotate, cap dimensions, strip metadata and fingerprint thumbnails', async () => {
  const original = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: '#845d30' }
  }).jpeg().withMetadata({ orientation: 6 }).withExifMerge({
    IFD0: { Artist: 'Private fixture owner' },
    IFD3: {
      GPSLatitudeRef: 'N', GPSLatitude: '52/1 13/1 12/1',
      GPSLongitudeRef: 'E', GPSLongitude: '21/1 0/1 0/1'
    }
  }).toBuffer();
  const source = await sharp(original).metadata();
  assert.ok(source.exif.includes(Buffer.from('Private fixture owner')));
  assert.ok(source.exif.includes(Buffer.from('2588040001000000', 'hex')), 'fixture contains a GPS IFD pointer');
  assert.ok(source.icc);
  const result = await optimizeImage(original, 'images/original.JPG', true);
  const full = await sharp(result.full.data).metadata();
  const small = await sharp(result.small.data).metadata();
  assert.equal(full.width, 1000);
  assert.equal(full.height, 2000);
  assert.equal(full.exif, undefined);
  assert.equal(full.icc, undefined);
  assert.equal(full.xmp, undefined);
  assert.equal(full.iptc, undefined);
  assert.equal(full.orientation, undefined);
  assert.equal(small.width, 320);
  assert.equal(small.height, 640);
  assert.equal(small.format, 'webp');
  assert.equal(small.exif, undefined);
  assert.equal(small.icc, undefined);
  assert.equal(small.xmp, undefined);
  assert.equal(small.iptc, undefined);
  assert.match(result.thumbnail, /^images\/thumbnails\/[a-f0-9]{64}\.webp$/);
  assert.equal((await optimizeImage(original, 'images/original.JPG', true)).thumbnail, result.thumbnail);
  const tiny = await optimizeImage(await jpeg(), 'images/tiny.jpg', true);
  assert.equal(tiny.full.info.width, 12);
  assert.equal(tiny.small.info.width, 12);
});

test('valid JPEG, PNG and WebP decode and retain their supported output format', async t => {
  const root = await fixture(t);
  for (const format of ['jpeg', 'png', 'webp']) {
    const buffer = await sharp({
      create: { width: 10, height: 15, channels: 4, background: '#ffffff80' }
    }).toFormat(format).toBuffer();
    const reference = `images/photo.${format}`;
    await writeFile(path.join(root, reference), buffer);
    assert.deepEqual(await readImage(root, reference), buffer);
    const { full } = await optimizeImage(buffer, reference);
    assert.equal((await sharp(full.data).metadata()).format, format);
  }
});

test('invalid decodes, format disguises, oversized files and external symlinks fail', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'images/broken.jpg'), 'not an image');
  await assert.rejects(readImage(root, 'images/broken.jpg'));
  await writeFile(path.join(root, 'images/disguised.png'), await jpeg());
  await assert.rejects(readImage(root, 'images/disguised.png'), /match supported extension/);
  await writeFile(path.join(root, 'images/large.jpg'), Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(readImage(root, 'images/large.jpg'), /exceeds 20 MB/);
  await writeFile(path.join(root, 'outside.jpg'), await jpeg());
  await symlink('../outside.jpg', path.join(root, 'images/link.jpg'));
  await assert.rejects(readImage(root, 'images/link.jpg'), /escapes images directory/);
  await assert.rejects(readImage(root, 'images/missing.jpg'), /ENOENT/);
});

test('animated WebP and images over 40 megapixels are rejected', async t => {
  const root = await fixture(t);
  const frames = [];
  for (const background of ['red', 'blue']) {
    frames.push(await sharp({
      create: { width: 4, height: 4, channels: 3, background }
    }).png().toBuffer());
  }
  const animated = await sharp(frames, { join: { animated: true } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  await writeFile(path.join(root, 'images/animated.webp'), animated);
  await assert.rejects(readImage(root, 'images/animated.webp'), /Animated, multipage/);
  const png = await sharp(frames[0]).png().toBuffer();
  const animationControl = Buffer.alloc(20);
  animationControl.writeUInt32BE(8, 0);
  animationControl.write('acTL', 4);
  animationControl.writeUInt32BE(2, 8);
  const apng = Buffer.concat([png.subarray(0, 33), animationControl, png.subarray(33)]);
  await writeFile(path.join(root, 'images/animated.png'), apng);
  await assert.rejects(readImage(root, 'images/animated.png'), /Animated PNG/);
  const oversized = await sharp({
    create: { width: 8000, height: 5001, channels: 3, background: 'white' }
  }).png().toBuffer();
  await writeFile(path.join(root, 'images/oversized.png'), oversized);
  await assert.rejects(readImage(root, 'images/oversized.png'), /pixel limit|oversized/i);
});

test('editable gallery data validates and references existing image files', async () => {
  const data = JSON.parse(await readFile(path.join(repository, 'data/gallery.json'), 'utf8'));
  const photos = validateGallery(data);
  for (const entry of photos) assert.ok((await stat(path.join(repository, entry.image))).isFile());
});

test('frozen source fallback preserves the original migration independently of editable data', async () => {
  const expected = [
    'x4.JPG', 'x5.JPG', 'x6.JPG', 'x3.JPG', 'xx.jpg', 'xx1.jpg', 'xx2.jpg', 'xx4.jpg',
    ...Array.from({ length: 24 }, (_, index) => `image${index + 1}.jpg`),
    ...Array.from({ length: 10 }, (_, index) => `${index + 25}.jpg`),
    'x1.JPG', 'x2.JPG', 'xx5.jpg'
  ];
  const template = await readFile(path.join(repository, 'gallery.html'), 'utf8');
  const fallback = template.split('<!-- GALLERY:START -->')[1].split('<!-- GALLERY:END -->')[0];
  const entries = [...fallback.matchAll(/<a href="([^"]+)"><img src="([^"]+)" alt="([^"]+)"/g)];
  assert.equal(entries.length, 45);
  assert.deepEqual(entries.map(([, href]) => path.basename(href)), expected);
  for (const [, href, src, alt] of entries) {
    assert.equal(href, src);
    assert.ok(alt.trim());
    assert.ok((await stat(path.join(repository, imagePath(src)))).isFile());
  }
  assert.match(fallback, /class="nospace gallery-grid"/);
  assert.doesNotMatch(fallback, /one_quarter|class="[^"]*\bfirst\b/);
  assert.doesNotMatch(replaceGallery(template, renderGallery([], new Map())), /<img/);
});

async function siteFixture(t, photos = [photo, photo]) {
  const root = await fixture(t);
  for (const directory of ['data', 'admin', 'layout/styles']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'data/gallery.json'), JSON.stringify({ photos }));
  await writeFile(path.join(root, 'admin/config.yml'), 'backend:\n  branch: __CMS_BRANCH__\n  site_domain: __CMS_SITE_DOMAIN__\n');
  await writeFile(path.join(root, 'admin/index.html'), '<h1>CMS</h1>');
  await writeFile(path.join(root, 'layout/styles/layout.css'), 'body{}');
  await writeFile(path.join(root, 'index.html'), '<img src="images/shared.jpg">');
  await writeFile(path.join(root, 'contact.html'),
    '<link href="../layout/styles/layout.css"><div style="background-image:url(images/shared.jpg)"></div>');
  await writeFile(path.join(root, 'gallery.html'),
    '<!-- GALLERY:START --><img src="images/stale.jpg"><!-- GALLERY:END -->');
  await writeFile(path.join(root, 'images/photo.jpg'), await jpeg());
  await writeFile(path.join(root, 'images/shared.jpg'), await jpeg());
  await writeFile(path.join(root, 'images/unpublished.jpg'), 'unprocessed upload');
  await writeFile(path.join(root, 'private.txt'), 'must not publish');
  return root;
}

test('complete build produces only static public assets and reuses duplicate photos', async t => {
  const root = await siteFixture(t);
  const result = await build({ root, branch: 'feature/gallery', env: { CMS_SITE_DOMAIN: 'site.netlify.app' } });
  assert.equal(result.photos, 2);
  assert.equal(result.images, 2);
  assert.deepEqual((await readdir(result.output)).sort(), ['admin', 'contact.html', 'gallery.html', 'images', 'index.html', 'layout']);
  assert.equal((await readdir(path.join(result.output, 'images/thumbnails'))).length, 1);
  assert.equal(await readFile(path.join(result.output, 'admin/config.yml'), 'utf8'),
    'backend:\n  branch: "feature/gallery"\n  site_domain: "site.netlify.app"\n');
  assert.match(await readFile(path.join(result.output, 'contact.html'), 'utf8'), /href="layout\/styles\/layout.css"/);
  const html = await readFile(path.join(result.output, 'gallery.html'), 'utf8');
  assert.equal([...html.matchAll(/<li>/g)].length, 2);
  assert.doesNotMatch(html, /stale|<script|__CMS_BRANCH__/);
  await assert.rejects(stat(path.join(result.output, 'images/unpublished.jpg')), /ENOENT/);
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(reference, 'https://example.org/repository/gallery.html');
    assert.ok(url.pathname.startsWith('/repository/'));
    assert.ok((await stat(path.join(result.output, decodeURIComponent(url.pathname.slice('/repository/'.length))))).isFile());
  }
  await writeFile(path.join(result.output, 'obsolete.txt'), 'old output');
  await build({ root, branch: 'feature/gallery', env: {} });
  assert.match(await readFile(path.join(result.output, 'admin/config.yml'), 'utf8'), /site_domain: ""/);
  await assert.rejects(stat(path.join(result.output, 'obsolete.txt')), /ENOENT/);
});

test('empty gallery builds and unpublished original photos are excluded', async t => {
  const root = await siteFixture(t, []);
  const result = await build({ root, branch: 'test' });
  assert.equal(result.photos, 0);
  assert.equal(result.images, 1);
  assert.match(await readFile(path.join(result.output, 'gallery.html'), 'utf8'), /Nowe realizacje/);
  await assert.rejects(stat(path.join(result.output, 'images/photo.jpg')), /ENOENT/);
});

test('CMS additions, removals, reordering and description edits rebuild without changing the fallback', async t => {
  const second = { ...photo, image: '/images/second.jpg', alt: 'Druga realizacja' };
  const added = { ...photo, image: '/images/uploads/new.jpg', alt: 'Nowa realizacja' };
  const edited = { ...added, alt: 'Zmieniony opis "mebli" & <szafy>', category: 'Szafy' };
  const root = await siteFixture(t, [photo, second]);
  await writeFile(path.join(root, 'images/second.jpg'), await jpeg());
  await mkdir(path.join(root, 'images/uploads'));
  await writeFile(path.join(root, 'images/uploads/new.jpg'), await jpeg());
  const fallback = await readFile(path.join(root, 'gallery.html'), 'utf8');

  for (const photos of [
    [photo, second],
    [photo, second, added],
    [second, added],
    [added, second],
    [edited, second]
  ]) {
    await writeFile(path.join(root, 'data/gallery.json'), JSON.stringify({ photos }));
    const result = await build({ root, branch: 'cms/edits', env: {} });
    const html = await readFile(path.join(result.output, 'gallery.html'), 'utf8');
    const entries = [...html.matchAll(/<li><a href="([^"]+)"><img [^>]*alt="([^"]+)"/g)];
    assert.equal(result.photos, photos.length);
    assert.deepEqual(entries.map(([, href, alt]) => ({ href, alt })),
      photos.map(entry => ({ href: imagePath(entry.image), alt: escapeHtml(entry.alt) })));
    assert.doesNotMatch(html, /stale\.jpg/);
    assert.equal(await readFile(path.join(root, 'gallery.html'), 'utf8'), fallback);
  }
  await assert.rejects(stat(path.join(root, '_site/images/photo.jpg')), /ENOENT/);
});

test('build rejects output and static asset symlink traversal', async t => {
  const root = await siteFixture(t);
  await mkdir(path.join(root, 'outside'));
  await symlink('outside', path.join(root, '_site'));
  await assert.rejects(build({ root, branch: 'test' }), /Output directory must not be a symlink/);
  await rm(path.join(root, '_site'));
  await symlink('../../outside', path.join(root, 'layout/styles/external'));
  await assert.rejects(build({ root, branch: 'test' }), /Refusing asset symlink/);
});
