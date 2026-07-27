/*
 * Rede de segurança para quando o Firecrawl fica sem crédito.
 *
 * O Firecrawl tem duas contas e as duas zeraram em 27/07/2026, no meio da
 * vigia semanal. Enquanto não há crédito, o /api/buscar não abre portal
 * nenhum e a rotina fica cega — ela não tem navegador, só este endpoint.
 * O scrape.do entra como terceiro degrau: não substitui o Firecrawl, mas
 * segura a semana.
 *
 * DIFERENÇA QUE IMPORTA: o scrape.do NÃO extrai com IA. O Firecrawl aceita um
 * prompt e devolve JSON mastigado; aqui volta markdown cru e quem lê é a
 * própria rotina. Por isso o /api/buscar avisa qual motor respondeu.
 *
 * ECONOMIA (medido em produção, 27/07/2026): a tabela do scrape.do cobra
 * 1 crédito sem render, 5 com render, 10 com proxy residencial e 25 com os
 * dois. Testado nos sites que interessam, ficha e busca do VivaReal e ficha
 * da OLX voltaram COMPLETAS por 1 crédito — inclusive a página de busca, que
 * no navegador só monta os cards por JavaScript. Ou seja: começar caro seria
 * jogar 24 créditos fora por chamada. Aqui se começa barato e só escala
 * quando o alvo bloqueia de fato.
 */

const ENDPOINT = "https://api.scrape.do/";

/* Degraus, do mais barato para o mais caro. O custo real vem no header
 * scrape.do-request-cost e é ele que mandamos de volta — a tabela pode mudar
 * e alguns domínios têm preço fixo próprio. */
const DEGRAUS = [
  { nome: "simples", custo_previsto: 1, params: {} },
  { nome: "render", custo_previsto: 5, params: { render: "true" } },
  { nome: "residencial+render", custo_previsto: 25, params: { render: "true", super: "true" } },
];

/* Abaixo disso não é página, é erro ou muro. */
const MINIMO_BYTES = 800;

/* Só estes justificam gastar o próximo degrau: o alvo barrou o robô.
 * 404 e 410 são resposta legítima ("o anúncio morreu") e escalar seria
 * queimar crédito para reconfirmar a mesma coisa. */
function vaiEscalar(status) {
  return status === 401 || status === 403 || status === 405 || status === 429 || status >= 500;
}

/*
 * Devolve { ok, status, markdown, custo, restantes, degrau, motivo }.
 * `status` é o HTTP do SITE ALVO — o scrape.do repassa o código de destino,
 * então 404 aqui significa anúncio removido, não falha nossa.
 * `restantes` é o saldo da conta, que o scrape.do manda em todo header: serve
 * para a rotina avisar ANTES de acabar, em vez de descobrir na próxima segunda.
 */
export async function scrapeDo(url, opcoes = {}) {
  const token = process.env.SCRAPEDO_TOKEN;
  if (!token) return { ok: false, status: 0, markdown: "", custo: 0, restantes: null, motivo: "sem SCRAPEDO_TOKEN" };

  const maxDegrau = Number.isInteger(opcoes.maxDegrau) ? opcoes.maxDegrau : DEGRAUS.length - 1;
  const timeoutMs = opcoes.timeoutMs || 60000;
  let custoTotal = 0;
  let restantes = null;
  let ultimo = { ok: false, status: 0, markdown: "", custo: 0, restantes: null, motivo: "não tentado" };

  for (let i = 0; i <= maxDegrau && i < DEGRAUS.length; i++) {
    const degrau = DEGRAUS[i];
    const q = new URLSearchParams({
      token,
      url,
      output: "markdown",
      ...degrau.params,
    });

    let r, texto;
    try {
      r = await fetch(`${ENDPOINT}?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
      texto = await r.text();
    } catch (e) {
      ultimo = { ...ultimo, status: 0, motivo: "rede falhou no scrape.do", degrau: degrau.nome };
      continue; /* tenta o degrau seguinte; pode ser timeout de render */
    }

    /* Os headers são a fonte da verdade sobre gasto e saldo. */
    custoTotal += Number(r.headers.get("scrape.do-request-cost")) || 0;
    const saldo = Number(r.headers.get("scrape.do-remaining-credits"));
    if (Number.isFinite(saldo)) restantes = saldo;

    /* Sem crédito no scrape.do TAMBÉM: não adianta escalar, só encarece. */
    if (r.status === 402) {
      return { ok: false, status: 402, markdown: "", custo: custoTotal, restantes, degrau: degrau.nome, motivo: "scrape.do sem crédito" };
    }

    /* Sucesso, ou 404/410 — que é resposta boa: o alvo disse que não existe mais. */
    if ((r.ok && texto.length >= MINIMO_BYTES) || r.status === 404 || r.status === 410) {
      return { ok: true, status: r.status, markdown: texto, custo: custoTotal, restantes, degrau: degrau.nome, motivo: null };
    }

    ultimo = {
      ok: false,
      status: r.status,
      markdown: "",
      custo: custoTotal,
      restantes,
      degrau: degrau.nome,
      motivo: r.ok ? "conteúdo veio curto demais" : `scrape.do devolveu ${r.status}`,
    };

    if (!r.ok && !vaiEscalar(r.status)) break; /* erro que não é bloqueio: escalar não resolve */
  }

  return ultimo;
}
