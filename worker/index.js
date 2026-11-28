// Pastello & Cia — Worker do cardápio
// - Serve o site e a página 404
// - POST /api/entrega : guarda por 24 h a mensagem curta do entregador e devolve um código
//   (grava no D1, que é consistente na hora; o KV fica como cópia de segurança)
// - GET  /e/<código>  : abre o WhatsApp com essa mensagem (o atendente escolhe o entregador)

const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
const HOSTS = /(^|\.)pasteldojuca\.com\.br$|\.workers\.dev$|^localhost$|^127\.0\.0\.1$/;
const TTL = 24 * 3600;             // 24 horas
const MAX = 900;                   // tamanho máximo da mensagem
const ID_RE = /^[A-Za-z0-9]{10}$/;
const FORMATO = /^\*ENTREGA\* · Pastello & Cia\nContato: [^\n]{1,120}\nEndereço: [^\n]{1,250}\n(Ref\.: [^\n]{1,200}\n)?Localização: https:\/\/maps\.google\.com\/\?q=-?\d{1,3}\.\d{1,7},-?\d{1,3}\.\d{1,7}\nPagamento: [^\n]{1,160}$/;

async function limpar(env) {
  if (!env.DB) return;
  try { await env.DB.prepare("DELETE FROM entregas WHERE expira < ?").bind(Date.now()).run(); } catch (e) { console.error("limpeza falhou", e && e.message); }
}
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export default {
  async scheduled(_ev, env) { await limpar(env); },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/entrega") return criar(req, env, ctx);
    if (url.pathname.startsWith("/e/")) return abrir(url, env);

    const res = await env.ASSETS.fetch(req);
    if (res.status === 404) return naoEncontrado(req, env);
    return res;
  },
};

async function naoEncontrado(req, env) {
  const nf = await env.ASSETS.fetch(new Request(new URL("/404", req.url), { method: "GET" }));
  const h = new Headers(nf.headers); for (const [k, v] of Object.entries(SEC)) h.set(k, v);
  return new Response(nf.body, { status: 404, headers: h });
}

function novoId() {
  const b = new Uint8Array(10); crypto.getRandomValues(b);
  return Array.from(b, x => ABC[x % ABC.length]).join("");
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC } });

async function criar(req, env, ctx) {
  if (req.method !== "POST") return json({ erro: "método" }, 405);
  const origin = req.headers.get("Origin");
  try { if (!origin || !HOSTS.test(new URL(origin).hostname)) return json({ erro: "origem" }, 403); } catch { return json({ erro: "origem" }, 403); }
  if (!env.DB && !env.ENTREGAS) return json({ erro: "indisponível" }, 503);
  if (env.LIMITE) {
    try {
      const ip = req.headers.get("CF-Connecting-IP") || "x";
      const { success } = await env.LIMITE.limit({ key: "entrega:" + ip });
      if (!success) return json({ erro: "muitas tentativas" }, 429);
    } catch {} // se o limitador falhar, segue (o link não pode travar o pedido)
  }
  const raw = await req.text();
  if (raw.length > MAX * 2) return json({ erro: "grande" }, 413);
  // só texto: remove caracteres de controle (mantém quebra de linha)
  const t = raw.replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, MAX);
  // só aceita o formato exato da mensagem do entregador (evita uso do link para outros textos)
  if (!FORMATO.test(t)) return json({ erro: "formato" }, 400);
  const id = novoId(), agora = Date.now(), expira = agora + TTL * 1000;
  let gravou = false;
  if (env.DB) {
    try { await env.DB.prepare("INSERT INTO entregas (id, texto, criado, expira) VALUES (?, ?, ?, ?)").bind(id, t, agora, expira).run(); gravou = true; } catch (e) { console.error("D1 falhou", e && e.message); }
  }
  if (env.ENTREGAS) {
    // cópia de segurança no KV (se o D1 falhou, esperamos gravar aqui antes de responder)
    const kv = env.ENTREGAS.put(id, t, { expirationTtl: TTL }).then(() => true, e => { console.error("KV falhou", e && e.message); return false; });
    if (gravou && ctx && ctx.waitUntil) ctx.waitUntil(kv); else gravou = (await kv) || gravou;
  }
  if (!gravou) return json({ erro: "indisponível" }, 503);
  if (ctx && ctx.waitUntil && Math.random() < 0.05) ctx.waitUntil(limpar(env));
  return json({ id }, 201);
}

async function abrir(url, env) {
  const id = url.pathname.slice(3).replace(/\/$/, "");
  let t = null;
  if (ID_RE.test(id)) {
    if (env.DB) { try { const r = await env.DB.prepare("SELECT texto FROM entregas WHERE id = ? AND expira > ?").bind(id, Date.now()).first(); t = r ? r.texto : null; } catch (e) { console.error("D1 leitura falhou", e && e.message); } }
    if (!t && env.ENTREGAS) { try { t = await env.ENTREGAS.get(id); } catch (e) { console.error("KV leitura falhou", e && e.message); } }
  }
  const base = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", ...SEC };
  if (t) return new Response(null, { status: 302, headers: { Location: "https://wa.me/?text=" + encodeURIComponent(t), ...base } });
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link não encontrado · Pastello &amp; Cia</title>
<style>@font-face{font-family:B;font-weight:600;src:url(/fonts/barlow-latin-600-normal.woff2)}@font-face{font-family:A;src:url(/fonts/anton-latin-400-normal.woff2)}
*{box-sizing:border-box;margin:0}body{min-height:100dvh;display:grid;place-items:center;background:oklch(0.14 0 0);color:oklch(0.95 0.02 85);font:16px/1.5 B,system-ui,sans-serif;padding:24px;text-align:center}
h1{font:400 30px A,Impact,sans-serif;text-transform:uppercase;color:oklch(0.82 0.16 80);margin-bottom:8px}p{color:oklch(0.72 0.02 85);max-width:30ch;margin:0 auto}</style></head>
<body><main><h1>Link não encontrado</h1><p>Este link de entrega vale por 24 horas. Encaminhe ao entregador o endereço e o link de localização que estão na mensagem do pedido.</p></main></body></html>`;
  return new Response(html, { status: 410, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'", ...base } });
}
