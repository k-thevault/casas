/*
 * Proxy entre o site e o Baserow.
 *
 * O token vive só aqui (env var na Vercel), nunca chega ao navegador.
 * Por isso esta função é a fronteira de segurança: ela só fala com UMA tabela
 * e só deixa gravar os campos das listas abaixo. Sem isso, o proxy seria um
 * CRUD aberto pro workspace inteiro — o mesmo problema de expor o token.
 */

const URL_BASE = (process.env.BASEROW_URL || "").replace(/\/$/, "");
const TOKEN = process.env.BASEROW_TOKEN;
const TABLE = process.env.BASEROW_TABLE;

/* Gravável em qualquer linha: é o estado de uso (favoritar, ocultar, anotar). */
const CAMPOS_USUARIO = ["fav", "hidden", "status", "nota"];

/* Gravável só nas linhas cat="mine": os anúncios que ela mesma adiciona. */
const CAMPOS_MINE = [
  "title", "city", "cond", "price", "fee", "area", "q", "su", "ba", "vg",
  "type", "pet", "office", "sale", "ficha", "img", "url", "agency", "tel", "wa", "near",
];

const STATUS_VALIDOS = ["contatar", "aguardando", "visita", "gostei", "descartei"];

function baserow(path, options = {}) {
  return fetch(`${URL_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Token ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

/* single_select chega como {id,value,color}; o site só quer a string. */
const plano = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

function normalizar(row) {
  return {
    rowId: row.id,
    uid: row.uid,
    cat: plano(row.cat),
    city: row.city || "",
    cond: row.cond || "",
    title: row.title || "",
    price: row.price === null ? null : Number(row.price),
    fee: row.fee === null ? null : Number(row.fee),
    area: row.area === null ? null : Number(row.area),
    q: row.q === null ? null : Number(row.q),
    su: row.su === null ? null : Number(row.su),
    ba: row.ba === null ? null : Number(row.ba),
    vg: row.vg === null ? null : Number(row.vg),
    type: plano(row.type) || "cond",
    pet: plano(row.pet) || "n/i",
    near: !!row.near,
    office: !!row.office,
    sale: !!row.sale,
    ficha: row.ficha || "",
    img: row.img || "",
    url: row.url || "",
    agency: row.agency || "",
    tel: row.tel || "",
    wa: row.wa || "",
    fav: !!row.fav,
    hidden: !!row.hidden,
    status: plano(row.status) || "",
    nota: row.nota || "",
  };
}

/* Só deixa passar os campos permitidos, já saneados. */
function filtrar(corpo, permitidos) {
  const out = {};
  for (const k of permitidos) {
    if (!(k in corpo)) continue;
    let v = corpo[k];
    if (["fav", "hidden", "near", "office", "sale"].includes(k)) v = !!v;
    else if (["price", "fee", "area", "q", "su", "ba", "vg"].includes(k)) {
      v = v === "" || v === null || v === undefined ? null : Number(v);
      if (Number.isNaN(v)) v = null;
    } else if (k === "status") {
      v = STATUS_VALIDOS.includes(v) ? v : null;
    } else if (k === "type") v = v === "alt" ? "alt" : "cond";
    else if (k === "pet") v = v === "sim" ? "sim" : "n/i";
    else if (typeof v === "string") v = v.slice(0, 4000);
    out[k] = v;
  }
  return out;
}

async function buscarLinha(rowId) {
  const r = await baserow(`/api/database/rows/table/${TABLE}/${rowId}/?user_field_names=true`);
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  if (!URL_BASE || !TOKEN || !TABLE) {
    return res.status(500).json({ error: "Faltam as variáveis BASEROW_URL, BASEROW_TOKEN ou BASEROW_TABLE." });
  }

  try {
    /* ---- listar tudo ---- */
    if (req.method === "GET") {
      const todas = [];
      let page = 1;
      while (true) {
        const r = await baserow(
          `/api/database/rows/table/${TABLE}/?user_field_names=true&size=200&page=${page}`
        );
        if (!r.ok) return res.status(r.status).json({ error: "Falha ao ler do Baserow." });
        const d = await r.json();
        todas.push(...d.results);
        if (!d.next) break;
        page++;
      }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(todas.map(normalizar));
    }

    /* ---- criar anúncio meu ---- */
    if (req.method === "POST") {
      const corpo = req.body || {};
      const dados = filtrar(corpo, CAMPOS_MINE);
      dados.cat = "mine";
      dados.uid = "m" + Math.random().toString(36).slice(2, 10);
      dados.agency = dados.agency || "Você adicionou";
      const r = await baserow(`/api/database/rows/table/${TABLE}/?user_field_names=true`, {
        method: "POST",
        body: JSON.stringify(dados),
      });
      if (!r.ok) return res.status(r.status).json({ error: "Falha ao criar." });
      return res.status(200).json(normalizar(await r.json()));
    }

    const rowId = parseInt(req.query.rowId, 10);
    if (!rowId) return res.status(400).json({ error: "rowId ausente." });

    /* ---- atualizar ---- */
    if (req.method === "PATCH") {
      const linha = await buscarLinha(rowId);
      if (!linha) return res.status(404).json({ error: "Linha não encontrada." });
      const ehMinha = plano(linha.cat) === "mine";
      const permitidos = ehMinha ? [...CAMPOS_USUARIO, ...CAMPOS_MINE] : CAMPOS_USUARIO;
      const dados = filtrar(req.body || {}, permitidos);
      if (!Object.keys(dados).length) return res.status(400).json({ error: "Nada pra atualizar." });
      const r = await baserow(`/api/database/rows/table/${TABLE}/${rowId}/?user_field_names=true`, {
        method: "PATCH",
        body: JSON.stringify(dados),
      });
      if (!r.ok) return res.status(r.status).json({ error: "Falha ao atualizar." });
      return res.status(200).json(normalizar(await r.json()));
    }

    /* ---- excluir (só as minhas; o catálogo se oculta, não se apaga) ---- */
    if (req.method === "DELETE") {
      const linha = await buscarLinha(rowId);
      if (!linha) return res.status(404).json({ error: "Linha não encontrada." });
      if (plano(linha.cat) !== "mine") {
        return res.status(403).json({ error: "Só dá pra excluir anúncios que você adicionou. Use ocultar." });
      }
      const r = await baserow(`/api/database/rows/table/${TABLE}/${rowId}/`, { method: "DELETE" });
      if (!r.ok) return res.status(r.status).json({ error: "Falha ao excluir." });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Método não suportado." });
  } catch (e) {
    return res.status(500).json({ error: "Erro inesperado no proxy." });
  }
}
