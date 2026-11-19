// Pastello & Cia — Worker do cardápio
// - Serve o site (arquivos estáticos)
// - /api/e   : recebe estatísticas anônimas de uso (sem nome, telefone, endereço ou localização)
// - /painel  : painel de métricas protegido por senha (segredo PAINEL_SENHA)

const TIPOS = new Set(["visita", "carrinho", "revisao", "pedido"]);
const REGIOES = new Set(["Caldas do Jorro", "Jorrinho", "Tucano", "Retirada"]);
const PAGAMENTOS = new Set(["Pix", "Cartão", "Dinheiro"]);
const HOSTS = /(^|\.)pasteldojuca\.com\.br$|\.workers\.dev$|^localhost$|^127\.0\.0\.1$/;

const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/e") return evento(req, env);
    if (url.pathname === "/painel" || url.pathname === "/painel/") return painel(req, env, url);

    const res = await env.ASSETS.fetch(req);
    if (res.status === 404) {
      const nf = await env.ASSETS.fetch(new Request(new URL("/404", url), { method: "GET" }));
      const h = new Headers(nf.headers); for (const [k, v] of Object.entries(SEC)) h.set(k, v);
      return new Response(nf.body, { status: 404, headers: h });
    }
    return res;
  },
};

/* ---------------- Coleta ---------------- */
function agoraBahia() {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // America/Bahia (UTC-3, sem horário de verão)
  return { ts: Date.now(), dia: d.toISOString().slice(0, 10), hora: d.getUTCHours() };
}
const txt = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");

async function evento(req, env) {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const origin = req.headers.get("Origin");
  if (origin) { try { if (!HOSTS.test(new URL(origin).hostname)) return new Response(null, { status: 403 }); } catch { return new Response(null, { status: 403 }); } }
  const raw = await req.text();
  if (raw.length > 4000) return new Response(null, { status: 413 });
  let b; try { b = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  if (!b || !TIPOS.has(b.t)) return new Response(null, { status: 400 });

  const origem = /^[a-z0-9_-]{1,30}$/.test(b.o || "") ? b.o : "outro";
  const sessao = /^[a-z0-9]{4,20}$/.test(b.s || "") ? b.s : null;
  let valor = null, regiao = null, entrega = null, pagamento = null, itens = null;
  if (b.t === "pedido") {
    const v = Math.round(Number(b.v)); valor = Number.isFinite(v) && v >= 0 && v <= 100000000 ? v : null;
    regiao = REGIOES.has(b.r) ? b.r : null;
    entrega = b.e === "retirada" ? "retirada" : "entrega";
    pagamento = PAGAMENTOS.has(b.p) ? b.p : null;
    if (Array.isArray(b.i)) {
      const arr = b.i.slice(0, 40).map(x => ({ n: txt(x && x.n, 60), q: Math.min(50, Math.max(1, Math.round(Number(x && x.q)) || 1)) })).filter(x => x.n);
      itens = JSON.stringify(arr);
    }
  }
  const ua = req.headers.get("User-Agent") || "";
  const aparelho = /Mobi|Android|iPhone|iPad/i.test(ua) ? "celular" : "computador";
  const pais = (req.cf && req.cf.country) || null;
  const t = agoraBahia();
  await env.DB.prepare(
    "INSERT INTO eventos (ts,dia,hora,tipo,origem,sessao,valor_centavos,regiao,entrega,pagamento,itens,aparelho,pais) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(t.ts, t.dia, t.hora, b.t, origem, sessao, valor, regiao, entrega, pagamento, itens, aparelho, pais).run();
  return new Response(null, { status: 204 });
}

/* ---------------- Painel ---------------- */
function igual(a, b) { // comparação em tempo constante
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = c => (Number(c || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = n => Number(n || 0).toLocaleString("pt-BR");
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0).toLocaleString("pt-BR") + "%";

function htmlResp(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...SEC, ...extra } });
}

async function painel(req, env, url) {
  if (!env.PAINEL_SENHA) return htmlResp(pagina("Painel", `<div class="card"><h2>Falta configurar a senha</h2><p>No Cloudflare, em <b>Workers &amp; Pages → pasteldojuca → Configurações → Variáveis e segredos</b>, adicione um <b>Segredo</b> chamado <code>PAINEL_SENHA</code>.</p></div>`), 503);
  const auth = req.headers.get("Authorization") || "";
  let ok = false;
  if (auth.startsWith("Basic ")) { try { const [, senha] = atob(auth.slice(6)).split(/:(.*)/s); ok = igual(senha || "", env.PAINEL_SENHA); } catch {} }
  if (!ok) return new Response("Acesso restrito", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Painel Pastello", charset="UTF-8"', "Cache-Control": "no-store", ...SEC } });

  const dias = [7, 30, 90].includes(Number(url.searchParams.get("dias"))) ? Number(url.searchParams.get("dias")) : 7;
  const hoje = agoraBahia().dia;
  const ini = new Date(Date.parse(hoje + "T00:00:00Z") - (dias - 1) * 86400000).toISOString().slice(0, 10);
  const q = (sql, ...p) => env.DB.prepare(sql).bind(...p).all().then(r => r.results || []);

  const [tipos, ped, porOrigemV, porOrigemP, porDia, porHora, porRegiao, porPag, topItens, aparelhos, ultimos] = await Promise.all([
    q("SELECT tipo, COUNT(*) c FROM eventos WHERE dia>=? GROUP BY tipo", ini),
    q("SELECT COUNT(*) n, SUM(valor_centavos) s FROM eventos WHERE tipo='pedido' AND dia>=?", ini),
    q("SELECT origem, COUNT(*) c FROM eventos WHERE tipo='visita' AND dia>=? GROUP BY origem ORDER BY c DESC", ini),
    q("SELECT origem, COUNT(*) c, SUM(valor_centavos) s FROM eventos WHERE tipo='pedido' AND dia>=? GROUP BY origem ORDER BY c DESC", ini),
    q("SELECT dia, SUM(tipo='visita') v, SUM(tipo='pedido') p, SUM(CASE WHEN tipo='pedido' THEN valor_centavos ELSE 0 END) s FROM eventos WHERE dia>=? GROUP BY dia ORDER BY dia", ini),
    q("SELECT hora, COUNT(*) c FROM eventos WHERE tipo='pedido' AND dia>=? GROUP BY hora ORDER BY hora", ini),
    q("SELECT COALESCE(regiao,'—') regiao, COUNT(*) c, SUM(valor_centavos) s FROM eventos WHERE tipo='pedido' AND dia>=? GROUP BY regiao ORDER BY c DESC", ini),
    q("SELECT COALESCE(pagamento,'—') pagamento, COUNT(*) c FROM eventos WHERE tipo='pedido' AND dia>=? GROUP BY pagamento ORDER BY c DESC", ini),
    q("SELECT json_extract(j.value,'$.n') n, SUM(json_extract(j.value,'$.q')) qt, COUNT(*) vezes FROM eventos e, json_each(e.itens) j WHERE e.tipo='pedido' AND e.dia>=? AND e.itens IS NOT NULL GROUP BY n ORDER BY qt DESC LIMIT 10", ini),
    q("SELECT aparelho, COUNT(*) c FROM eventos WHERE tipo='visita' AND dia>=? GROUP BY aparelho", ini),
    q("SELECT dia, hora, origem, valor_centavos, regiao, pagamento, itens FROM eventos WHERE tipo='pedido' ORDER BY ts DESC LIMIT 10"),
  ]);

  const T = Object.fromEntries(tipos.map(r => [r.tipo, r.c]));
  const visitas = T.visita || 0, carrinho = T.carrinho || 0, revisao = T.revisao || 0, pedidos = T.pedido || 0;
  const fat = (ped[0] && ped[0].s) || 0, ticket = pedidos ? fat / pedidos : 0;
  const nomes = { instagram: "Instagram", qrcode: "QR Code", status: "Status do WhatsApp", whatsapp: "WhatsApp", google: "Google", facebook: "Facebook", direto: "Direto / link digitado", outro: "Outros sites", gmn: "Google Meu Negócio" };
  const nome = o => nomes[o] || o;
  const barras = (rows, label, val, fmt = num) => { const m = Math.max(1, ...rows.map(val)); return rows.length ? rows.map(r => `<div class="bar"><span class="l">${esc(label(r))}</span><span class="t"><i style="width:${Math.max(2, (val(r) / m) * 100)}%"></i></span><span class="v">${fmt(val(r))}</span></div>`).join("") : `<p class="vazio">Sem dados no período.</p>`; };

  const conv = porOrigemV.map(r => { const p = porOrigemP.find(x => x.origem === r.origem); return { origem: r.origem, v: r.c, p: p ? p.c : 0, s: p ? p.s : 0 }; });
  porOrigemP.forEach(p => { if (!conv.find(c => c.origem === p.origem)) conv.push({ origem: p.origem, v: 0, p: p.c, s: p.s }); });

  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, c: (porHora.find(x => x.hora === h) || {}).c || 0 })).filter(x => x.hora >= 17 || x.hora <= 1 || x.c);
  const diasSerie = []; for (let i = 0; i < dias; i++) { const d = new Date(Date.parse(ini + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10); const r = porDia.find(x => x.dia === d) || {}; diasSerie.push({ dia: d, v: r.v || 0, p: r.p || 0, s: r.s || 0 }); }
  const mx = Math.max(1, ...diasSerie.map(d => d.v));
  const colunas = diasSerie.map(d => `<div class="col" title="${d.dia}: ${d.v} visitas, ${d.p} pedidos"><div class="cv" style="height:${(d.v / mx) * 100}%"><div class="cp" style="height:${d.v ? Math.min(100, (d.p / d.v) * 100) : 0}%"></div></div><span>${dias <= 31 ? d.dia.slice(8, 10) : ""}</span></div>`).join("");

  const fmtDia = d => d.split("-").reverse().slice(0, 2).join("/");
  const linhas = ultimos.map(r => { let it = ""; try { it = JSON.parse(r.itens || "[]").map(x => `${x.q}× ${x.n}`).join(", "); } catch {} return `<tr><td>${fmtDia(r.dia)} ${String(r.hora).padStart(2, "0")}h</td><td>${esc(nome(r.origem))}</td><td>${esc(r.regiao || "—")}</td><td>${esc(r.pagamento || "—")}</td><td class="r">${brl(r.valor_centavos)}</td><td class="it">${esc(it)}</td></tr>`; }).join("");

  const sel = d => `<a href="?dias=${d}" class="${d === dias ? "on" : ""}">${d} dias</a>`;
  const body = `
  <header><div><h1>Painel · Pastel do Juca</h1><p>pasteldojuca.com.br · de ${fmtDia(ini)} a ${fmtDia(hoje)}</p></div><nav>${sel(7)}${sel(30)}${sel(90)}</nav></header>
  <section class="kpis">
    <div class="k"><b>${num(visitas)}</b><span>visitas</span></div>
    <div class="k"><b>${num(pedidos)}</b><span>pedidos enviados</span></div>
    <div class="k"><b>${pct(pedidos, visitas)}</b><span>conversão</span></div>
    <div class="k"><b>${brl(fat)}</b><span>em pedidos</span></div>
    <div class="k"><b>${brl(ticket)}</b><span>ticket médio</span></div>
  </section>
  <section class="card"><h2>Funil</h2>${barras([{l:"Visitaram",v:visitas},{l:"Adicionaram ao carrinho",v:carrinho},{l:"Revisaram o pedido",v:revisao},{l:"Enviaram ao WhatsApp",v:pedidos}], r => r.l, r => r.v)}</section>
  <section class="card"><h2>Visitas e pedidos por dia</h2><div class="cols">${colunas}</div><p class="leg"><i class="a"></i> visitas <i class="b"></i> parte que virou pedido</p></section>
  <section class="card"><h2>De onde vêm (por canal)</h2><table><tr><th>Canal</th><th class="r">Visitas</th><th class="r">Pedidos</th><th class="r">Conversão</th><th class="r">Valor</th></tr>${conv.map(c => `<tr><td>${esc(nome(c.origem))}</td><td class="r">${num(c.v)}</td><td class="r">${num(c.p)}</td><td class="r">${pct(c.p, c.v)}</td><td class="r">${brl(c.s)}</td></tr>`).join("") || `<tr><td colspan=5 class="vazio">Sem dados no período.</td></tr>`}</table></section>
  <div class="grid">
    <section class="card"><h2>Itens mais pedidos</h2>${barras(topItens, r => r.n, r => r.qt)}</section>
    <section class="card"><h2>Pedidos por horário</h2>${barras(horas, r => String(r.hora).padStart(2, "0") + "h", r => r.c)}</section>
    <section class="card"><h2>Por região</h2>${barras(porRegiao, r => r.regiao, r => r.c)}</section>
    <section class="card"><h2>Forma de pagamento</h2>${barras(porPag, r => r.pagamento, r => r.c)}</section>
    <section class="card"><h2>Aparelho</h2>${barras(aparelhos, r => r.aparelho, r => r.c)}</section>
  </div>
  <section class="card"><h2>Últimos pedidos enviados</h2><div class="scroll"><table><tr><th>Quando</th><th>Canal</th><th>Região</th><th>Pagamento</th><th class="r">Total</th><th>Itens</th></tr>${linhas || `<tr><td colspan=6 class="vazio">Nenhum pedido ainda.</td></tr>`}</table></div></section>
  <section class="card"><h2>Links com rastreio</h2><p class="nota">Use um link para cada canal. O painel separa as visitas automaticamente.</p>
    <ul class="links"><li><b>Bio do Instagram</b><code>pasteldojuca.com.br/?utm_source=instagram</code></li><li><b>QR Code do balcão</b><code>pasteldojuca.com.br/?utm_source=qrcode</code></li><li><b>Status do WhatsApp</b><code>pasteldojuca.com.br/?utm_source=status</code></li><li><b>Google Meu Negócio</b><code>pasteldojuca.com.br/?utm_source=gmn</code></li></ul>
    <p class="nota">"Pedidos enviados" conta os toques em "Entendi, enviar". A confirmação final acontece no WhatsApp da loja. Nenhum dado pessoal é registrado.</p></section>`;
  return htmlResp(pagina("Painel · Pastel do Juca", body));
}

function pagina(titulo, body) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titulo)}</title>
<style>
@font-face{font-family:B;font-weight:400;src:url(/fonts/barlow-latin-400-normal.woff2)}@font-face{font-family:B;font-weight:700;src:url(/fonts/barlow-latin-700-normal.woff2)}@font-face{font-family:A;src:url(/fonts/anton-latin-400-normal.woff2)}
*{box-sizing:border-box;margin:0}body{background:#0b0b0b;color:#f4efe6;font:15px/1.45 B,system-ui,sans-serif;padding:18px;max-width:1100px;margin:0 auto}
header{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-end;margin-bottom:16px}h1{font:400 28px A,Impact,sans-serif;text-transform:uppercase;color:#f7e9cf;letter-spacing:.02em}header p{color:#a59a88;font-size:13px}
nav{display:flex;gap:6px}nav a{color:#a59a88;text-decoration:none;border:1px solid #2a2a2a;border-radius:99px;padding:6px 12px;font-weight:700;font-size:13px}nav a.on{background:#f6b21a;border-color:#f6b21a;color:#111}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}.k{background:#151515;border:1px solid #2a2a2a;border-radius:14px;padding:14px}.k b{display:block;font-size:26px;color:#f6b21a}.k span{color:#a59a88;font-size:13px}
.card{background:#151515;border:1px solid #2a2a2a;border-radius:14px;padding:16px;margin-bottom:12px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#f6b21a;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.grid .card{margin:0}.grid{margin-bottom:12px}
.bar{display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:10px;align-items:center;margin:7px 0;font-size:14px}.bar .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d9d1c4}.bar .t{background:#222;border-radius:6px;height:12px;overflow:hidden}.bar i{display:block;height:100%;background:#f6b21a;border-radius:6px}.bar .v{font-weight:700;min-width:36px;text-align:right}
.cols{display:flex;align-items:flex-end;gap:3px;height:160px}.col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}.cv{width:100%;background:#3a3020;border-radius:4px 4px 0 0;display:flex;flex-direction:column;justify-content:flex-end;min-height:1px}.cp{background:#f6b21a;border-radius:4px 4px 0 0}.col span{font-size:10px;color:#777;margin-top:4px;height:12px}
.leg{font-size:12px;color:#a59a88;margin-top:8px}.leg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}.leg .a{background:#3a3020;margin-left:0}.leg .b{background:#f6b21a}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:#a59a88;font-weight:400;font-size:12px;border-bottom:1px solid #2a2a2a;padding:6px}td{padding:7px 6px;border-bottom:1px solid #1f1f1f}.r{text-align:right}.it{color:#a59a88;font-size:13px;min-width:200px}.scroll{overflow-x:auto}
.vazio{color:#777;font-size:13px}.nota{color:#a59a88;font-size:13px;margin-bottom:8px}.links{list-style:none;padding:0;display:grid;gap:8px}.links li{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}.links code{background:#222;padding:4px 8px;border-radius:6px;color:#e9c46a;font-size:13px;word-break:break-all}code{color:#e9c46a}
</style></head><body>${body}</body></html>`;
}
