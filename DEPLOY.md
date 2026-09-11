# Deploy ViperTech on Vercel

## One-click deploy

1. Push this folder to GitHub.
2. In Vercel, **Import** the repository.
3. Vercel will auto-detect **Vite** as the framework.
4. Click **Deploy**. That's it — both the frontend and the API serverless functions deploy together.

## Optional environment variables

Set these in **Vercel → Project → Settings → Environment Variables** if you want real email verification:

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | Your [Resend](https://resend.com) API key |
| `EMAIL_FROM` | Sender address, e.g. `ViperTech <noreply@your-domain.com>` |
| `WEB_ORIGIN` | Your Vercel URL for CORS, e.g. `https://vipertech.vercel.app` |

> If `RESEND_API_KEY` is not set, verification codes are printed to the serverless function logs (visible in the Vercel dashboard) — good enough for a demo.

## How it works

- **Frontend**: Vite builds `src/` into static files in `dist/`.
- **API**: Files in `api/` are deployed as Vercel Serverless Functions. Each file (e.g. `api/auth/signin.mjs`) becomes an endpoint (e.g. `/api/auth/signin`).
- **Routing**: `vercel.json` maps API paths to their serverless function and sends everything else to `index.html` for the SPA.

## Important note

The serverless auth functions use in-memory storage. Data resets on cold starts. For production, swap the in-memory stores in `api/lib/storage.mjs` with a real database (Vercel KV, Supabase, PlanetScale, etc.).

## Local development

```powershell
npm.cmd run dev
```

The Vite dev server proxies `/api` calls to `localhost:8787`. If you still want to use the standalone `server.mjs` for local development, run it in a second terminal:

```powershell
npm.cmd run dev:api
```
