/*
 * Ponte do vigia semanal: grava as novidades no catálogo e avisa no WhatsApp.
 *
 * A rotina do Claude roda na nuvem da Anthropic e não tem cofre pra guardar
 * chave nenhuma. Então ela só manda o texto e as casas pra cá, e quem fala com
 * a Evolution e com o Baserow é esta função — com as chaves vivendo nas env
 * vars da Vercel, igual ao proxy do Baserow.
 *
 * O número de destino é fixo (env var): mesmo que alguém descubra este
 * endereço, não dá pra usar isto pra mandar mensagem pra terceiros.
 *
 * A escrita no catálogo segue as mesmas travas do api/casas.js: uma tabela só,
 * lista fechada de campos e um teto de itens por chamada. Assim o segredo do
 * vigia não vira um CRUD aberto no workspace inteiro.
 */

const EVO_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCIA = process.env.EVOLUTION_INSTANCE;
const PARA = process.env.WHATSAPP_TO;
const SEGREDO = process.env.VIGIA_SECRET;

const BASEROW_URL = (process.env.BASEROW_URL || "").replace(/\/$/, "");
const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const BASEROW_TABLE = process.env.BASEROW_TABLE;

/* Mesma lista do proxy, mais cat/uid: o vigia cadastra anúncio do catálogo. */
const CAMPOS = [
  "uid", "cat", "title", "city", "cond", "price", "fee", "area", "q", "su", "ba", "vg",
  "type", "pet", "office", "sale", "ficha", "img", "url", "agency", "tel", "wa", "near",
];

const NUMERICOS = ["price", "fee", "area", "q", "su", "ba", "vg"];
const BOOLEANOS = ["near", "office", "sale"];

/* Uma semana ruim traz 2 ou 3 casas. 20 já é folga grande — acima disso é bug. */
const TETO_POR_CHAMADA = 20;

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

/* Tira ?utm=... e barra final: o mesmo anúncio chega com URL diferente. */
function normalizarUrl(u) {
  if (!u || typeof u !== "string") return "";
  return u.split("?")[0].replace(/\/$/, "").toLowerCase();
}

/* Chave do "descarte permanente": cidade|condomínio|área. Sobrevive a reanúncio
 * com URL e preço novos — aluguel muda de preço, a área não. Exige condomínio E
 * área pra apontar a UNIDADE, não o prédio: descartar uma casa não pode vetar o
 * condomínio inteiro. Devolve null quando não dá pra fixar a unidade. */
function chaveDescarte(l) {
  const cond = String(l.cond || "").trim().toLowerCase();
  const area = l.area;
  if (!cond || area === null || area === undefined || area === "") return null;
  const city = String(l.city || "").trim().toLowerCase();
  return `${city}|${cond}|${area}`;
}

/* Ela rejeitou de propósito? Ocultou pelo site (mas não é o 🚫 que o vigia
 * carimba quando some do ar — esse pode voltar) ou marcou status "descartei".
 * O que ela descartou não volta numa busca nova. */
function foiDescartada(l) {
  const status = l.status && (l.status.value || l.status);
  const ocultadaPorEla = l.hidden && !String(l.title || "").startsWith("🚫");
  return ocultadaPorEla || status === "descartei";
}

function limpar(casa) {
  const out = {};
  for (const k of CAMPOS) {
    if (!(k in casa)) continue;
    let v = casa[k];
    if (BOOLEANOS.includes(k)) v = !!v;
    else if (NUMERICOS.includes(k)) {
      v = v === "" || v === null || v === undefined ? null : Number(v);
      if (Number.isNaN(v)) v = null;
    } else if (k === "type") v = v === "alt" ? "alt" : "cond";
    else if (k === "pet") v = v === "sim" ? "sim" : "n/i";
    else if (k === "cat") v = ["4q", "3q", "buy"].includes(v) ? v : "4q";
    else if (typeof v === "string") v = v.slice(0, 4000);
    out[k] = v;
  }
  /* Sem uid o site não consegue distinguir as linhas. */
  if (!out.uid) out.uid = "v" + Math.random().toString(36).slice(2, 10);
  if (!out.cat) out.cat = "4q";
  return out;
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

async function enviarWhatsapp(texto) {
  const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCIA}`, {
    method: "POST",
    headers: { apikey: EVO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ number: PARA, text: texto }),
  });
  return r.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCIA || !PARA || !SEGREDO) {
    return res.status(500).json({ error: "Faltam variáveis de ambiente." });
  }

  /* Sem isto, qualquer um que achasse a URL poderia disparar mensagem. */
  if ((req.headers["x-vigia-secret"] || "") !== SEGREDO) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  const corpo = req.body || {};
  let texto = typeof corpo.text === "string" ? corpo.text.trim() : "";
  const casas = Array.isArray(corpo.casas) ? corpo.casas : [];
  const indisponiveis = Array.isArray(corpo.indisponiveis) ? corpo.indisponiveis : [];

  if (!texto && !casas.length && !indisponiveis.length) {
    return res.status(400).json({ error: "Mande { text }, { casas: [...] } e/ou { indisponiveis: [...] }." });
  }
  if (casas.length > TETO_POR_CHAMADA) {
    return res.status(400).json({ error: `No máximo ${TETO_POR_CHAMADA} casas por chamada.` });
  }

  const resultado = { gravadas: 0, repetidas: 0, descartadas: 0, falhas: 0, marcadas_indisponiveis: 0 };

  /* ---- marca como indisponível o que saiu do ar ----
   *
   * Não apaga: esconde e carimba o motivo. Anúncio às vezes some por um dia e
   * volta, e um 404 pode ser erro de leitura — apagar seria irreversível. Com
   * hidden=true some da lista, e o "mostrar ocultas" no site recupera. */
  if (indisponiveis.length) {
    if (!BASEROW_URL || !BASEROW_TOKEN || !BASEROW_TABLE) {
      return res.status(500).json({ error: "Faltam as variáveis do Baserow." });
    }
    let linhas = [];
    try {
      linhas = await lerCatalogo();
    } catch (e) {
      return res.status(502).json({ error: "Não consegui ler o catálogo." });
    }
    const porUid = new Map(linhas.map((l) => [(l.uid || "").toLowerCase(), l]));
    const hoje = new Date().toISOString().slice(0, 10).split("-").reverse().join("/");

    for (const item of indisponiveis.slice(0, 60)) {
      const uid = String(item?.uid || "").toLowerCase();
      const linha = porUid.get(uid);
      if (!linha) {
        resultado.falhas++;
        continue;
      }
      /* Já carimbado antes: não repete o selo nem infla a contagem. */
      if (String(linha.title || "").startsWith("🚫")) continue;

      const motivo = String(item?.motivo || "anúncio não encontrado").slice(0, 300);
      const dados = {
        title: ("🚫 INDISPONÍVEL — " + (linha.title || "")).slice(0, 4000),
        ficha: ((linha.ficha || "") +
          ` || 🚫 INDISPONÍVEL em ${hoje}: ${motivo}. Verificado pelo vigia semanal. ` +
          `Se o anúncio voltar, é só desfazer o ocultar e apagar este aviso.`).slice(0, 4000),
        hidden: true,
      };
      try {
        const r = await baserow(
          `/api/database/rows/table/${BASEROW_TABLE}/${linha.id}/?user_field_names=true`,
          { method: "PATCH", body: JSON.stringify(dados) }
        );
        r.ok ? resultado.marcadas_indisponiveis++ : resultado.falhas++;
      } catch (e) {
        resultado.falhas++;
      }
    }
  }

  /* ---- grava as novidades no catálogo ---- */
  if (casas.length) {
    if (!BASEROW_URL || !BASEROW_TOKEN || !BASEROW_TABLE) {
      return res.status(500).json({ error: "Faltam as variáveis do Baserow." });
    }

    let existentes;
    try {
      existentes = await lerCatalogo();
    } catch (e) {
      return res.status(502).json({ error: "Não consegui ler o catálogo pra checar repetidos." });
    }

    /* Repetir casa que ela já viu é o que mais irrita — checa antes de gravar. */
    const urls = new Set(existentes.map((l) => normalizarUrl(l.url)).filter(Boolean));
    const uids = new Set(existentes.map((l) => (l.uid || "").toLowerCase()).filter(Boolean));
    const assinaturas = new Set(
      existentes.map((l) =>
        [(l.city || "").toLowerCase(), (l.cond || "").toLowerCase(), l.price, l.area].join("|")
      )
    );
    /* Descartes permanentes: o que ela ocultou/descartou não volta ao site,
     * mesmo reanunciado com URL e preço novos. */
    const descartadas = new Set(
      existentes.filter(foiDescartada).map(chaveDescarte).filter(Boolean)
    );

    for (const bruta of casas) {
      const casa = limpar(bruta || {});
      const assinatura = [
        (casa.city || "").toLowerCase(),
        (casa.cond || "").toLowerCase(),
        casa.price,
        casa.area,
      ].join("|");

      const chaveD = chaveDescarte(casa);
      if (chaveD && descartadas.has(chaveD)) {
        resultado.descartadas++;
        continue;
      }

      const repetida =
        (casa.url && urls.has(normalizarUrl(casa.url))) ||
        uids.has((casa.uid || "").toLowerCase()) ||
        assinaturas.has(assinatura);

      if (repetida) {
        resultado.repetidas++;
        continue;
      }

      try {
        const r = await baserow(`/api/database/rows/table/${BASEROW_TABLE}/?user_field_names=true`, {
          method: "POST",
          body: JSON.stringify(casa),
        });
        if (r.ok) {
          resultado.gravadas++;
          if (casa.url) urls.add(normalizarUrl(casa.url));
          uids.add((casa.uid || "").toLowerCase());
          assinaturas.add(assinatura);
        } else {
          resultado.falhas++;
        }
      } catch (e) {
        resultado.falhas++;
      }
    }
  }

  /* ---- avisa no WhatsApp ---- */
  if (casas.length || indisponiveis.length) {
    const partes = [];
    if (resultado.gravadas) {
      partes.push(
        `🏡 ${resultado.gravadas} ${resultado.gravadas === 1 ? "casa nova" : "casas novas"} no site`
      );
    } else if (casas.length) {
      partes.push("🏡 Nenhuma casa nova esta semana");
    }
    const jaConhecidas = resultado.repetidas + resultado.descartadas;
    if (jaConhecidas) partes.push(`(${jaConhecidas} já estavam lá)`);
    if (resultado.marcadas_indisponiveis) {
      partes.push(
        `🚫 ${resultado.marcadas_indisponiveis} ${
          resultado.marcadas_indisponiveis === 1 ? "saiu do ar" : "saíram do ar"
        }`
      );
    }
    if (resultado.falhas) partes.push(`⚠️ ${resultado.falhas} falharam`);
    const cabecalho = partes.join(" ") + "\ncasas-three.vercel.app";
    texto = texto ? `${cabecalho}\n\n${texto}` : cabecalho;
  }

  /* O WhatsApp engasga com mensagem muito longa: cortar é melhor que perder. */
  if (texto.length > 3500) texto = texto.slice(0, 3400) + "\n\n[…cortado — veio longo esta semana]";

  let enviado = false;
  try {
    enviado = await enviarWhatsapp(texto);
  } catch (e) {
    enviado = false;
  }

  /* Se gravou e o WhatsApp falhou, ainda foi um sucesso parcial: ela vê no site. */
  if (!enviado && !casas.length && !indisponiveis.length) {
    return res.status(502).json({ error: "Evolution recusou o envio." });
  }
  return res.status(200).json({ ok: true, enviado, ...resultado });
}
