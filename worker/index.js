// Pastello & Cia — Worker do cardápio: serve o site e a página 404.
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export default {
  async fetch(req, env) {
    const res = await env.ASSETS.fetch(req);
    if (res.status === 404) {
      const url = new URL(req.url);
      const nf = await env.ASSETS.fetch(new Request(new URL("/404", url), { method: "GET" }));
      const h = new Headers(nf.headers); for (const [k, v] of Object.entries(SEC)) h.set(k, v);
      return new Response(nf.body, { status: 404, headers: h });
    }
    return res;
  },
};
