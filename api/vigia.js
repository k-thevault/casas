/*
 * Ponte do vigia semanal para o WhatsApp.
 *
 * A rotina do Claude roda na nuvem da Anthropic e não tem cofre pra guardar a
 * chave da Evolution. Então ela só manda o texto pra cá, e quem fala com o
 * WhatsApp é esta função — com a chave vivendo nas env vars da Vercel, igual
 * ao proxy do Baserow.
 *
 * O número de destino é fixo (env var): mesmo que alguém descubra este
 * endereço, não dá pra usar isto pra mandar mensagem pra terceiros.
 */

const EVO_URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const EVO_INSTANCIA = process.env.EVOLUTION_INSTANCE;
const PARA = process.env.WHATSAPP_TO;
const SEGREDO = process.env.VIGIA_SECRET;

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

  let texto = (req.body && req.body.text) || "";
  if (typeof texto !== "string" || !texto.trim()) {
    return res.status(400).json({ error: "Mande { text: '...' }." });
  }

  /* O WhatsApp engasga com mensagem muito longa: cortar é melhor que perder. */
  texto = texto.trim();
  if (texto.length > 3500) texto = texto.slice(0, 3400) + "\n\n[…cortado — veio longo esta semana]";

  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCIA}`, {
      method: "POST",
      headers: { apikey: EVO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ number: PARA, text: texto }),
    });
    if (!r.ok) return res.status(502).json({ error: "Evolution recusou o envio." });
    const d = await r.json();
    return res.status(200).json({ ok: true, status: d.status || null });
  } catch (e) {
    return res.status(502).json({ error: "Não consegui falar com a Evolution." });
  }
}
