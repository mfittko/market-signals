#!/usr/bin/env node
// Build the static site: site/content/*.md -> _site/*.html, plus site/assets.
// Markdown is the source of truth. Run: npm i --no-save marked@18.0.14 && node scripts/build-site.mjs
// ponytail: one template, one renderer override, no framework. Add a theme engine when a second layout exists.
import { readFile, writeFile, readdir, mkdir, cp, rm, access } from 'node:fs/promises';
import { marked } from 'marked';

const SRC = 'site/content';
const OUT = process.env.SITE_OUT || '_site';
const ORIGIN = 'https://market-signals.io';
const NAV = [['index', 'Vision'], ['architecture', 'Architecture'], ['guide', 'Guide']];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const screens = new Set();

marked.use({
  walkTokens(t) {
    // Links between pages are written as .md so they also work on GitHub.
    if (t.type === 'link' && /^[\w-]+\.md(#.*)?$/.test(t.href)) t.href = t.href.replace('.md', '.html');
  },
  renderer: {
    // ![alt](screen:name "caption") renders a light/dark screenshot pair.
    image({ href, title, text }) {
      if (!href.startsWith('screen:')) return false;
      const n = href.slice(7);
      screens.add(n);
      const cap = title ? `<figcaption>${esc(title)}</figcaption>` : '';
      return `<figure class="shot"><picture><source srcset="assets/screens/${n}-dark.png" media="(prefers-color-scheme: dark)"><img src="assets/screens/${n}-light.png" alt="${esc(text)}" loading="lazy"></picture>${cap}</figure>`;
    },
  },
});

function frontmatter(src, file) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta = Object.fromEntries(m[1].split('\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')];
  }));
  if (!meta.title || !meta.description) throw new Error(`${file}: frontmatter needs title and description`);
  return [meta, src.slice(m[0].length)];
}

const tpl = await readFile('site/template.html', 'utf8');
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp('site/assets', `${OUT}/assets`, { recursive: true });

const files = (await readdir(SRC)).filter((f) => f.endsWith('.md')).sort();
for (const f of files) {
  const [meta, md] = frontmatter(await readFile(`${SRC}/${f}`, 'utf8'), f);
  const slug = f.slice(0, -3);
  const nav = NAV.map(([s, label]) => `<a href="${s === 'index' ? './' : s + '.html'}"${s === slug ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const html = tpl
    .replaceAll('{{title}}', esc(meta.title))
    .replaceAll('{{description}}', esc(meta.description))
    .replaceAll('{{url}}', `${ORIGIN}/${slug === 'index' ? '' : slug + '.html'}`)
    .replace('{{nav}}', () => nav)
    .replace('{{body}}', () => marked.parse(md));
  await writeFile(`${OUT}/${slug}.html`, html);
}

// Fail closed: every referenced screenshot must exist in both themes.
for (const n of screens) for (const t of ['dark', 'light']) await access(`site/assets/screens/${n}-${t}.png`);
console.log(`built ${files.length} pages, ${screens.size} screenshots -> ${OUT}/`);
