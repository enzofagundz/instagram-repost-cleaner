// ==UserScript==
// @name         Instagram — Limpar repostagens e salvos
// @namespace    https://github.com/enzo/ig-cleaner
// @version      1.0.0
// @description  Percorre as repostagens de um perfil e remove, post a post, a repostagem e o item salvo.
// @author       enzo
// @match        https://www.instagram.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  if (window.__igCleanerLoaded) return;
  window.__igCleanerLoaded = true;

  const CONFIG = {
    betweenPosts: 1200,
    waitAction: 6000,
    waitPost: 12000,
    waitConfirm: 2500,
    scrollRounds: 150,
    scrollPause: 700,
    scrollPatience: 6,
    navTimeout: 4000,
    logLimit: 40,
  };

  const STORE_KEY = 'ig-cleaner:state:v1';

  // O Instagram troca as classes CSS a cada deploy, mas os `d` dos ícones de ação
  // mudam bem menos. É por eles que sabemos se o post está repostado / salvo.
  const SIG = {
    // setas + check = já repostado; só setas = não repostado
    repostOn: ['-3.905 3.906', 'M16 6.001'],
    repostOff: ['-6.41-3.496', 'M19.998 9.497'],
    // bookmark preenchido (path) vs. vazado (polygon)
    saveOnPrefix: 'M20 22',
    saveOffPoints: '20 21 12 13.44 4 21 4 3 20 3 20 21',
  };

  const POST_PATH = /^(?:\/[^/]+)?\/(?:p|reel)\/([^/?#]+)\/?$/;
  const POST_HREF = /^\/([^/]+)\/(p|reel)\/([^/?#]+)\/?$/;

  // ---------------------------------------------------------------- utilidades

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(check, timeout = CONFIG.waitAction, interval = 150) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let value = null;
      try {
        value = check();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  const labelOf = (svg) =>
    (svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || '')
      .trim()
      .toLowerCase();

  const pathData = (svg) =>
    [...svg.querySelectorAll('path')]
      .map((path) => path.getAttribute('d') || '')
      .join(' ');

  function press(el) {
    const target = el.closest('[role="button"], button, a') || el;
    const rect = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width / 2 || 1,
      clientY: rect.top + rect.height / 2 || 1,
    };
    for (const [Ctor, type] of [
      [PointerEvent, 'pointerover'],
      [MouseEvent, 'mouseover'],
      [PointerEvent, 'pointerdown'],
      [MouseEvent, 'mousedown'],
      [PointerEvent, 'pointerup'],
      [MouseEvent, 'mouseup'],
    ]) {
      if (typeof Ctor !== 'function') continue;
      target.dispatchEvent(new Ctor(type, init));
    }
    target.click();
    return target;
  }

  const isPostPath = () => POST_PATH.test(location.pathname);
  const currentCode = () => location.pathname.match(POST_PATH)?.[1] ?? '';

  // -------------------------------------------------------------------- o post

  function findRepostButton(article) {
    for (const svg of article.querySelectorAll('svg')) {
      if (svg.getAttribute('viewBox') !== '0 0 24 24') continue;
      const d = pathData(svg);
      if (SIG.repostOn.some((s) => d.includes(s))) return svg;
      if (SIG.repostOff.some((s) => d.includes(s))) return svg;
    }
    return null;
  }

  function findSaveButton(article) {
    for (const svg of article.querySelectorAll('svg')) {
      if (svg.getAttribute('viewBox') !== '0 0 24 24') continue;
      const polygon = svg.querySelector('polygon');
      const points = (polygon?.getAttribute('points') || '').replace(/\s+/g, ' ').trim();
      if (points === SIG.saveOffPoints) return svg;
      if (pathData(svg).startsWith(SIG.saveOnPrefix)) return svg;
    }
    return null;
  }

  function findPostArticle() {
    const scopes = [...document.querySelectorAll('div[role="dialog"]'), document];
    for (const scope of scopes) {
      for (const article of scope.querySelectorAll('article')) {
        if (findRepostButton(article) || findSaveButton(article)) return article;
      }
    }
    return null;
  }

  // O post aberto carrega o link do próprio permalink (o do <time>). Serve para
  // confirmar que a navegação para o próximo item realmente aconteceu.
  function articleCodes(article) {
    const codes = new Set();
    if (!article) return codes;
    for (const anchor of article.querySelectorAll('a[href]')) {
      const match = (anchor.getAttribute('href') || '').match(POST_HREF);
      if (match) codes.add(match[3]);
    }
    return codes;
  }

  function matchingArticle(code) {
    const article = findPostArticle();
    if (!article) return null;
    const codes = articleCodes(article);
    return codes.size === 0 || codes.has(code) ? article : null;
  }

  const isReposted = (svg) => !!svg && SIG.repostOn.some((s) => pathData(svg).includes(s));
  const isSaved = (svg) =>
    !!svg && !svg.querySelector('polygon') && pathData(svg).startsWith(SIG.saveOnPrefix);

  // Rótulos completos, não trechos: "Cancelar" nunca pode casar com o
  // "Remover" do modal de confirmação.
  const CONFIRM_LABELS = {
    save: /^(remover|excluir|remove|delete|confirmar|confirm)$/i,
    repost: /^(desfazer|remover|excluir|undo|remove|delete|confirmar|confirm)(\s+\S+)?$/i,
  };
  const CANCEL_LABELS = /^(cancelar|cancel|voltar)$/i;

  // Ignora o conteúdo de <svg>: o botão de salvar carrega o rótulo "Remover"
  // dentro do <title> do ícone e seria confundido com o botão do modal.
  function textOf(el) {
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out += child.nodeValue;
        else if (child.nodeType === 1 && child.tagName.toLowerCase() !== 'svg') walk(child);
      }
    };
    walk(el);
    return out.replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch {
      return true;
    }
  }

  function findDialogButton(scope, pattern) {
    for (const el of scope.querySelectorAll('button, [role="button"], [role="menuitem"]')) {
      const text = textOf(el);
      if (text && text.length <= 40 && pattern.test(text)) return el;
    }
    return null;
  }

  const snapshotDialogs = () =>
    new Set(document.querySelectorAll('[role="dialog"], [role="menu"], div._a9-z'));

  // O modal de "Remover dos itens salvos" (08) não tem role="dialog": chega
  // como `div._a9-y` + `div._a9-z`. Daí o duplo caminho.
  function findConfirmDialog(before, pattern) {
    for (const dialog of document.querySelectorAll('[role="dialog"], [role="menu"]')) {
      if (before.has(dialog) || !isVisible(dialog)) continue;
      const button = findDialogButton(dialog, pattern);
      if (button) return { dialog, button };
    }
    for (const bar of document.querySelectorAll('div._a9-z')) {
      if (before.has(bar) || !isVisible(bar)) continue;
      const box = bar.parentElement;
      const button = box && findDialogButton(box, pattern);
      if (button) return { dialog: box, button };
    }
    return null;
  }

  function cancelDialog(before) {
    for (const el of document.querySelectorAll('[role="dialog"], [role="menu"], div._a9-z')) {
      if (before.has(el) || !isVisible(el)) continue;
      const cancel = findDialogButton(el, CANCEL_LABELS);
      if (cancel) {
        press(cancel);
        return true;
      }
    }
    return false;
  }

  async function waitForEither(first, second, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const a = first();
      if (a) return { side: 'state', value: a };
      const b = second();
      if (b) return { side: 'dialog', value: b };
      if (Date.now() > deadline) return null;
      await sleep(120);
    }
  }

  function findCloseButton() {
    for (const svg of document.querySelectorAll('svg[aria-label]')) {
      const label = labelOf(svg);
      if (label === 'fechar' || label === 'close') return svg;
    }
    return null;
  }

  function dispatchEscape() {
    for (const target of [document, document.body]) {
      if (!target) continue;
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------- ações

  async function unsave(article) {
    const host = findPostArticle() || article;
    const svg = findSaveButton(host);
    if (!svg) return 'sem-botao';
    if (!isSaved(svg)) return 'ja-limpo';
    if (state.dryRun) return 'simulado';

    const before = snapshotDialogs();
    const cleared = () => {
      const again = findSaveButton(findPostArticle() || host);
      return again && !isSaved(again) ? again : null;
    };

    press(svg);

    // Post salvo dentro de coleção abre o modal "Remover dos itens salvos e das
    // coleções?" em vez de desalvar direto. Os dois casos começam com o clique.
    const outcome = await waitForEither(
      cleared,
      () => findConfirmDialog(before, CONFIRM_LABELS.save),
      CONFIG.waitConfirm,
    );
    if (!outcome) return 'falhou';
    if (outcome.side === 'state') return 'removido';

    press(outcome.value.button);
    if (await waitFor(cleared, CONFIG.waitAction)) return 'removido';

    cancelDialog(before);
    return 'falhou';
  }

  async function unrepost(article) {
    const host = findPostArticle() || article;
    const svg = findRepostButton(host);
    if (!svg) return 'sem-botao';
    if (!isReposted(svg)) return 'ja-limpo';
    if (state.dryRun) return 'simulado';

    const before = snapshotDialogs();
    const cleared = () => {
      const again = findRepostButton(findPostArticle() || host);
      return again && !isReposted(again) ? again : null;
    };

    press(svg);

    const outcome = await waitForEither(
      cleared,
      () => findConfirmDialog(before, CONFIRM_LABELS.repost),
      CONFIG.waitConfirm,
    );
    if (!outcome) return 'falhou';
    if (outcome.side === 'state') return 'removido';

    press(outcome.value.button);
    let done = await waitFor(cleared, CONFIG.waitAction);

    if (!done) {
      const second = findConfirmDialog(before, CONFIRM_LABELS.repost);
      if (second) {
        press(second.button);
        done = await waitFor(cleared, CONFIG.waitAction);
      }
    }

    if (!done) {
      cancelDialog(before);
      return 'falhou';
    }
    return 'removido';
  }

  // ----------------------------------------------------------------- grade

  function collectGridLinks(scope) {
    const found = new Map();
    for (const anchor of scope.querySelectorAll('a[href]')) {
      const match = (anchor.getAttribute('href') || '').match(POST_HREF);
      if (!match) continue;
      found.set(match[3], anchor.getAttribute('href'));
    }
    return found;
  }

  function scanGrid() {
    const found = new Map();
    if (isPostPath()) return found;
    for (const scope of [document.querySelector('main'), document.body]) {
      if (!scope) continue;
      for (const [code, href] of collectGridLinks(scope)) found.set(code, href);
    }
    return found;
  }

  // A grade rola na janela ou dentro de um container próprio, depende do
  // layout. Rolar só a janela deixa a lista parada no primeiro lote.
  function findScrollHost() {
    const anchor =
      [...document.querySelectorAll('a[href]')].find((a) =>
        POST_HREF.test(a.getAttribute('href') || ''),
      ) || document.querySelector('a[href]');
    let node = anchor ? anchor.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 40) {
        return node;
      }
      node = node.parentElement;
    }
    return window;
  }

  function scrollDown(host) {
    if (host && host !== window) host.scrollTop += Math.round(host.clientHeight * 0.9);
    window.scrollBy(0, Math.round(window.innerHeight * 0.9));
  }

  function scrollTop(host) {
    if (host && host !== window) host.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  async function loadWholeGrid(onTick) {
    const found = new Map();
    const host = findScrollHost();
    let idle = 0;

    for (let round = 0; round < CONFIG.scrollRounds; round += 1) {
      for (const [code, href] of scanGrid()) found.set(code, href);
      onTick?.(found.size);

      const sizeBefore = found.size;
      const heightBefore = document.body.scrollHeight;
      scrollDown(host);
      await sleep(CONFIG.scrollPause);

      // Contar links não basta: entre um lote e outro a página cresce em
      // altura antes de os links aparecerem.
      const grew = found.size !== sizeBefore || document.body.scrollHeight !== heightBefore;
      idle = grew ? 0 : idle + 1;
      if (idle >= CONFIG.scrollPatience) break;
    }

    scrollTop(host);
    await sleep(300);
    for (const [code, href] of scanGrid()) found.set(code, href);
    return found;
  }

  // A fila cresce durante a execução: um post que já estava na grade pode ter
  // carregado depois da coleta inicial. Tudo que aparecer de novo entra no fim.
  function mergeGrid(links) {
    const known = new Set(state.queue.map((item) => item.code));
    let added = 0;

    for (const [code, href] of links) {
      if (known.has(code)) continue;
      known.add(code);
      state.queue.push({ code, href });
      added += 1;
    }

    if (added) {
      log(`+${added} post(s) novo(s) na fila (total ${state.queue.length})`);
      persist();
      ui?.render();
    }
    return added;
  }

  async function growQueue() {
    if (isPostPath()) return 0;
    return mergeGrid(await loadWholeGrid((count) => ui?.setStatus(`Procurando posts… ${count}`)));
  }

  function findGridAnchor(href) {
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (anchor.getAttribute('href') === href) return anchor;
    }
    return null;
  }

  function softNavigate(href) {
    history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  // ------------------------------------------------------------ paganinação

  function findNextButton() {
    const article = findPostArticle();
    if (article) {
      const rect = article.getBoundingClientRect();
      article.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    }

    const byLabel = [...document.querySelectorAll('svg[aria-label]')].find((svg) =>
      /^(avançar|próximo|next)$/.test(labelOf(svg)),
    );
    if (byLabel) return byLabel.closest('button, [role="button"]') || byLabel;

    // Fallback estrutural: a seta "próximo" é o chevron girado 90° para a
    // direita; a de "voltar" fica em 270°. Sem o aria-label em pt/en, é isso
    // que sobra para diferenciar as duas.
    for (const button of document.querySelectorAll('button._abl-')) {
      const rotated = button.querySelector('span[style*="rotate(90deg)"]');
      if (rotated) return button;
    }
    return null;
  }

  async function tryNextPost() {
    const button = findNextButton();
    if (!button) return false;
    const before = currentCode();
    press(button);
    const moved = await waitFor(() => currentCode() && currentCode() !== before, CONFIG.navTimeout, 200);
    return !!moved;
  }

  async function closePost() {
    if (!isPostPath()) return true;

    const closeSvg = findCloseButton();
    if (closeSvg) press(closeSvg);
    else dispatchEscape();

    let closed = await waitFor(() => !isPostPath(), 3000, 200);
    if (!closed && state.gridPath) {
      history.back();
      closed = await waitFor(() => !isPostPath(), 4000, 250);
    }
    if (closed) await waitFor(() => !findPostArticle(), 4000, 200);
    return !!closed;
  }

  // ------------------------------------------------------------- estado

  const state = {
    running: false,
    paused: false,
    looping: false,
    dryRun: false,
    doRepost: true,
    doSave: true,
    pendingNavigation: false,
    gridPath: '',
    queue: [],
    index: 0,
    stats: { reposts: 0, saves: 0, failures: 0, skipped: 0 },
    retries: {},
    log: [],
  };

  function persist() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          queue: state.queue,
          index: state.index,
          gridPath: state.gridPath,
          stats: state.stats,
          retries: state.retries,
          pendingNavigation: state.pendingNavigation,
          doRepost: state.doRepost,
          doSave: state.doSave,
        }),
      );
    } catch {
      /* localStorage pode estar bloqueado */
    }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      state.queue = Array.isArray(saved.queue) ? saved.queue : [];
      state.index = Number(saved.index) || 0;
      state.gridPath = saved.gridPath || '';
      state.stats = { ...state.stats, ...(saved.stats || {}) };
      state.retries = saved.retries && typeof saved.retries === 'object' ? saved.retries : {};
      state.pendingNavigation = !!saved.pendingNavigation;
      state.doRepost = saved.doRepost !== false;
      state.doSave = saved.doSave !== false;
    } catch {
      /* estado corrompido: começa do zero */
    }
  }

  function log(message) {
    const stamp = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    state.log.unshift(`${stamp}  ${message}`);
    if (state.log.length > CONFIG.logLimit) state.log.length = CONFIG.logLimit;
    ui?.render();
  }

  // ------------------------------------------------------------- execução

  async function processOpenPost() {
    const article = await waitFor(() => findPostArticle(), CONFIG.waitPost);
    if (!article) {
      state.stats.failures += 1;
      log('post não carregou');
      return;
    }

    const code = currentCode() || '?';
    let touched = false;

    if (state.doSave) {
      const result = await unsave(article);
      if (result === 'removido' || result === 'simulado') {
        state.stats.saves += 1;
        touched = true;
        log(`salvo removido · ${code}`);
      } else if (result === 'falhou') {
        state.stats.failures += 1;
        log(`falha ao desalvar · ${code}`);
      }
    }

    if (state.doRepost) {
      const result = await unrepost(article);
      if (result === 'removido' || result === 'simulado') {
        state.stats.reposts += 1;
        touched = true;
        log(`repostagem removida · ${code}`);
      } else if (result === 'falhou') {
        state.stats.failures += 1;
        log(`falha ao desrepostar · ${code}`);
      } else if (result === 'sem-botao' || result === 'ja-limpo') {
        state.stats.skipped += 1;
      }
    }

    if (!touched) log(`nada a fazer · ${code}`);
    ui?.render();
  }

  async function openPost(item) {
    if (isPostPath() && currentCode() === item.code) {
      if (await waitFor(() => matchingArticle(item.code), CONFIG.waitPost, 200)) {
        state.pendingNavigation = false;
        delete state.retries[item.code];
        persist();
        return true;
      }
    }

    // Uma recarga por post; se nem assim abrir, seguir em frente em vez de
    // entrar em laço de reload.
    if (state.retries[item.code] >= 1) {
      delete state.retries[item.code];
      state.stats.failures += 1;
      log(`não abriu ${item.code} — seguindo`);
      return 'skip';
    }

    if (isPostPath()) await closePost();

    state.pendingNavigation = true;
    persist();

    const anchor = findGridAnchor(item.href);
    if (anchor) press(anchor);
    else softNavigate(item.href);

    const article = await waitFor(
      () => (isPostPath() ? matchingArticle(item.code) : null),
      CONFIG.waitPost,
      200,
    );

    if (!article) {
      // A navegação leve não pegou: recarrega na URL do post e retoma de lá.
      state.retries[item.code] = (state.retries[item.code] || 0) + 1;
      persist();
      log(`abrindo direto · ${item.code}`);
      location.assign(item.href);
      return false;
    }

    delete state.retries[item.code];
    state.pendingNavigation = false;
    persist();
    return true;
  }

  async function runLoop() {
    if (state.looping) return;
    state.looping = true;
    try {
      await loop();
    } finally {
      state.looping = false;
    }
  }

  async function loop() {
    for (;;) {
      while (state.running && !state.paused && state.index < state.queue.length) {
        const item = state.queue[state.index];
        ui?.setStatus(`Post ${state.index + 1} de ${state.queue.length}`);

        try {
          const opened = await openPost(item);
          if (opened === false) return;
          if (opened === 'skip') {
            state.index += 1;
            mergeGrid(scanGrid());
            persist();
            ui?.render();
            await sleep(CONFIG.betweenPosts);
            continue;
          }
          await processOpenPost();

          const nextItem = state.queue[state.index + 1];
          if (nextItem && (await tryNextPost()) && currentCode() === nextItem.code) {
            state.index += 1;
            persist();
            ui?.render();
            await sleep(CONFIG.betweenPosts);
            continue;
          }

          await closePost();
        } catch (error) {
          state.stats.failures += 1;
          log(`erro em ${item.code}: ${error.message}`);
        }

        mergeGrid(scanGrid());
        state.index += 1;
        persist();
        ui?.render();
        await sleep(CONFIG.betweenPosts);
      }

      if (!state.running || state.paused || isPostPath()) break;

      // Fila esgotada não significa grade esgotada: rola até o fim antes de
      // dizer que acabou.
      ui?.setStatus('Conferindo se sobrou post…');
      if ((await growQueue()) === 0) break;
    }

    if (state.index >= state.queue.length) {
      state.running = false;
      ui?.setStatus(`Concluído · ${state.queue.length} posts`);
      log(
        `fim · ${state.stats.reposts} reposts, ${state.stats.saves} salvos, ` +
          `${state.stats.failures} falhas em ${state.queue.length} posts`,
      );
    } else if (state.paused) {
      ui?.setStatus('Pausado');
    }
    persist();
    ui?.render();
  }

  async function start() {
    if (state.running) return;
    state.running = true;
    state.paused = false;
    ui?.render();

    const exhausted = state.queue.length > 0 && state.index >= state.queue.length;
    if (!state.queue.length || exhausted) {
      state.stats = { reposts: 0, saves: 0, failures: 0, skipped: 0 };
      state.retries = {};

      if (isPostPath()) {
        state.queue = [{ code: currentCode(), href: location.pathname }];
        state.index = 0;
        log('1 post na fila (página atual)');
      } else {
        ui?.setStatus('Carregando lista…');
        const links = await loadWholeGrid((count) => ui?.setStatus(`Carregando… ${count} posts`));
        state.gridPath = location.pathname;
        state.queue = [...links].map(([code, href]) => ({ code, href }));
        state.index = 0;
        log(`${state.queue.length} posts na fila`);

        if (!state.queue.length) {
          log('nenhum post encontrado — a página está na aba Reposts?');
          state.running = false;
          ui?.setStatus('Nenhum post encontrado');
          persist();
          ui?.render();
          return;
        }
      }
      persist();
    }

    state.running = true;
    ui?.render();
    runLoop();
  }

  function pause() {
    state.paused = !state.paused;
    ui?.setStatus(state.paused ? 'Pausado' : 'Rodando');
    if (!state.paused) {
      state.running = true;
      runLoop();
    }
    ui?.render();
  }

  function stop() {
    state.running = false;
    state.paused = false;
    ui?.setStatus('Parado');
    persist();
    ui?.render();
  }

  function resetQueue() {
    state.running = false;
    state.paused = false;
    state.queue = [];
    state.index = 0;
    state.retries = {};
    state.stats = { reposts: 0, saves: 0, failures: 0, skipped: 0 };
    state.log = [];
    persist();
    ui?.setStatus('Fila limpa');
    ui?.render();
  }

  // ------------------------------------------------------------------- UI

  const ui = (() => {
    const host = document.createElement('div');
    host.id = 'ig-cleaner-root';
    host.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .card {
          width: 306px;
          font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #e6e9ef;
          background: #15171c;
          border: 1px solid #2a2e37;
          border-radius: 12px;
          box-shadow: 0 18px 44px rgba(0, 0, 0, .5);
          overflow: hidden;
        }
        .top {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 12px;
          background: linear-gradient(180deg, #1d2028, #191c22);
          cursor: pointer; user-select: none;
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #4b5262; flex: none; }
        .dot.on { background: #3ddc84; box-shadow: 0 0 0 3px rgba(61, 220, 132, .16); }
        .title { flex: 1; font-weight: 600; letter-spacing: .1px; font-size: 12px; }
        .chev { color: #6b7385; font-size: 10px; }
        .body { padding: 10px 12px 12px; display: grid; gap: 9px; }
        .body.hidden { display: none; }
        .status { color: #9aa3b2; font-variant-numeric: tabular-nums; }
        .stats { display: flex; gap: 6px; }
        .stat {
          flex: 1; padding: 6px 8px; border-radius: 8px;
          background: #1b1e25; border: 1px solid #262a33; text-align: center;
        }
        .stat b { display: block; font-size: 14px; font-variant-numeric: tabular-nums; }
        .stat span { color: #7d8697; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; }
        .toggles { display: grid; gap: 6px; }
        label.t {
          display: flex; align-items: center; gap: 7px; color: #b6bdc9;
          cursor: pointer; font-size: 11.5px;
        }
        input[type=checkbox] { accent-color: #3b82f6; width: 13px; height: 13px; margin: 0; }
        .row { display: flex; gap: 6px; }
        button {
          flex: 1; padding: 7px 8px; border-radius: 8px; cursor: pointer;
          font: inherit; font-weight: 600; font-size: 11.5px;
          border: 1px solid #2e333d; background: #21252d; color: #dde2ea;
          transition: background .12s, border-color .12s;
        }
        button:hover { background: #272c35; border-color: #3a404c; }
        button:disabled { opacity: .4; cursor: default; }
        button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
        button.primary:hover { background: #1d4ed8; }
        button.danger { color: #ff9d9d; }
        .log {
          max-height: 92px; overflow: auto; padding: 7px 8px; border-radius: 8px;
          background: #101216; border: 1px solid #22262e;
          font: 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #8b94a4; white-space: pre-wrap; word-break: break-word;
        }
        .log:empty::before { content: "sem eventos"; color: #4c5464; }
        .log::-webkit-scrollbar { width: 6px; }
        .log::-webkit-scrollbar-thumb { background: #2c313a; border-radius: 3px; }
      </style>
      <div class="card">
        <div class="top">
          <i class="dot"></i>
          <div class="title">Limpar reposts e salvos</div>
          <div class="chev">▾</div>
        </div>
        <div class="body">
          <div class="status" title="Duplo clique limpa a fila">Parado</div>
          <div class="stats">
            <div class="stat"><b data-stat="reposts">0</b><span>reposts</span></div>
            <div class="stat"><b data-stat="saves">0</b><span>salvos</span></div>
            <div class="stat"><b data-stat="failures">0</b><span>falhas</span></div>
          </div>
          <div class="toggles">
            <label class="t"><input type="checkbox" data-opt="repost" checked> Remover repostagens</label>
            <label class="t"><input type="checkbox" data-opt="save" checked> Remover dos salvos</label>
            <label class="t"><input type="checkbox" data-opt="dry"> Simular (não clica)</label>
          </div>
          <div class="row">
            <button class="primary" data-act="start">Iniciar</button>
            <button data-act="pause" disabled>Pausar</button>
            <button class="danger" data-act="stop" disabled>Parar</button>
          </div>
          <div class="log"></div>
        </div>
      </div>
    `;

    const body = root.querySelector('.body');
    const dot = root.querySelector('.dot');
    const statusEl = root.querySelector('.status');
    const logEl = root.querySelector('.log');
    const chev = root.querySelector('.chev');
    const startBtn = root.querySelector('[data-act="start"]');
    const pauseBtn = root.querySelector('[data-act="pause"]');
    const stopBtn = root.querySelector('[data-act="stop"]');

    root.querySelector('.top').addEventListener('click', () => {
      body.classList.toggle('hidden');
      chev.textContent = body.classList.contains('hidden') ? '▸' : '▾';
    });

    root.querySelector('[data-opt="repost"]').addEventListener('change', (event) => {
      state.doRepost = event.target.checked;
      persist();
    });
    root.querySelector('[data-opt="save"]').addEventListener('change', (event) => {
      state.doSave = event.target.checked;
      persist();
    });
    root.querySelector('[data-opt="dry"]').addEventListener('change', (event) => {
      state.dryRun = event.target.checked;
    });

    startBtn.addEventListener('click', () => start());
    pauseBtn.addEventListener('click', () => pause());
    stopBtn.addEventListener('click', () => stop());
    root.querySelector('.status').addEventListener('dblclick', () => resetQueue());

    function render() {
      for (const [key, value] of Object.entries(state.stats)) {
        const el = root.querySelector(`[data-stat="${key}"]`);
        if (el) el.textContent = String(value);
      }
      logEl.textContent = state.log.slice(0, 8).join('\n');

      const active = state.running && !state.paused;
      dot.className = `dot${active ? ' on' : ''}`;
      startBtn.disabled = state.running;
      pauseBtn.disabled = !state.running;
      pauseBtn.textContent = state.paused ? 'Retomar' : 'Pausar';
      stopBtn.disabled = !state.running;

      root.querySelector('[data-opt="repost"]').checked = state.doRepost;
      root.querySelector('[data-opt="save"]').checked = state.doSave;
      root.querySelector('[data-opt="dry"]').checked = state.dryRun;
    }

    function setStatus(text) {
      statusEl.textContent = text;
    }

    render();
    return { render, setStatus };
  })();

  // ----------------------------------------------------------------- início

  // Gancho de depuração: permite inspecionar seletores e estado pelo console.
  window.__igCleaner = {
    state,
    CONFIG,
    start,
    stop,
    pause,
    resetQueue,
    findPostArticle,
    articleCodes,
    matchingArticle,
    findRepostButton,
    findSaveButton,
    findNextButton,
    findConfirmDialog,
    snapshotDialogs,
    CONFIRM_LABELS,
    unsave,
    unrepost,
    isReposted,
    isSaved,
    collectGridLinks,
    scanGrid,
    mergeGrid,
    findScrollHost,
    loadWholeGrid,
  };

  restore();
  if (state.queue.length) {
    ui.setStatus(`Fila salva: ${state.index}/${state.queue.length} — clique Iniciar`);
    log(`${state.queue.length} posts na fila salva`);
  }

  if (state.pendingNavigation) {
    log('retomando após recarregar a página…');
    setTimeout(() => start(), 2000);
  }
})();
