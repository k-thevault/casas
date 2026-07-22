/*
 * Proxy de imagem.
 *
 * As fotos vêm de CDNs de imobiliárias (VivaReal, OLX, ChavesNaMão...) que
 * bloqueiam "hotlink": só servem a imagem se o Referer for do próprio site.
 * O navegador não pode forjar Referer de outro domínio — mas o servidor pode.
 * Aqui a gente busca a imagem mandando o Referer da origem dela e devolve os
 * bytes pro site, com cache longo pro CDN da Vercel guardar (a função quase
 * nunca roda de novo pra mesma foto).
 *
 * É uma fronteira de saída: só http(s), só o que for imagem de verdade (pelo
 * content-type ou pelos bytes), e bloqueia host interno/privado pra não virar
 * um proxy aberto (SSRF).
 */

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — foto de anúncio não passa disso
const TIMEOUT_MS = 8000;

/* Bloqueia loopback/rede interna/metadata da cloud quando a URL usa IP literal. */
function ehHostInterno(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // é um domínio comum (tem que resolver por DNS lá fora)
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;         // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;          // 192.168/16
  return false;
}

/* Fareja o tipo pelos bytes mágicos quando o host não manda content-type. */
function cheiroDeImagem(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf.toString("ascii", 4, 8) === "ftyp") return "image/avif"; // avif/heic
  return null;
}

export default async function handler(req, res) {
  const bruto = req.query.u;
  if (!bruto) return res.status(400).send("faltou ?u=");

  let alvo;
  try {
    alvo = new URL(bruto);
  } catch {
    return res.status(400).send("url inválida");
  }
  if (alvo.protocol !== "https:" && alvo.protocol !== "http:") {
    return res.status(400).send("só http/https");
  }
  if (ehHostInterno(alvo.hostname)) {
    return res.status(403).send("host não permitido");
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(alvo.href, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        // O truque: Referer da própria origem da imagem desarma o hotlink.
        Referer: `${alvo.protocol}//${alvo.host}/`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    if (!r.ok) return res.status(502).send("origem respondeu " + r.status);

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).send("imagem grande demais");

    // Alguns hosts (ex.: casteldigital) servem a imagem sem content-type. Se o
    // header não vier como imagem, farejamos os bytes mágicos antes de recusar.
    let tipo = (r.headers.get("content-type") || "").toLowerCase();
    if (!tipo.startsWith("image/")) {
      tipo = cheiroDeImagem(buf) || "";
      if (!tipo) return res.status(415).send("não é imagem");
    }

    res.setHeader("Content-Type", tipo);
    // O navegador guarda 1 dia; o CDN da Vercel guarda 30 dias e revalida sozinho.
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400"
    );
    return res.status(200).send(buf);
  } catch (e) {
    const msg = e.name === "AbortError" ? "tempo esgotado" : "falha ao buscar";
    return res.status(502).send(msg);
  } finally {
    clearTimeout(t);
  }
}
