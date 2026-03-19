# Deploy to Google Cloud Run (`*.run.app`)

API image: repo root `Dockerfile`. Web image: `Dockerfile.web` (nginx + Vite `dist`).

Docs: [Cloud Run](https://cloud.google.com/run/docs/quickstarts/build-and-deploy), [Cloud SQL from Run](https://cloud.google.com/sql/docs/postgres/connect-run), [Identity `projects.updateConfig`](https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects/updateConfig).

## What `deploy.sh` does (gcloud / Docker)

- `gcloud services enable identitytoolkit.googleapis.com`
- Grants **Cloud SQL Client** on the default Cloud Run runtime SA: `PROJECT_NUMBER-compute@developer.gserviceaccount.com`
- Creates Artifact Registry repo `clawhost` if missing, `docker build` / `push`, `gcloud run deploy` for API (with `--add-cloudsql-instances`)
- After web deploy: `gcloud run services update` sets **`CLIENT`** to the web service URL
- Calls Identity Toolkit **GET/PATCH** config to append the web hostname to **`authorizedDomains`** (same list as Firebase Auth “Authorized domains”). If your project has no Identity config yet, the script prints a warning and continues.

## You still must supply (no generic default)

- **`api-env.yaml`** — secrets and `DATABASE_URL` (socket form below). Copy from `api-env.yaml.example`.
- **Billing** on the GCP project.
- **Cloud SQL** instance already created in that project (name matches `CLOUDSQL_INSTANCE` in `deploy.sh`, default `clawhost-db`).
- **`.env.web.build`** after the first run (script exits early and prints what to put in it): `VITE_API_URL` + all `VITE_FIREBASE_*` like local `apps/web/.env`.

## `DATABASE_URL` (API → Cloud SQL socket)

`postgresql://postgres:PASSWORD@/clawhost?host=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME`

## Run

```bash
cp deploy/cloud-run/api-env.yaml.example deploy/cloud-run/api-env.yaml
./deploy/cloud-run/deploy.sh
./deploy/cloud-run/deploy.sh
```

Second run builds and deploys web after you add `deploy/cloud-run/.env.web.build`.

## Open in the browser

The **web** service URL (`https://…run.app`). `VITE_API_URL` must be the **API** URL from the first deploy.

## Optional console

[Run](https://console.cloud.google.com/run) · [SQL](https://console.cloud.google.com/sql/instances) · [Artifacts](https://console.cloud.google.com/artifacts)
