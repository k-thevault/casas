/*
 * Vigia diário das casas — roda por cron da Vercel, custo ~zero.
 *
 * O vigia semanal varre o mercado atrás de novidade. Este aqui faz só uma
 * coisa: todo dia confere se as casas que estão no ar continuam de pé, e avisa
 * NO DIA em que uma sai — não na segunda seguinte.
 *
 * ===================================================================
 * REESCRITO EM 31/07/2026 — por que
 * ===================================================================
 *
 * A versão anterior cortava a fila em 14 itens com um .slice() SEM RODÍZIO.
 * Como a ordem vem do Baserow por id, eram sempre as mesmas 14 primeiras: 25
 * favoritas nunca chegavam a ser checadas, nenhum dia. Três delas já estavam
 * mortas havia dias e seguiam no site (Zuleika Jabour em Salto, Bosques dos
 * Ipês em Tatuí e um Euroville em Bragança).
 *
 * Agora são três passes, do grátis para o caro, e TODA casa passa por pelo
 * menos um deles todo dia:
 *
 *   PASSE 1 — fetch direto, grátis, em todas, em paralelo. Resolve de vez
 *             quem responde 404/410 (morta) e 200 limpo (viva). ~5 segundos.
 *
 *   PASSE 2 — r.jina.ai (proxy de leitura, grátis e sem chave) para o que o
 *             passe 1 não conseguiu abrir. VivaReal e OLX ficam atrás do
 *             Cloudflare e devolvem 403 para qualquer script — vivos ou
 *             mortos, sempre 403 — e são 2/3 do catálogo. Sem este passe,
 *             confirmar todos por API paga custaria ~870 créditos/mês.
 *
 *   PASSE 3 — Firecrawl/scrape.do, pago, só para o resíduo que os dois
 *             primeiros não decidiram. Tem teto por execução e rodízio
 *             diário: quem não coube hoje entra primeiro amanhã.
 *
 * ===================================================================
 * A REGRA QUE NÃO PODE SER RELAXADA
 * ===================================================================
 *
 * Declarar morte a partir de texto de página é perigoso, e já custou caro
 * duas vezes:
 *
 *  1. Vários CMS de imobiliária (Kenlo/Imoview e afins) trazem "imóvel
 *     indisponível" escondido no template, em TODA página — inclusive na home
 *     e em anúncios vivos. Isso derrubou 10 casas boas de uma vez.
 *  2. O VivaReal serve a página "Oops, não conseguimos encontrar" de forma
 *     intermitente, em anúncio que está vivo. Medido em 31/07: a mesma casa
 *     (Parque Nova Suíça, Valinhos) deu "Oops" numa leitura e a ficha
 *     completa na seguinte.
 *
 * Por isso: 404/410 condena sozinho, porque é inequívoco. QUALQUER veredito
 * por texto exige segunda leitura independente (o r.jina.ai cacheia, então a
 * confirmação vai com x-no-cache) e as duas têm que concordar. Se
 * discordarem, o estado é "incerto" — e incerto NUNCA apaga casa.
 */

import { scrapeDo } from "../lib/scrapedo.js";

const BASEROW_URL = (process.env.BASEROW_URL || "").replace(/\/$/, "");
const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const BASEROW_TABLE = process.env.BASEROW_TABLE;
/* Duas contas: quando a primeira fica sem crédito (Firecrawl responde 402),
 * cai na segunda automaticamente. A ordem é a das env vars. */
const FIRECRAWL_KEYS = [
  process.env.FIRECRAWL_API_KEY,
  process.env.FIRECRAWL_API_KEY_2,
].filter(Boolean);
const CRON_SECRET = process.env.CRON_SECRET;

const EVO_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCIA = process.env.EVOLUTION_INSTANCE;
const PARA = process.env.WHATSAPP_TO;

/* Cabeçalho de navegador de verdade. Não engana VivaReal/OLX (que barram por
 * impressão digital de TLS, não por User-Agent), mas resolve o 403 de site de
 * imobiliária pequena que só filtra robô pelo cabeçalho. */
const CABECALHOS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Upgrade-Insecure-Requests": "1",
};

/* Teto de gasto por execução, ajustável por env var sem precisar de deploy.
 * Só o passe 3 gasta. Baixo de propósito: em 31/07/2026 a conta 1 do
 * Firecrawl estava em -9 de 1000 créditos/mês, queimados pela vigia semanal. */
const MAX_PAGO = Number(process.env.VIGIA_MAX_PAGO || 6);

/* A função tem maxDuration 300s (vercel.json). Paramos antes para sobrar
 * tempo de gravar no Baserow e mandar o WhatsApp com folga. */
const PRAZO_MS = 250000;
const CONCORRENCIA_DIRETA = 8;
/* O r.jina.ai sem chave limita o ritmo: 8 em voo toma 429 na hora, 3 toma na
 * cauda. Com 2 em voo mais a repetição do lerPeloJina, a fila inteira passa. */
const CONCORRENCIA_JINA = 2;
const CONCORRENCIA_PAGA = 3;
const TIMEOUT_FETCH_MS = 12000;
const TIMEOUT_JINA_MS = 45000;

/* Frases de morte para HTML cru e para o markdown do Firecrawl. Nenhuma delas
 * condena sozinha — ver "A REGRA QUE NÃO PODE SER RELAXADA" no topo. */
const SINAIS_MORTE = [
  "imóvel não encontrado",
  "imovel nao encontrado",
  "anúncio removido",
  "anuncio removido",
  "anúncio não está mais disponível",
  "não está mais disponível",
  "nao esta mais disponivel",
  "imóvel indisponível",
  "imovel indisponivel",
  "este imóvel foi alugado",
  "imóvel já alugado",
  "página não encontrada",
  "pagina nao encontrada",
];

/* Marcas da página de "não encontrado" de VivaReal e OLX, medidas em produção
 * em 31/07/2026. São específicas da tela de erro dos dois portais — não
 * aparecem em anúncio vivo, ao contrário das frases genéricas acima, que vivem
 * em rodapé de imobiliária. Ainda assim exigem segunda leitura. */
const SINAIS_MORTE_PORTAL = [
  "não conseguimos encontrar a página",
  "nao conseguimos encontrar a pagina",
  "vi_not_found_web",
  "adview_not_found",
];

function baserow(path, options = {}) {
  return fetch(`${BASEROW_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Token ${BASEROW_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function lerCatalogo() {
  const linhas = [];
  let page = 1;
  while (page <= 20) {
    const r = await baserow(
      `/api/database/rows/table/${BASEROW_TABLE}/?user_field_names=true&size=200&page=${page}`
    );
    if (!r.ok) throw new Error("leitura");
    const d = await r.json();
    linhas.push(...d.results);
    if (!d.next) break;
    page++;
  }
  return linhas;
}

/* Roda `fn` sobre `itens` com no máximo `n` em voo. Sem isso, 43 fetches em
 * série estouram o prazo; e todos de uma vez derrubam site pequeno. */
async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhador));
  return saida;
}

/* Scrape no Firecrawl com failover entre contas. Só o 402 (crédito esgotado)
 * troca de conta — bloqueio de site (403/404/429) falharia igual nas duas, e
 * o 429 é rate limit, não falta de crédito. Devolve {ok, status, data, conta}. */
async function firecrawlScrape(payload) {
  let ultimo = { ok: false, status: 0, data: null, conta: 0 };
  for (let i = 0; i < FIRECRAWL_KEYS.length; i++) {
    let r, d;
    try {
      r = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${FIRECRAWL_KEYS[i]}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      d = await r.json().catch(() => null);
    } catch (e) {
      ultimo = { ok: false, status: 0, data: null, conta: i + 1 };
      continue; /* rede falhou nesta conta; tenta a próxima */
    }
    if (r.ok) return { ok: true, status: r.status, data: d?.data ?? null, conta: i + 1 };
    if (r.status === 402) {
      ultimo = { ok: false, status: 402, data: null, conta: i + 1 };
      continue; /* sem crédito: cai pra próxima conta */
    }
    /* outro erro (403/404/429/5xx): não é crédito, não adianta trocar. */
    return { ok: false, status: r.status, data: d?.data ?? null, conta: i + 1 };
  }
  return ultimo; /* todas as contas sem crédito (ou vazias) */
}

/*
 * PASSE 1 — fetch direto, grátis. Devolve {estado, http, motivo}.
 * estado: 'morto' | 'vivo' | 'suspeita' | 'bloqueado'.
 * Só o 404/410 condena aqui; frase suspeita vira 'suspeita' e vai para o
 * passe 3, onde o onlyMainContent do Firecrawl descarta menu e rodapé.
 */
export async function checarDireto(url) {
  try {
    const r = await fetch(url, {
      headers: CABECALHOS,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_FETCH_MS),
    });
    if (r.status === 404 || r.status === 410) {
      return { estado: "morto", http: r.status, motivo: `página responde ${r.status}` };
    }
    if (r.ok) {
      const html = (await r.text()).toLowerCase();
      if (html.length < 3000) {
        return { estado: "bloqueado", http: r.status, motivo: "página veio quase vazia" };
      }
      const achou = SINAIS_MORTE.find((s) => html.includes(s));
      if (!achou) return { estado: "vivo", http: r.status };
      return { estado: "suspeita", http: r.status, motivo: `o HTML diz "${achou}"` };
    }
    return { estado: "bloqueado", http: r.status, motivo: `portal devolveu ${r.status}` };
  } catch (e) {
    return {
      estado: "bloqueado",
      http: null,
      motivo: e.name === "TimeoutError" ? "site não respondeu a tempo" : "rede falhou",
    };
  }
}

const espera = (ms) => new Promise((s) => setTimeout(s, ms));

/* O r.jina.ai sem chave limita o ritmo e devolve 429 na cauda de uma fila
 * grande. Medido em 31/07: 6 das 29 casas voltaram 429 na primeira tentativa e
 * passaram na segunda. 429 é ritmo, não resposta do site — insiste, senão a
 * casa cai no passe pago sem precisar e queima crédito à toa. */
async function lerPeloJina(url, semCache) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch("https://r.jina.ai/" + url, {
      headers: semCache ? { "x-no-cache": "true" } : {},
      signal: AbortSignal.timeout(TIMEOUT_JINA_MS),
    });
    if (r.ok) return { ok: true, status: r.status, texto: (await r.text()).toLowerCase() };
    if (r.status !== 429) return { ok: false, status: r.status, texto: "" };
    await espera(4000 * (tentativa + 1));
  }
  return { ok: false, status: 429, texto: "" };
}

/*
 * PASSE 2 — r.jina.ai, grátis. Devolve {estado, via, motivo}.
 * estado: 'morto' | 'vivo' | 'incerto'.
 *
 * Duas leituras quando cheira a morte: a primeira pode vir do cache do jina,
 * e foi exatamente um cache de blip do VivaReal que quase matou uma casa viva.
 * A segunda vai com x-no-cache e precisa concordar.
 */
export async function checarPeloJina(url) {
  let primeira;
  try {
    primeira = await lerPeloJina(url, false);
  } catch (e) {
    return { estado: "incerto", via: "jina", motivo: "r.jina.ai não respondeu" };
  }
  if (!primeira.ok) {
    return { estado: "incerto", via: "jina", motivo: `r.jina.ai devolveu ${primeira.status}` };
  }
  if (primeira.texto.length < 700) {
    return { estado: "incerto", via: "jina", motivo: "leitura veio curta demais" };
  }

  const achou = SINAIS_MORTE_PORTAL.find((s) => primeira.texto.includes(s));
  if (!achou) return { estado: "vivo", via: "jina" };

  /* Cheirou a morte: confirma com leitura nova, sem cache. */
  let segunda;
  try {
    segunda = await lerPeloJina(url, true);
  } catch (e) {
    return { estado: "incerto", via: "jina", motivo: `suspeita de "${achou}", 2ª leitura falhou` };
  }
  if (!segunda.ok) {
    return { estado: "incerto", via: "jina", motivo: `suspeita de "${achou}", 2ª leitura deu ${segunda.status}` };
  }
  if (SINAIS_MORTE_PORTAL.some((s) => segunda.texto.includes(s))) {
    return { estado: "morto", via: "jina", motivo: `a página do portal diz "${achou}" (confirmado em 2 leituras)` };
  }
  /* As duas discordaram: é o blip intermitente do portal. Não apaga nada. */
  return { estado: "incerto", via: "jina", motivo: `"${achou}" na 1ª leitura, mas a 2ª abriu o anúncio — blip do portal` };
}

/*
 * PASSE 3 — pago, 1 crédito. Devolve {estado, via, http, motivo}.
 * 'incerto' nunca marca nada — bloqueio de portal não é anúncio removido.
 */
async function confirmarPago(url) {
  if (!FIRECRAWL_KEYS.length && !process.env.SCRAPEDO_TOKEN) {
    return { estado: "incerto", via: "nenhum", motivo: "sem chave de nenhum motor" };
  }
  try {
    const fc = FIRECRAWL_KEYS.length
      ? await firecrawlScrape({ url, formats: ["markdown"], onlyMainContent: true })
      : { ok: false, status: 402, data: null };

    if (!fc.ok || !fc.data) {
      /* Sem crédito nas duas contas: tenta o scrape.do, mas com a mão MUITO
       * mais leve. Ele não tem onlyMainContent, então o markdown vem com menu,
       * rodapé e template — e é justamente aí que mora o "imóvel indisponível"
       * fantasma que já matou 10 casas vivas de uma vez. Portanto, por este
       * caminho só o 404/410 condena; frase suspeita vira "incerto" e espera
       * o crédito voltar. Custa 1 crédito. */
      if (fc.status === 402) {
        const sd = await scrapeDo(url, { maxDegrau: 1, timeoutMs: 20000 });
        if (sd.ok && (sd.status === 404 || sd.status === 410)) {
          return { estado: "morto", via: "scrape.do", http: sd.status, motivo: `página responde ${sd.status}` };
        }
        if (sd.ok) return { estado: "vivo", via: "scrape.do", http: sd.status };
        return { estado: "incerto", via: "scrape.do", motivo: `Firecrawl sem crédito e ${sd.motivo}` };
      }
      return { estado: "incerto", via: "firecrawl", motivo: `Firecrawl devolveu ${fc.status}` };
    }

    const http = fc.data.metadata?.statusCode ?? null;
    if (http === 404 || http === 410) {
      return { estado: "morto", via: "firecrawl", http, motivo: `página responde ${http}` };
    }
    const md = (fc.data.markdown || "").toLowerCase();
    const achou = SINAIS_MORTE.find((s) => md.includes(s));
    if (achou) return { estado: "morto", via: "firecrawl", http, motivo: `a página diz "${achou}"` };
    if (md.length < 400) {
      return { estado: "incerto", via: "firecrawl", http, motivo: "conteúdo veio vazio" };
    }
    return { estado: "vivo", via: "firecrawl", http };
  } catch (e) {
    return { estado: "incerto", via: "firecrawl", motivo: "erro ao falar com o Firecrawl" };
  }
}

async function marcarMorta(linha, motivo) {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const dados = {
    title: ("🚫 INDISPONÍVEL — " + (linha.title || "")).slice(0, 4000),
    ficha: (
      (linha.ficha || "") +
      ` || 🚫 INDISPONÍVEL em ${hoje}: ${motivo}. Detectado pelo vigia diário. ` +
      `Se o anúncio voltar, é só desocultar e apagar este aviso.`
    ).slice(0, 4000),
    hidden: true,
  };
  const r = await baserow(
    `/api/database/rows/table/${BASEROW_TABLE}/${linha.id}/?user_field_names=true`,
    { method: "PATCH", body: JSON.stringify(dados) }
  );
  if (!r.ok) throw new Error(`Baserow devolveu ${r.status}`);
}

/* Devolve {ok, detalhe}. O detalhe vai para a resposta JSON porque um
 * "avisado: false" mudo não diz se faltou variável, se a instância caiu ou se
 * o número foi recusado — e sem o WhatsApp a casa sai do site em silêncio. */
/*
 * Batida do vigia: uma linha de controle no Baserow (uid "_vigia") com a hora
 * da última execução. É o que permite o site dizer "faz X horas que não rodo".
 *
 * Por que uma linha e não um campo novo: o token do Baserow é de banco de
 * dados, faz CRUD de linha mas não cria campo. E por que isso importa: sem
 * batida, um cron quebrado é invisível — o site segue mostrando o catálogo de
 * ontem com cara de atualizado, que é exatamente o problema que esta rotina
 * existe para resolver.
 *
 * A linha vai com hidden=true e é filtrada no /api/casas, então nunca aparece
 * como se fosse casa.
 */
async function registrarBatida(resumo) {
  const agora = new Date().toISOString();
  const dados = {
    uid: "_vigia",
    title: "⏱️ controle do vigia diário (não é uma casa)",
    nota: agora,
    ficha: resumo.slice(0, 4000),
    hidden: true,
  };
  const busca = await baserow(
    `/api/database/rows/table/${BASEROW_TABLE}/?user_field_names=true&filter__uid__equal=_vigia&size=1`
  );
  if (!busca.ok) throw new Error(`busca da linha de controle: ${busca.status}`);
  const achou = (await busca.json()).results?.[0];
  const r = achou
    ? await baserow(`/api/database/rows/table/${BASEROW_TABLE}/${achou.id}/?user_field_names=true`, {
        method: "PATCH",
        body: JSON.stringify(dados),
      })
    : await baserow(`/api/database/rows/table/${BASEROW_TABLE}/?user_field_names=true`, {
        method: "POST",
        body: JSON.stringify(dados),
      });
  if (!r.ok) throw new Error(`gravação da linha de controle: ${r.status}`);
  return agora;
}

async function avisar(texto) {
  const faltando = [
    !EVO_URL && "EVOLUTION_URL",
    !EVO_KEY && "EVOLUTION_API_KEY",
    !EVO_INSTANCIA && "EVOLUTION_INSTANCE",
    !PARA && "WHATSAPP_TO",
  ].filter(Boolean);
  if (faltando.length) return { ok: false, detalhe: `faltam variáveis: ${faltando.join(", ")}` };
  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCIA}`, {
      method: "POST",
      headers: { apikey: EVO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ number: PARA, text: texto }),
    });
    if (r.ok) return { ok: true, detalhe: `enviado (${r.status})` };
    const corpo = await r.text().catch(() => "");
    return { ok: false, detalhe: `Evolution devolveu ${r.status}: ${corpo.slice(0, 300)}` };
  } catch (e) {
    return { ok: false, detalhe: `rede falhou ao falar com a Evolution: ${e.message}` };
  }
}

/* Só consulta o estado da instância — não manda mensagem nenhuma. Serve para
 * saber se o WhatsApp está de pé sem torrar a paciência dela com teste. */
async function estadoDoWhatsApp() {
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCIA) return { erro: "faltam variáveis da Evolution" };
  const sondar = async (caminho, comChave) => {
    try {
      const r = await fetch(`${EVO_URL}${caminho}`, { headers: comChave ? { apikey: EVO_KEY } : {} });
      const corpo = await r.text().catch(() => "");
      return { http: r.status, corpo: corpo.slice(0, 300) };
    } catch (e) {
      return { erro: e.message };
    }
  };
  return {
    host: (() => { try { return new URL(EVO_URL).host; } catch { return "URL inválida"; } })(),
    instancia: EVO_INSTANCIA,
    servidor_de_pe: await sondar("/", false),
    com_chave: await sondar(`/instance/connectionState/${EVO_INSTANCIA}`, true),
    lista_instancias: await sondar("/instance/fetchInstances", true),
  };
}

const rotulo = (l) => `${l.city || "?"} — ${l.cond || l.title || "sem nome"}`;

export default async function handler(req, res) {
  const t0 = Date.now();
  const noPrazo = () => Date.now() - t0 < PRAZO_MS;

  /* A Vercel manda o CRON_SECRET no Authorization. Sem isso, qualquer um que
   * achasse a URL poderia disparar a rotina (e gastar crédito). */
  const auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  if (!BASEROW_URL || !BASEROW_TOKEN || !BASEROW_TABLE) {
    return res.status(500).json({ error: "Faltam as variáveis do Baserow." });
  }

  /* ?diag=1 — só checa se o WhatsApp está conectado. Não varre nada, não
   * gasta crédito e não manda mensagem. */
  if (req.query?.diag === "1") {
    return res.status(200).json({ whatsapp: await estadoDoWhatsApp() });
  }

  let linhas;
  try {
    linhas = await lerCatalogo();
  } catch (e) {
    return res.status(502).json({ error: "Não consegui ler o catálogo." });
  }

  /* Tudo que está no ar para ela, mais as favoritas (ainda que ocultas).
   * O que ela descartou (oculto e não favorito) fica de fora: não interessa se
   * continua anunciado. O que já foi marcado 🚫 também — já está resolvido. */
  const fila = linhas
    .filter((l) => l.url)
    .filter((l) => !String(l.title || "").startsWith("🚫"))
    .filter((l) => !l.hidden || l.fav);

  const mortasAgora = [];
  const incertas = [];
  let vivas = 0;

  /* ---------- PASSE 1: fetch direto, em todas ---------- */
  const direto = await emParalelo(fila, CONCORRENCIA_DIRETA, (l) => checarDireto(l.url));

  const paraJina = [];
  const suspeitas = [];
  fila.forEach((l, i) => {
    const r = direto[i];
    if (r.estado === "morto") mortasAgora.push({ linha: l, motivo: r.motivo });
    else if (r.estado === "vivo") vivas++;
    else if (r.estado === "suspeita") suspeitas.push({ linha: l, r });
    else paraJina.push({ linha: l, r });
  });

  /* ---------- PASSE 2: r.jina.ai nos bloqueados ---------- */
  const viaJina = await emParalelo(paraJina, CONCORRENCIA_JINA, async (item) => {
    if (!noPrazo()) return { estado: "incerto", via: "prazo", motivo: "acabou o tempo da execução" };
    return checarPeloJina(item.linha.url);
  });

  const sobrou = [];
  paraJina.forEach((item, i) => {
    const r = viaJina[i];
    if (r.estado === "morto") mortasAgora.push({ linha: item.linha, motivo: r.motivo });
    else if (r.estado === "vivo") vivas++;
    else sobrou.push({ linha: item.linha, motivo: `${item.r.motivo}; ${r.motivo}` });
  });

  /* ---------- PASSE 3: pago, com teto e rodízio ----------
   * Suspeita entra sempre — é morte provável, e é justamente o caso em que só
   * o onlyMainContent decide. O resíduo do passe 2 entra por rodízio diário:
   * a ordem gira um item por dia, então ninguém fica eternamente no fim da
   * fila (o bug que motivou esta reescrita). */
  const dia = Math.floor(Date.now() / 86400000);
  const giro = sobrou.length ? dia % sobrou.length : 0;
  const rodizio = sobrou.slice(giro).concat(sobrou.slice(0, giro));

  const candidatos = [
    ...suspeitas.map((s) => ({ linha: s.linha, motivo: s.r.motivo })),
    ...rodizio,
  ];
  const paraPagar = candidatos.slice(0, Math.max(0, MAX_PAGO));
  const foraDoTeto = candidatos.slice(Math.max(0, MAX_PAGO));

  let creditos_firecrawl = 0;
  let creditos_scrapedo = 0;

  const pagos = await emParalelo(paraPagar, CONCORRENCIA_PAGA, async (item) => {
    if (!noPrazo()) return { estado: "incerto", via: "prazo", motivo: "acabou o tempo da execução" };
    return confirmarPago(item.linha.url);
  });

  paraPagar.forEach((item, i) => {
    const r = pagos[i];
    if (r.via === "firecrawl") creditos_firecrawl++;
    if (r.via === "scrape.do") creditos_scrapedo++;
    if (r.estado === "morto") mortasAgora.push({ linha: item.linha, motivo: r.motivo });
    else if (r.estado === "vivo") vivas++;
    else incertas.push(`${rotulo(item.linha)} (${item.motivo}; ${r.motivo})`);
  });

  for (const item of foraDoTeto) {
    incertas.push(`${rotulo(item.linha)} (${item.motivo}; fora do teto pago de hoje, entra primeiro amanhã)`);
  }

  /* ---------- Gravação ---------- */
  const mortas = [];
  const falhas = [];
  for (const m of mortasAgora) {
    try {
      await marcarMorta(m.linha, m.motivo);
      mortas.push(rotulo(m.linha));
    } catch (e) {
      falhas.push(`${rotulo(m.linha)} — morta, mas falhou ao marcar (${e.message})`);
    }
  }

  /* Silêncio é o padrão: só avisa quando muda. */
  let avisado = false;
  let aviso_detalhe = "nada mudou, não havia o que avisar";
  if (mortas.length) {
    const txt =
      `🚫 ${mortas.length === 1 ? "Uma casa saiu do ar" : `${mortas.length} casas saíram do ar`}:\n` +
      mortas.map((m) => `• ${m}`).join("\n") +
      `\n\nJá tirei do site. casas-three.vercel.app`;
    const envio = await avisar(txt);
    avisado = envio.ok;
    aviso_detalhe = envio.detalhe;
  }

  /* A batida é a última coisa: só marca "rodei" quem de fato chegou até aqui,
   * tendo varrido a fila e gravado o que morreu. */
  let batida = null;
  let batida_erro = null;
  try {
    batida = await registrarBatida(
      `Última varredura: ${fila.length} casas, ${vivas} vivas, ${mortas.length} removidas, ` +
        `${incertas.length} sem confirmar. ${Math.round((Date.now() - t0) / 1000)}s.`
    );
  } catch (e) {
    batida_erro = e.message;
  }

  return res.status(200).json({
    ok: true,
    batida,
    batida_erro,
    verificadas: fila.length,
    vivas,
    mortas: mortas.length,
    quais_mortas: mortas,
    incertas: incertas.length,
    resolvidas_de_graca: fila.length - paraPagar.length,
    creditos_firecrawl,
    creditos_scrapedo,
    teto_pago: MAX_PAGO,
    avisado,
    aviso_detalhe,
    segundos: Math.round((Date.now() - t0) / 1000),
    detalhe_incertas: incertas,
    falhas,
  });
}
