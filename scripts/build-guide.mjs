import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = resolve(import.meta.dirname, '..');
const guides = [
  { source: 'usage.md', output: '사용설명서.html', title: 'Glorycourse 사용 설명서' },
  { source: 'troubleshooting.md', output: '문제해결.html', title: 'Glorycourse 문제 해결' },
];
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const headingId = (value) => value.toLocaleLowerCase('ko').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

const style = `
:root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2937;background:#f7f7f4}
*{box-sizing:border-box}body{margin:0;line-height:1.7}.skip{position:absolute;top:-5rem;left:1rem;background:#fff;padding:.6rem}.skip:focus{top:1rem}
header{background:#183d36;color:#fff}header .wrap{max-width:62rem;margin:auto;padding:1.2rem 1.5rem}header strong{font-size:1.25rem}header nav{display:flex;gap:1rem;flex-wrap:wrap;margin-top:.5rem}header a{color:#fff}
main{max-width:62rem;margin:1.5rem auto;padding:1.5rem 2rem;background:#fff;border:1px solid #e2e7e3;border-radius:12px}
h1,h2,h3{line-height:1.35;color:#183d36}h1{margin-top:0}h2{margin-top:2.5rem;padding-top:.5rem;border-top:1px solid #e2e7e3}h3{margin-top:1.8rem}a{color:#145c50;text-underline-offset:2px}a:focus-visible{outline:3px solid #ca8d27;outline-offset:3px}
table{display:block;width:100%;overflow-x:auto;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d8e1dc;padding:.55rem .7rem;text-align:left;vertical-align:top}th{background:#edf4ef;white-space:nowrap}tr:nth-child(even) td{background:#fafcfb}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}code{background:#f1f4f2;padding:.1rem .25rem;border-radius:3px}pre{overflow-x:auto;background:#f1f4f2;padding:1rem;border-radius:6px}pre code{padding:0}li{margin:.4rem 0}footer{max-width:62rem;margin:1rem auto 2rem;padding:0 1.5rem;color:#50645e;font-size:.9rem}
@media(max-width:640px){main{margin:0;padding:1rem;border:0;border-radius:0}header .wrap{padding:1rem}th,td{min-width:7rem}}
@media print{header nav,.skip{display:none}main{border:0;margin:0;max-width:none}a{color:inherit}}
`;

function renderGuide(source, title) {
  const markdown = new Marked({
    gfm: true,
    renderer: {
      heading({ text, tokens, depth }) {
        return `<h${depth} id="${escapeHtml(headingId(text))}">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      link({ href, title: linkTitle, tokens }) {
        const [path, fragment] = href.split('#');
        const target = path === 'usage.md' ? '사용설명서.html' : path === 'troubleshooting.md' ? '문제해결.html' : path;
        const safeHref = /^(https?:\/\/|#|사용설명서\.html|문제해결\.html)/.test(target) || !target ? `${target}${fragment === undefined ? '' : `#${fragment}`}` : '#';
        return `<a href="${escapeHtml(safeHref)}"${linkTitle ? ` title="${escapeHtml(linkTitle)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
      html({ text }) { return escapeHtml(text); },
    },
  });
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeHtml(title)}</title><style>${style}</style></head>
<body><a class="skip" href="#content">본문으로 건너뛰기</a><header><div class="wrap"><strong>Glorycourse</strong><nav aria-label="설명서"><a href="사용설명서.html">사용 설명서</a><a href="문제해결.html">문제 해결</a></nav></div></header>
<main id="content">${markdown.parse(source)}</main><footer>이 설명서는 배포 파일에 포함된 문서로, 인터넷 연결 없이 읽을 수 있습니다.</footer></body></html>\n`;
}

export async function buildGuides(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  for (const guide of guides) {
    const source = await readFile(join(root, 'docs', guide.source), 'utf8');
    await writeFile(join(outputDirectory, guide.output), renderGuide(source, guide.title));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildGuides(join(root, 'dist', 'guide-preview'));
  console.log('Created dist/guide-preview/사용설명서.html and 문제해결.html');
}
