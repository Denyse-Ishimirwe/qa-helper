# Deploy checklist — what’s done in code vs what you do

## Already in the repo (no action needed)

- `npm start` / `npm run prod` (build + API + static `dist/`)
- `PORT`, `DATABASE_PATH`, `UPLOADS_DIR`, `CORS_ORIGIN`, `NODE_ENV` support
- `GET /api/health` for uptime checks (Docker HEALTHCHECK uses it)
- `Dockerfile` + `.dockerignore` (Node 22, Vite build, Playwright Chromium)
- Production: `trust proxy` when `NODE_ENV=production`
- Default DB: `qahelper.db` next to `server.js` locally; in **production**, if a folder **`/data`** exists (persistent disk), SQLite and uploads use **`/data/qahelper.db`** and **`/data/uploads`** automatically so projects survive redeploys (override with `DATABASE_PATH` / `UPLOADS_DIR` if needed).

---

## What you must do (exactly)

### 1. Pick a host

Examples: **Railway**, **Render**, **Fly.io**, or any **VPS + Docker**.  
Use the **Dockerfile** in the repo (or build locally and push the image, depending on the product).

### 2. Create the service

- Connect **GitHub** (or upload the image).
- Set **build** = Dockerfile, **start** = `node server.js` (often automatic).
- Open the **public HTTPS URL** they give you — that’s what you send your manager.

### 3. Set environment variables on the host

| Variable        | Required? | Notes |
|----------------|-----------|--------|
| `JWT_SECRET`   | **Yes**   | Long random string; changing it logs everyone out. |
| `GROQ_API_KEY` | **Yes**   | For AI generate/analyse/validation. |
| `PORT`         | Usually auto | Render/Railway often inject `PORT` — don’t hardcode 3000 in the platform UI if they forbid it. |
| `NODE_ENV`     | Recommended | Set to `production`. |
| `CORS_ORIGIN`  | Recommended in prod | Your exact app URL, e.g. `https://xxx.onrender.com` (comma-separate if multiple). |
| `DATABASE_PATH`| Recommended | e.g. `/data/qahelper.db` if you attach a **persistent disk/volume**. |
| `UPLOADS_DIR`  | Optional    | e.g. `/data/uploads` on the same disk so SRD uploads survive restarts. |

Never commit `.env`; only set these in the host’s dashboard.

### 4. Add persistent storage (strongly recommended)

SQLite and `uploads/` are **on disk**. Without a volume/disk, **data is lost** when the container redeploys.

- Attach a **disk** / **volume** mounted at **`/data`** (matches this repo’s defaults).
- Set **`NODE_ENV=production`**. The app will then use **`/data/qahelper.db`** and **`/data/uploads`** automatically — you do not need `DATABASE_PATH` / `UPLOADS_DIR` unless you want a different layout.
- If your host mounts storage elsewhere, set **`DATABASE_PATH`** and **`UPLOADS_DIR`** explicitly.

### 5. Smoke-test after deploy

- Open the public URL → log in / sign up as designed.
- Hit `https://YOUR-URL/api/health` → should return JSON `{ "ok": true, ... }`.
- Run **Run tests** once — first run may be slower (Chromium).

### 6. Share with your manager

Send: **the HTTPS URL**, a **test account** (or signup steps), and what to try (create project, analyse form, run tests).

---

## Local Docker (optional sanity check)

```bash
docker build -t qa-helper .
docker run --rm -p 3000:3000 --env-file .env qa-helper
```

Open `http://localhost:3000`.

---

## If something fails

- **502 / won’t start:** check host logs; confirm `JWT_SECRET` is set.
- **CORS errors in browser:** set `CORS_ORIGIN` to the exact origin shown in the error.
- **DB reset every deploy:** add volume + `DATABASE_PATH` (and `UPLOADS_DIR` if you use uploads).
- **Run tests fail:** confirm the image built with Playwright (`Dockerfile` already runs `playwright install chromium --with-deps`).

---

## Deploy on Render (step-by-step)

### Option A — Blueprint (uses `render.yaml`)

1. Push this repo to **GitHub** (include `render.yaml` + `Dockerfile`).
2. In [Render](https://dashboard.render.com): **New** → **Blueprint**.
3. Connect the repo, select branch **`main`**, confirm the spec (web service + disk).
4. After the first deploy, open your service → **Environment**:
   - Set **`GROQ_API_KEY`** (your Groq key).
   - Set **`CORS_ORIGIN`** to your Render URL exactly, e.g. `https://qa-helper.onrender.com` (no trailing slash).  
     *If you skip this, the UI may hit CORS errors in the browser.*
5. **Save** — Render redeploys. Open the **public URL** and test; send that link to your manager.

**Health check:** Render calls **`/api/health`** (already implemented).

**Cost note:** The included blueprint uses **`plan: starter`** so **persistent disk** works. **Free** web services on Render don’t get a durable disk — for free-only, remove the `disk` block and the `DATABASE_PATH` / `UPLOADS_DIR` entries from `render.yaml` (or create the service manually without a disk) and expect the database to reset when the instance restarts.

### Option B — Manual Web Service (no Blueprint)

1. **New** → **Web Service** → connect repo.
2. **Runtime:** Docker (uses root `Dockerfile`).
3. Add the same env vars as in the table above (plus **`DATABASE_PATH`** / **`UPLOADS_DIR`** if you attach a **Disk** under **Storage**).
4. **Disk:** create a disk, mount at **`/data`**, then set `DATABASE_PATH=/data/qahelper.db` and `UPLOADS_DIR=/data/uploads`.

`PORT` is set by Render — do not override unless you know you need to.
