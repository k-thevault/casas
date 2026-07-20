/*
 * Vigia diário das favoritas — roda por cron da Vercel, custo ~zero.
 *
 * O vigia semanal varre o mercado atrás de novidade. Este aqui faz só uma
 * coisa: todo dia confere se as casas que ela realmente quer continuam de pé,
 * e avisa NO DIA em que uma sai do ar — não na segunda seguinte.
 *
 * Por que não usar o /monitor do Firecrawl: ele cobra por página vigiada, e
 * 4 de 5 dos sites que interessam respondem a um fetch comum. Então tenta-se
 * o fetch grátis primeiro e só se cai no bloqueio (VivaReal e afins) é que se
 * gasta 1 crédito de Firecrawl. Na prática são poucos créditos por dia, dentro
 * da franquia que ela já tem.
 *
 * Só manda WhatsApp quando algo MUDA. Mensagem diária de "está tudo igual"
 * vira ruído e ela para de ler.
 */

const BASEROW_URL = (process.env.BASEROW_URL || "").replace(/\/$/, "");
const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const BASEROW_TABLE = process.env.BASEROW_TABLE;
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const EVO_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCIA = process.env.EVOLUTION_INSTANCE;
const PARA = process.env.WHATSAPP_TO;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/* Teto por execução: mantém a função dentro do tempo limite e o gasto previsível. */
const MAX_POR_RODADA = 14;

/* Frases que anunciam imóvel morto. Exigimos duas condições (ver adiante)
 * porque "alugado" sozinho aparece em menu e rodapé de site de imobiliária. */
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

/* Devolve {estado, via, http}. estado: 'vivo' | 'morto' | 'incerto'.
 * 'incerto' nunca marca nada — bloqueio de portal não é anúncio removido. */
async function checar(url) {
  /* 1) tentativa grátis.
   *
   * ATENÇÃO — lição cara: NÃO se pode declarar morte lendo o HTML cru. Vários
   * CMS de imobiliária (Kenlo/Imoview e afins) já trazem "imóvel indisponível"
   * escondido no template, em TODA página — inclusive na home e em anúncios
   * perfeitamente vivos. Isso derrubou 10 casas boas de uma vez.
   *
   * Aqui, portanto: 404/410 mata na hora (é inequívoco); a frase suspeita só
   * levanta suspeita e manda confirmar no passo 2, onde o onlyMainContent
   * descarta menu, rodapé e template. */
  let suspeita = null;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9" },
      redirect: "follow",
    });
    if (r.status === 404 || r.status === 410) {
      return { estado: "morto", via: "fetch", http: r.status, motivo: `página responde ${r.status}` };
    }
    if (r.ok) {
      const html = (await r.text()).toLowerCase();
      const achou = SINAIS_MORTE.find((s) => html.includes(s));
      if (html.length < 3000) {
        return { estado: "incerto", via: "fetch", http: r.status, motivo: "página veio quase vazia" };
      }
      if (!achou) return { estado: "vivo", via: "fetch", http: r.status };
      suspeita = achou; /* cai para a confirmação paga */
    }
    /* 403/429/5xx: o site bloqueou o robô. Cai para o Firecrawl. */
  } catch (e) {
    /* rede falhou; tenta o Firecrawl antes de desistir */
  }

  /* 2) confirmação — 1 crédito. Chega aqui quem bloqueou ou quem levantou
   * suspeita no HTML cru. O onlyMainContent tira o template do caminho. */
  if (!FIRECRAWL_KEY) {
    /* Sem como confirmar: suspeita não vira condenação. */
    return {
      estado: "incerto",
      via: "bloqueado",
      motivo: suspeita ? `suspeita de "${suspeita}", sem como confirmar` : "sem chave do Firecrawl",
    };
  }
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${FIRECRAWL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.data) {
      return { estado: "incerto", via: "firecrawl", motivo: `Firecrawl devolveu ${r.status}` };
    }
    const http = d.data.metadata?.statusCode ?? null;
    if (http === 404 || http === 410) {
      return { estado: "morto", via: "firecrawl", http, motivo: `página responde ${http}` };
    }
    const md = (d.data.markdown || "").toLowerCase();
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

async function avisar(texto) {
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCIA || !PARA) return false;
  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCIA}`, {
      method: "POST",
      headers: { apikey: EVO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ number: PARA, text: texto }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  /* A Vercel manda o CRON_SECRET no Authorization. Sem isso, qualquer um que
   * achasse a URL poderia disparar a rotina (e gastar crédito). */
  const auth = req.headers.authorization || "";
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  if (!BASEROW_URL || !BASEROW_TOKEN || !BASEROW_TABLE) {
    return res.status(500).json({ error: "Faltam as variáveis do Baserow." });
  }

  let linhas;
  try {
    linhas = await lerCatalogo();
  } catch (e) {
    return res.status(502).json({ error: "Não consegui ler o catálogo." });
  }

  /* Só o que ela realmente acompanha: favoritas, as que ela mesma cadastrou e
   * as que já têm situação marcada. O resto fica para o vigia semanal. */
  const fila = linhas
    .filter((l) => l.url)
    .filter((l) => !String(l.title || "").startsWith("🚫"))
    .filter((l) => l.fav || (l.cat && l.cat.value === "mine") || l.cat === "mine" || l.status)
    .slice(0, MAX_POR_RODADA);

  const mortas = [];
  const incertas = [];
  let creditos = 0;

  for (const l of fila) {
    const r = await checar(l.url);
    if (r.via === "firecrawl") creditos++;

    if (r.estado === "morto") {
      const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
      const dados = {
        title: ("🚫 INDISPONÍVEL — " + (l.title || "")).slice(0, 4000),
        ficha: (
          (l.ficha || "") +
          ` || 🚫 INDISPONÍVEL em ${hoje}: ${r.motivo}. Detectado pelo vigia diário. ` +
          `Se o anúncio voltar, é só desocultar e apagar este aviso.`
        ).slice(0, 4000),
        hidden: true,
      };
      try {
        await baserow(`/api/database/rows/table/${BASEROW_TABLE}/${l.id}/?user_field_names=true`, {
          method: "PATCH",
          body: JSON.stringify(dados),
        });
        mortas.push(`${l.city} — ${l.cond || l.title}`);
      } catch (e) {
        incertas.push(`${l.city} — falhou ao marcar`);
      }
    } else if (r.estado === "incerto") {
      incertas.push(`${l.city} — ${l.cond || ""} (${r.motivo})`);
    }
  }

  /* Silêncio é o padrão: só avisa quando muda. */
  let avisado = false;
  if (mortas.length) {
    const txt =
      `🚫 ${mortas.length === 1 ? "Uma casa saiu do ar" : `${mortas.length} casas saíram do ar`}:\n` +
      mortas.map((m) => `• ${m}`).join("\n") +
      `\n\nJá tirei do site. casas-three.vercel.app`;
    avisado = await avisar(txt);
  }

  return res.status(200).json({
    ok: true,
    verificadas: fila.length,
    mortas: mortas.length,
    incertas: incertas.length,
    creditos_firecrawl: creditos,
    avisado,
    detalhe_incertas: incertas,
  });
}
