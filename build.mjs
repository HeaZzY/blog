// Générateur statique : content/posts/*.md  ->  dist/*.html (thème Save Point / Undertale).
// Aucun studio, aucun serveur, aucune base : du Markdown qui compile en HTML.
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BLOG = { name: 'HeaZzy', tagline: 'Notes de cybersécurité, recon et writeups.' };
const MONTHS = ['JAN', 'FÉV', 'MAR', 'AVR', 'MAI', 'JUN', 'JUL', 'AOÛ', 'SEP', 'OCT', 'NOV', 'DÉC'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const readMin = (body) => Math.max(1, Math.round(body.split(/\s+/).filter(Boolean).length / 160));

// --- transforms hast : data-lang sur <pre>, .table-wrap, chemins d'images, liens externes ---
function tweaks() {
  return (tree) => {
    visit(tree, 'element', (node, i, parent) => {
      if (node.tagName === 'pre') {
        const code = node.children.find((c) => c.tagName === 'code');
        const cls = (code && code.properties && code.properties.className) || [];
        const lang = cls.find((c) => typeof c === 'string' && c.startsWith('language-'));
        if (lang) node.properties.dataLang = lang.slice(9);
      }
      if (node.tagName === 'img') {
        let src = node.properties.src || '';
        if (src.startsWith('assets/')) node.properties.src = '../' + src;
        node.properties.loading = 'lazy';
        node.properties.decoding = 'async';
      }
      if (node.tagName === 'a') {
        const href = node.properties.href || '';
        if (/^https?:/i.test(href)) { node.properties.target = '_blank'; node.properties.rel = 'noopener noreferrer'; }
      }
      if (node.tagName === 'table' && parent) {
        const cls = parent.properties && parent.properties.className;
        if (!(Array.isArray(cls) && cls.includes('table-wrap'))) {
          parent.children[i] = { type: 'element', tagName: 'div', properties: { className: ['table-wrap'] }, children: [node] };
          return [SKIP, i];
        }
      }
    });
  };
}

const md2html = (body) => unified()
  .use(remarkParse).use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeHighlight, { ignoreMissing: true })
  .use(tweaks)
  .use(rehypeStringify, { allowDangerousHtml: true })
  .processSync(body).toString();

// --- frontmatter minimal (clé: valeur) ---
function parse(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {}; let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const k = line.indexOf(':'); if (k < 0) continue;
      meta[line.slice(0, k).trim()] = line.slice(k + 1).trim();
    }
  }
  meta.tags = meta.tags ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  meta.level = +meta.level || 1;
  return { meta, body };
}

// --- chrome commun ---
const tag = (t, href) => `<a class="sp-tag" href="${href}">${esc(t)}</a>`;
const topbar = (up = '') => `<header class="topbar">
  <a class="brand" href="${up}index.html"><span class="sp-ico sp-soul"></span>${esc(BLOG.name)}</a>
</header>`;
const page = (title, up, inner) => `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${up}fonts.css"><link rel="stylesheet" href="${up}styles.css">
</head><body class="app">
${topbar(up)}
<main class="shell">${inner}</main>
<script>
// Terminaux annotés : au survol d'un champ, on relie DebugPrint <-> bytes gdb de même couleur.
for (const fig of document.querySelectorAll('.term-fig')) {
  fig.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-f]'); if (!t) return;
    fig.classList.add('hl');
    for (const s of fig.querySelectorAll('[data-f]')) s.classList.toggle('on', s.dataset.f === t.dataset.f);
  });
  fig.addEventListener('mouseleave', () => {
    fig.classList.remove('hl');
    for (const s of fig.querySelectorAll('[data-f].on')) s.classList.remove('on');
  });
}
</script>
</body></html>`;

function postPage(p) {
  const mins = readMin(p.body);
  const meta = `<p class="meta"><span>${fmtDate(p.meta.date)}</span><span>LV ${p.meta.level}</span><span>${mins} MIN</span></p>`;
  const tags = p.meta.tags.map((t) => tag(t, '../tags.html')).join(' ');
  const inner = `<a class="back" href="../index.html"><span class="sp-ico sp-soul"></span>RETOUR</a>
  <div class="post__head">${meta}<h1 class="post__title">${esc(p.meta.title)}</h1>
  <p class="post__tags">${tags}</p></div>
  <article class="prose">${p.html}</article>`;
  return page(`${p.meta.title} — ${BLOG.name}`, '../', inner);
}

function homePage(posts) {
  const entries = posts.map((p) => {
    const mins = readMin(p.body);
    return `<li class="entry"><span class="sp-ico sp-soul entry__soul"></span>
    <a class="entry__link" href="post/${p.slug}.html"><span class="entry__title">${esc(p.meta.title)}</span></a>
    <p class="meta"><span>${fmtDate(p.meta.date)}</span><span>LV ${p.meta.level}</span><span>${mins} MIN</span></p>
    <p class="entry__excerpt">${esc(p.meta.excerpt || '')}</p>
    <p class="entry__tags">${p.meta.tags.map((t) => tag(t, 'tags.html')).join(' ')}</p></li>`;
  }).join('\n');
  const allTags = [...new Set(posts.flatMap((p) => p.meta.tags))];
  const filters = `<div class="filters"><span class="filters__label">FILTRE</span>
    <a class="chip-all" href="index.html" aria-current="page">tout</a>
    ${allTags.map((t) => tag(t, 'tags.html')).join(' ')}</div>`;
  const hero = `<div class="hero"><div class="hero__text">
    <h1 class="blog-name">${esc(BLOG.name)}</h1>
    <p class="sp-line">${esc(BLOG.tagline)}</p></div></div>`;
  return page(BLOG.name, '', `${hero}${filters}<ul class="entries">${entries}</ul>`);
}

function infoPage() {
  const inner = `<a class="back" href="index.html"><span class="sp-ico sp-soul"></span>RETOUR</a>
  <h1 class="page-title">INFO</h1>
  <article class="prose"><p>${esc(BLOG.tagline)}</p>
  <p>Blog statique : les articles sont écrits en Markdown et compilés en HTML (<code>npm run build</code>). Aucun studio, aucun serveur.</p></article>`;
  return page(`Info — ${BLOG.name}`, '', inner);
}

function tagsPage(posts) {
  const counts = {};
  for (const p of posts) for (const t of p.meta.tags) counts[t] = (counts[t] || 0) + 1;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
    `<li><a href="index.html"><span class="sp-ico sp-soul"></span><span class="sp-tag">${esc(t)}</span><span class="count">${n}</span></a></li>`).join('\n');
  const inner = `<a class="back" href="index.html"><span class="sp-ico sp-soul"></span>RETOUR</a>
  <h1 class="page-title">TAGS</h1><ul class="taglist">${rows}</ul>`;
  return page(`Tags — ${BLOG.name}`, '', inner);
}

// --- build ---
const DIST = join(ROOT, 'dist');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'post'), { recursive: true });

const postsDir = join(ROOT, 'content', 'posts');
const posts = readdirSync(postsDir).filter((f) => f.endsWith('.md')).map((f) => {
  const { meta, body } = parse(readFileSync(join(postsDir, f), 'utf8'));
  return { slug: f.replace(/\.md$/, ''), meta, body, html: md2html(body) };
}).sort((a, b) => (a.meta.date < b.meta.date ? 1 : -1));

for (const p of posts) writeFileSync(join(DIST, 'post', `${p.slug}.html`), postPage(p));
writeFileSync(join(DIST, 'index.html'), homePage(posts));
writeFileSync(join(DIST, 'info.html'), infoPage());
writeFileSync(join(DIST, 'tags.html'), tagsPage(posts));

cpSync(join(ROOT, 'theme', 'styles.css'), join(DIST, 'styles.css'));
cpSync(join(ROOT, 'theme', 'fonts.css'), join(DIST, 'fonts.css'));
cpSync(join(ROOT, 'theme', 'fonts'), join(DIST, 'fonts'), { recursive: true });
cpSync(join(ROOT, 'content', 'assets'), join(DIST, 'assets'), { recursive: true });
// Domaine perso : si un fichier CNAME est présent à la racine, on le publie tel quel.
if (existsSync(join(ROOT, 'CNAME'))) cpSync(join(ROOT, 'CNAME'), join(DIST, 'CNAME'));

console.log(`[build] ${posts.length} article(s) -> dist/  (index, tags, info, ${posts.length} post)`);
