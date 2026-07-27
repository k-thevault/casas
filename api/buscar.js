/*
 * Olhos do vigia: busca páginas que bloqueiam robô.
 *
 * OLX, VivaReal e ZAP devolvem 403 pra curl e pra WebFetch — só abrem com
 * navegador de verdade. A rotina semanal não tem navegador, então sem isto ela
 * fica limitada a site de imobiliária pequena e perde a maior parte do estoque.
 *
 * Esta função é a ponte: recebe a URL, manda o Firecrawl renderizar a página e
 * devolve o conteúdo. A chave do Firecrawl mora nas env vars da Vercel, igual
 * ao token do Baserow e à chave da Evolution — a rotina nunca vê nenhuma delas,
 * só usa o segredo que ela já precisa ter.
 *
 * Sem a allowlist de domínios isto viraria um proxy aberto: qualquer um com o
 * segredo poderia usar a conta do Firecrawl (e o IP da Vercel) pra raspar a
 * internet inteira. Por isso só passam sites de imóvel.
 */

import { scrapeDo } from "../lib/scrapedo.js";

/* Duas contas: quando a primeira fica sem crédito (Firecrawl responde 402),
 * cai na segunda automaticamente. A ordem é a das env vars.
 * Esgotadas as duas, ainda há o scrape.do — ver lib/scrapedo.js. */
const FIRECRAWL_KEYS = [
  process.env.FIRECRAWL_API_KEY,
  process.env.FIRECRAWL_API_KEY_2,
].filter(Boolean);
const SEGREDO = process.env.VIGIA_SECRET;

/* Scrape no Firecrawl com failover entre contas. Só o 402 (crédito esgotado)
 * troca de conta — outros erros falhariam igual nas duas. Devolve {ok,status,data}. */
async function firecrawlScrape(payload) {
  let ultimo = { ok: false, status: 0, data: null };
  for (const key of FIRECRAWL_KEYS) {
    let r, d;
    try {
      r = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      d = await r.json().catch(() => null);
    } catch (e) {
      ultimo = { ok: false, status: 0, data: null };
      continue; /* rede falhou nesta conta; tenta a próxima */
    }
    if (r.ok && d) return { ok: true, status: r.status, data: d.data ?? {} };
    if (r.status === 402) {
      ultimo = { ok: false, status: 402, data: null };
      continue; /* sem crédito: cai pra próxima conta */
    }
    return { ok: false, status: r.status, data: null }; /* outro erro: não é crédito */
  }
  return ultimo; /* todas as contas sem crédito (ou vazias) */
}

/* Só sites de imóvel. mgfimoveis fica de fora de propósito: recicla anúncio
 * velho e já causou frustração. */
const PERMITIDOS = [
  "olx.com.br",
  "vivareal.com.br",
  "zapimoveis.com.br",
  "chavesnamao.com.br",
  "imovelweb.com.br",
  "quintoandar.com.br",
  "wimoveis.com.br",
];

const BLOQUEADOS = ["mgfimoveis.com.br", "mgfserv.com"];

function dominioLiberado(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return false;
  }
  if (BLOQUEADOS.some((d) => host === d || host.endsWith("." + d))) return false;
  /* Qualquer site de imobiliária pequena também vale — o que a rotina não
   * consegue abrir sozinha é justamente o portal grande, mas os sites locais
   * feitos em JavaScript também precisam de renderização. */
  if (PERMITIDOS.some((d) => host === d || host.endsWith("." + d))) return true;
  return /imob|imove|corretor|casa|lar|habit|predial|realty|broker/i.test(host);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  if ((!FIRECRAWL_KEYS.length && !process.env.SCRAPEDO_TOKEN) || !SEGREDO) {
    return res.status(500).json({ error: "Faltam FIRECRAWL_API_KEY/SCRAPEDO_TOKEN ou VIGIA_SECRET." });
  }
  if ((req.headers["x-vigia-secret"] || "") !== SEGREDO) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  const corpo = req.body || {};
  const url = typeof corpo.url === "string" ? corpo.url.trim() : "";
  if (!url) return res.status(400).json({ error: "Mande { url: '...' }." });
  if (!dominioLiberado(url)) {
    return res.status(403).json({ error: "Domínio fora da lista permitida." });
  }

  /* Sem prompt, devolve a página em markdown; com prompt, o Firecrawl extrai
   * os campos pedidos e devolve JSON já mastigado. */
  const prompt = typeof corpo.prompt === "string" ? corpo.prompt.trim() : "";
  const payload = {
    url,
    proxy: "auto",
    onlyMainContent: false,
    ...(corpo.waitFor ? { waitFor: Math.min(Number(corpo.waitFor) || 0, 15000) } : {}),
  };
  if (prompt) {
    payload.formats = [{ type: "json", prompt }];
  } else {
    payload.formats = ["markdown"];
  }

  try {
    const fc = FIRECRAWL_KEYS.length
      ? await firecrawlScrape(payload)
      : { ok: false, status: 402, data: null };

    if (fc.ok) {
      const dados = fc.data || {};
      return res.status(200).json({
        ok: true,
        motor: "firecrawl",
        status: dados.metadata?.statusCode ?? null,
        titulo: dados.metadata?.title ?? null,
        json: dados.json ?? null,
        markdown: prompt ? null : (dados.markdown || "").slice(0, 60000),
      });
    }

    /* Firecrawl fora do ar por CRÉDITO (402) ou por rede (status 0). Nos dois
     * casos o scrape.do resolve. Já um 4xx do Firecrawl é pedido malformado —
     * repetir no outro motor daria o mesmo erro e gastaria crédito à toa. */
    const vaiTentarReserva = fc.status === 402 || fc.status === 0;
    if (!vaiTentarReserva) {
      return res.status(502).json({ error: "Firecrawl recusou.", status: fc.status });
    }

    const sd = await scrapeDo(url, { timeoutMs: 55000 });
    if (!sd.ok) {
      const error =
        sd.status === 402
          ? "Firecrawl E scrape.do sem crédito."
          : `Firecrawl sem crédito e o scrape.do falhou (${sd.motivo}).`;
      return res.status(502).json({ error, status: sd.status, motor: "scrape.do" });
    }

    /* O scrape.do não extrai com IA. Se veio prompt, ele é ignorado e o
     * conteúdo volta cru — quem lê é a rotina. O aviso existe para ela não
     * achar que o json sumiu por bug. */
    return res.status(200).json({
      ok: true,
      motor: "scrape.do",
      status: sd.status,
      titulo: null,
      json: null,
      markdown: (sd.markdown || "").slice(0, 60000),
      custo: sd.custo,
      creditos_restantes: sd.restantes,
      aviso: prompt
        ? "Firecrawl sem crédito: respondi pelo scrape.do, que não extrai com IA. O seu prompt foi ignorado e o conteúdo veio em markdown — leia e conclua você mesma."
        : "Firecrawl sem crédito: respondi pelo scrape.do.",
    });
  } catch (e) {
    return res.status(502).json({ error: "Não consegui falar com o Firecrawl nem com o scrape.do." });
  }
}
