# MindDemo Demo Project

A minimal, self-contained Node.js demo application used to verify the MindDemo hosting platform.

## What it does

- Serves a small "MindBlog" site with `/`, `/posts` and `/about` routes.
- Uses **only Node.js built-in modules** (`http`) — no external dependencies, so no `npm install` is required inside the demo container.
- Reads its listening port from `process.env.PORT` (the port MindDemo assigns at runtime).
- Detects `DEMO_MODE` and shows a banner that this is a temporary environment.

## Running locally (without MindDemo)

```bash
node index.js
# -> listening on http://localhost:3000
```

Override the port with `PORT=4123 node index.js`.

## Demo credentials (for the MindDemo demo account feature)

- Username: `demo`
- Password: `demo123`

## Files

- `package.json` — declares the `start` script (`node index.js`).
- `index.js` — the single-file server.
