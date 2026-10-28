# Instagram — limpar repostagens e salvos

Userscript para ViolentMonkey que percorre a aba **Reposts** de um perfil e remove, post a post, a repostagem e o item salvo.

```
instagram-limpar-reposts-salvos.user.js   script final (colar no ViolentMonkey)
test/selectors.test.js                    testes dos seletores
test/fixtures/                            HTML de exemplo, sintético
elements-reference/                       snapshots reais do DOM (local, fora do git)
```

## Instalação

1. Abra o painel do ViolentMonkey → **+** → *Instalar de um arquivo* e escolha `instagram-limpar-reposts-salvos.user.js` (ou cole o conteúdo em *Novo script*).
2. Abra `https://www.instagram.com/<seu-perfil>/reposts/`.
3. Clica em **Iniciar** no painel no canto inferior direito.

## Como usar

- **Remover repostagens** / **Remover dos salvos** — escolha o que apagar em cada post.
- **Simular** — não clica em nada, só registra o que faria. Bom para uma primeira passada.
- **Iniciar** — se a fila ainda não existe, rola a grade até o fim, monta a lista de posts e começa.
- **Pausar / Retomar** — para depois do post atual.
- **Parar** — interrompe; a fila fica salva e continua de onde parou no próximo *Iniciar*.
- Duplo clique no texto de status limpa a fila e os contadores.

O progresso (fila, índice, contadores) vai para o `localStorage` em `ig-cleaner:state:v1`. Se precisar recomeçar do zero:

```js
localStorage.removeItem('ig-cleaner:state:v1')
```

## Fluxo

```
[aba Reposts]
   │  rola até o fim da grade, coleta { shortcode, href } de cada post
   ▼
para cada post:
   ├─ abre o post (clique no link da grade; se não rolar, recarrega na URL)
   │     └─ confere pelo permalink do <time> se abriu mesmo o post da fila
   ├─ desalva, se estiver salvo        (confere o "d" do ícone de bookmark)
   │     └─ se abrir "Remover dos itens salvos e das coleções?", confirma em Remover
   ├─ desreposta, se estiver repostado (trata o menu de confirmação)
   ├─ se o botão "Avançar" aparecer e levar exatamente ao próximo da fila, usa ele
   ├─ senão fecha o post e volta para a grade
   └─ relê a grade e põe no fim da fila qualquer post que tenha carregado depois
   ▼
fila esgotada → rola a grade até o fim de novo; se apareceu post novo, continua
```

Ordem importa: **salvo primeiro, repost depois**. Desrepostar pode tirar o post da lista de Reposts e fechar o visualizador — depois disso o botão de salvar já não estaria acessível.

O atalho do botão "Avançar" só é aceito quando o post em que ele cai é exatamente o próximo da fila. Se o Instagram pular para outro lugar (a lista muda quando um repost é removido), o script fecha e abre o próximo pelo link, que é determinístico.

### A fila cresce durante a execução

A grade do Instagram carrega por partes e muda de tamanho enquanto você remove reposts. Por isso a fila não é fechada no início:

- **a cada post processado**, a grade visível é relida e o que for desconhecido entra no fim da fila;
- **quando a fila acaba**, o script rola a grade até o fim mais uma vez antes de dizer "Concluído";
- a varredura não desiste no primeiro lote: ela considera a página crescendo em altura, não só a contagem de links, e espera 6 rodadas sem novidade antes de parar;
- o scroll é aplicado no container que de fato rola (a janela ou um `div` com `overflow-y`), não só na janela.

### Confirmação ao desalvar

Um post salvo que também está numa coleção não desalva direto: abre um modal com o título *"Remover dos itens salvos e das coleções?"* e os botões **Remover** e **Cancelar**. O script espera o resultado do clique por dois caminhos ao mesmo tempo — ícone virou bookmark vazado, ou apareceu modal de confirmação — e só então confirma em *Remover*.

Duas armadilhas que esse modal trouxe:

- Ele **não** vem embrulhado em `role="dialog"`. Chega como `div._a9-y` (texto) + `div._a9-z` (botões), então o script procura os dois formatos.
- O botão de salvar do post carrega `<svg><title>Remover</title></svg>`. Se o texto fosse lido com `textContent`, o script clicaria no próprio botão de salvar de novo. O `textOf()` quebra a árvore ignorando `<svg>` inteiro.

## Seletores

O Instagram troca classes CSS a cada deploy. O script **não** depende delas para decidir estado — usa os `d` dos ícones, que mudam bem menos.

| Referência | O que identifica |
| --- | --- |
| `03-botao-republicado.html` | repost **ativo**: `d` contém `-3.905 3.906` (setas + check) |
| `05-botao-nao-republicado.html` | repost **inativo**: `d` contém `-6.41-3.496` (só setas) |
| `03-botao-salvo.html` | salvo: `<path d="M20 22…">` (bookmark preenchido) |
| `04-botao-nao-salvo.html` | não salvo: `<polygon points="20 21 12 13.44 …">` |
| `01-grid-republicados.html` | grade: `a[href]` casando `/<user>/(p|reel)/<code>/` |
| `02-republicado-aberto.html` | post aberto: o `<article>` que contém os botões de salvar/repostar |
| `06-botao-proximo-post.html` | próximo: `svg[aria-label="Avançar"]`, ou o `button._abl-` com chevron em `rotate(90deg)` |
| `07-ultimo-republicado.html` | fim da lista: não existe "Avançar" (só o "Voltar", girado 270°) |
| `08-modal-confirmar-remocao.html` | confirmação ao desalvar: `div._a9-z` com `Remover` / `Cancelar` |

Detalhe importante do `02`: o cabeçalho do post também tem um ícone de repost (22×22, com gradiente). O script filtra por `viewBox="0 0 24 24"` para pegar só o botão da barra de ações.

Se um deploy do Instagram quebrar a detecção, o console serve para inspecionar:

```js
__igCleaner.findPostArticle()      // <article> do post aberto
__igCleaner.findRepostButton(a)    // svg do repost dentro dele
__igCleaner.isReposted(svg)        // true/false
__igCleaner.findSaveButton(a)
__igCleaner.isSaved(svg)
__igCleaner.findConfirmDialog(__igCleaner.snapshotDialogs(), __igCleaner.CONFIRM_LABELS.save)
__igCleaner.scanGrid()             // Map(shortcode → href) do que está na grade agora
__igCleaner.state                  // fila, índice, contadores
__igCleaner.CONFIG                 // tempos; dá para ajustar pelo console
```

## Limitações conhecidas

- Se o Instagram abrir um menu de confirmação ao desrepostar, o script procura por *desfazer / remover / undo* dentro do diálogo novo. Outro texto exige ajuste em `CONFIRM_LABELS.repost`.
- Reels que abrem em `/reel/<code>/` (sem o usuário na URL) são reconhecidos, mas o visualizador de reels tem botões próprios — vale rodar uma vez em **Simular** antes.
- Cada post custa ~1,5 s de espera, mais a varredura final da grade. 40 posts dão por volta de um minuto e meio.
- Se um post não abrir nem pelo link nem por recarga direta, o script registra a falha e segue — não insiste para não entrar em laço de reload.

## Testes

Os testes rodam em jsdom contra `test/fixtures/`: marcação com a mesma estrutura do Instagram, mas **sintética** — nenhum post, conta ou imagem real. Só o que interessa é fiel: os `d` dos ícones, o `points` do bookmark, o `viewBox`, as classes do modal.

```bash
npm install && npm test
```

### `elements-reference/` é local

A pasta com os snapshots copiados do Instagram **não vai para o git** — eles carregam publicações reais, handles de terceiros e URLs de CDN. Ela serve só como material de consulta quando o Instagram muda o DOM: você captura de novo, deriva a assinatura nova e atualiza `test/fixtures/` com a marcação limpa.

O jeito de fazer isso: abra o post, inspecione o ícone, copie o `d` do `<path>` e compare com o que está em `SIG`, no topo do script.
