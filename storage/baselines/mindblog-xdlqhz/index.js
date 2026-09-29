'use strict';

const http = require('http');

const PORT = process.env.PORT || 3000;
const DEMO_MODE = process.env.DEMO_MODE === 'true';

const POSTS = [
  { id: 1, title: 'Welcome to the demo', author: 'admin', excerpt: 'This is a temporary MindDemo environment.' },
  { id: 2, title: 'Getting started', author: 'admin', excerpt: 'Every visitor gets an isolated, temporary session.' },
  { id: 3, title: 'Reset on exit', author: 'admin', excerpt: 'Closing the demo resets everything to the baseline.' }
];

function html(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - MindDemo Demo</title>
  <style>
    :root { --bg:#0b0f1a; --panel:#141b2d; --blue:#1683ff; --text:#fff; --muted:#8a94a6; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); }
    header { background:var(--panel); padding:20px 40px; border-bottom:1px solid #2a344c; }
    header h1 { margin:0; font-size:22px; }
    .banner { background:#143a27; color:#6ee7b7; padding:8px 16px; font-size:12px; }
    main { max-width:900px; margin:0 auto; padding:32px 16px; }
    .card { background:var(--panel); border:1px solid #2a344c; border-radius:12px; padding:24px; margin-bottom:20px; }
    .post { border-bottom:1px solid #2a344c; padding:16px 0; }
    .post:last-child { border-bottom:none; }
    .post h3 { margin:0 0 6px; font-size:18px; }
    .post .meta { color:var(--muted); font-size:13px; margin-bottom:4px; }
    .post p { margin:4px 0 0; color:var(--muted); }
    nav a { color:var(--blue); text-decoration:none; margin-right:16px; }
    code { background:#1e2a4a; padding:2px 6px; border-radius:4px; font-size:13px; }
    footer { color:var(--muted); font-size:12px; padding:24px; text-align:center; }
  </style>
</head>
<body>
  <header>
    <h1>MindBlog</h1>
    <div class="banner">DEMO MODE: ${DEMO_MODE ? 'active (temporary environment - changes are reset)' : 'inactive'}</div>
  </header>
  <main>
    ${body}
  </main>
  <footer>MindDemo demo project &middot; listening on PORT=${PORT}</footer>
</body>
</html>`;
}

const ROUTES = {
  '/': () => html('MindBlog', `
    <div class="card">
      <h2>Welcome to MindBlog</h2>
      <p>This is a temporary demo running inside MindDemo. Visitors can browse posts, but all changes are automatically discarded when the session ends.</p>
      <p><strong>Demo credentials:</strong> <code>demo / demo123</code></p>
      <nav>
        <a href="/">Home</a>
        <a href="/posts">Posts</a>
        <a href="/about">About</a>
      </nav>
    </div>
    <div class="card">
      <h3>Latest posts</h3>
      ${POSTS.slice(0, 3).map(p => `
      <div class="post">
        <h3>${p.title}</h3>
        <div class="meta">by ${p.author}</div>
        <p>${p.excerpt}</p>
      </div>`).join('')}
    </div>
  `),
  '/posts': () => html('Posts', `
    <div class="card">
      <h2>Posts</h2>
      ${POSTS.map(p => `
      <div class="post">
        <h3>${p.title}</h3>
        <div class="meta">by ${p.author}</div>
        <p>${p.excerpt}</p>
      </div>`).join('')}
    </div>
  `),
  '/about': () => html('About', `
    <div class="card">
      <h2>About This Demo</h2>
      <p>A minimal self-contained Node.js app (no external dependencies) used to verify the MindDemo hosting platform.</p>
      <p>Running on Node.js, listening on <code>PORT=${PORT}</code>. <code>DEMO_MODE=${process.env.DEMO_MODE || 'undefined'}</code></p>
    </div>
  `)
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = ROUTES[url.pathname];
  if (handler) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(handler());
  } else {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('Not Found', '<div class="card"><h2>404 &mdash; Not Found</h2><p>The requested page does not exist in this demo.</p></div>'));
  }
});

server.listen(PORT, () => {
  console.log(`[MindDemo demo project] MindBlog is running on http://localhost:${PORT} (DEMO_MODE=${process.env.DEMO_MODE || 'undefined'})`);
});
