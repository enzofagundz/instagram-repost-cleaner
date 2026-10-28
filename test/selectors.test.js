const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'instagram-limpar-reposts-salvos.user.js'), 'utf8');
const FIXTURE = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label} -> ${actual}${ok ? '' : ` (esperado ${expected})`}`);
}

function boot(bodyHtml, url = 'https://www.instagram.com/exemplo01/reposts/') {
  const dom = new JSDOM(
    `<!doctype html><html><body><main>${bodyHtml}</main></body></html>`,
    { url, runScripts: 'outside-only', pretendToBeVisual: true },
  );
  dom.window.scrollBy = () => {};
  dom.window.scrollTo = () => {};
  dom.window.eval(SCRIPT);
  return dom.window;
}

const inArticle = (html) => `<article><div>${html}</div></article>`;

function openPost(html, url) {
  const win = boot(html, url);
  const api = win.__igCleaner;
  return { win, api, article: api.findPostArticle() };
}

async function postAberto() {
  console.log('\n[post aberto — repostado, não salvo]');
  const { api, article } = openPost(FIXTURE('post-aberto.html'));

  check('article encontrado', !!article, true);

  const save = api.findSaveButton(article);
  const repost = api.findRepostButton(article);
  check('botão salvar encontrado', !!save, true);
  check('salvar está ativo', api.isSaved(save), false);
  check('botão repostar encontrado', !!repost, true);
  check('repostar está ativo (post repostado)', api.isReposted(repost), true);
  check('badge 22x22 do cabeçalho ignorado', repost.getAttribute('height'), '24');

  const codes = api.articleCodes(article);
  check('permalink do post lido', codes.has('AAA111'), true);
  check('post aberto confere com a fila', !!api.matchingArticle('AAA111'), true);
  check('post de outro shortcode é recusado', api.matchingArticle('OUTRO123'), null);
}

async function botoesIsolados() {
  console.log('\n[botões isolados]');
  const cases = [
    ['botao-repostado.html', 'isReposted', true],
    ['botao-nao-repostado.html', 'isReposted', false],
    ['botao-salvo.html', 'isSaved', true],
    ['botao-nao-salvo.html', 'isSaved', false],
  ];
  for (const [file, method, expected] of cases) {
    const { api, article } = openPost(inArticle(FIXTURE(file)));
    const finder = method === 'isSaved' ? api.findSaveButton : api.findRepostButton;
    const svg = finder(article);
    check(`${file.replace('.html', '')} reconhecido`, !!svg, true);
    check(`${file.replace('.html', '')} ${method}`, api[method](svg), expected);
  }
}

async function navegacao() {
  console.log('\n[avançar e fim da lista]');
  const last = openPost(FIXTURE('post-aberto.html'));
  check('"Voltar" presente no post', !!last.win.document.querySelector('svg[aria-label="Voltar"]'), true);
  check('"Voltar" não vira "próximo"', last.api.findNextButton(), null);

  const next = boot(FIXTURE('botao-proximo.html'));
  const button = next.__igCleaner.findNextButton();
  check('avançar encontrado', !!button, true);
  check('avançar é um <button>', button && button.tagName.toLowerCase(), 'button');

  const backOnly = boot(FIXTURE('botao-voltar.html'));
  check('só "Voltar" na árvore não gera próximo', backOnly.__igCleaner.findNextButton(), null);
}

async function grade() {
  console.log('\n[grade]');
  const win = boot(FIXTURE('grade.html'));
  const api = win.__igCleaner;

  const links = api.collectGridLinks(win.document.querySelector('main'));
  check('posts coletados', links.size, 9);
  const [code, href] = [...links][0];
  check('href no formato /user/p/code/', /^\/[^/]+\/(p|reel)\/[^/?#]+\/$/.test(href), true);
  check('chave é o shortcode', code, href.split('/')[3]);
  check('scanGrid vê a grade', api.scanGrid().size, 9);

  const post = boot(FIXTURE('grade.html'), 'https://www.instagram.com/exemplo01/p/AAA111/');
  check('scanGrid ignorado em página de post', post.__igCleaner.scanGrid().size, 0);

  api.state.queue = [];
  const added = api.mergeGrid(
    new Map([
      ['AAA111', '/exemplo01/p/AAA111/'],
      ['ZZZ000', '/exemplo00/p/ZZZ000/'],
    ]),
  );
  check('mergeGrid adiciona novos', added, 2);
  check('mergeGrid é idempotente', api.mergeGrid(new Map([['AAA111', '/exemplo01/p/AAA111/']])), 0);
  check('fila não duplica', api.state.queue.length, 2);

  const whole = await boot(FIXTURE('grade.html')).__igCleaner.loadWholeGrid();
  check('loadWholeGrid pega a grade inteira', whole.size, 9);

  // Grade que só carrega mais posts ao rolar: é o caso real do perfil.
  const card = (n) => `<div class="_ac7v"><a href="/exemplo${n}/p/C${n}/"><img></a></div>`;
  const lazy = boot(Array.from({ length: 5 }, (_, i) => card(i)).join(''));
  lazy.__igCleaner.CONFIG.scrollPause = 20;
  lazy.__igCleaner.CONFIG.scrollPatience = 3;
  let next = 5;
  lazy.scrollBy = () => {
    if (next >= 20) return;
    const batch = Array.from({ length: 5 }, (_, i) => card(next + i)).join('');
    next += 5;
    lazy.document.querySelector('main').insertAdjacentHTML('beforeend', batch);
  };
  const incremental = await lazy.__igCleaner.loadWholeGrid();
  check('acompanha o carregamento por scroll', incremental.size, 20);
}

async function modalConfirmacao() {
  console.log('\n[modal remover dos salvos]');
  const win = boot(FIXTURE('modal-remover-dos-salvos.html'));
  const api = win.__igCleaner;

  const found = api.findConfirmDialog(new Set(), api.CONFIRM_LABELS.save);
  check('modal detectado', !!found, true);
  check('botão escolhido', found && found.button.textContent.trim(), 'Remover');
  check('já existente não conta', api.findConfirmDialog(api.snapshotDialogs(), api.CONFIRM_LABELS.save), null);

  const mixed = openPost(FIXTURE('post-aberto.html') + FIXTURE('modal-remover-dos-salvos.html'));
  const pick = mixed.api.findConfirmDialog(new Set(), mixed.api.CONFIRM_LABELS.save);
  check('não confunde com o botão de salvar do post', pick && pick.button.textContent.trim(), 'Remover');

  const saved = openPost(inArticle(FIXTURE('botao-salvo.html')));
  const saveSvg = saved.api.findSaveButton(saved.article);
  check('save svg com <title>Remover</title> ainda reconhecido', !!saveSvg, true);
  check('aria-label do save', saveSvg.getAttribute('aria-label'), 'Remover');
}

// Simula o React do Instagram: clicar em salvar abre o modal (ou não) e, ao
// confirmar "Remover", o ícone vira o bookmark vazado.
function cenarioUnsave({ comModal }) {
  const { win, api, article } = openPost(inArticle(FIXTURE('botao-salvo.html')));
  const doc = win.document;
  const dialogs = doc.createElement('div');
  article.appendChild(dialogs);

  const swapToUnsaved = () => {
    const outer = article.querySelector('[role="button"]');
    if (outer) outer.outerHTML = FIXTURE('botao-nao-salvo.html');
  };

  article.querySelector('[role="button"]').addEventListener('click', () => {
    if (comModal) dialogs.innerHTML = FIXTURE('modal-remover-dos-salvos.html');
    else swapToUnsaved();
  });

  doc.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('button');
    if (button && button.textContent.trim() === 'Remover') {
      swapToUnsaved();
      dialogs.innerHTML = '';
    }
  });

  return { api, article };
}

async function fluxoUnsave() {
  console.log('\n[fluxo unsave]');

  const semModal = cenarioUnsave({ comModal: false });
  check('desalva direto', await semModal.api.unsave(semModal.article), 'removido');

  const comModal = cenarioUnsave({ comModal: true });
  check('desalva confirmando o modal', await comModal.api.unsave(comModal.article), 'removido');
  check(
    'modal fechou depois de confirmar',
    !!comModal.api.findConfirmDialog(new Set(), comModal.api.CONFIRM_LABELS.save),
    false,
  );
}

(async () => {
  await postAberto();
  await botoesIsolados();
  await navegacao();
  await grade();
  await modalConfirmacao();
  await fluxoUnsave();

  console.log(`\n${failures === 0 ? 'TODOS OS TESTES PASSARAM' : `${failures} FALHA(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
