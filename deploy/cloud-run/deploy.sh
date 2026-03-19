#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

GCP_PROJECT="${GCP_PROJECT:-fh-claw}"
GCP_REGION="${GCP_REGION:-us-central1}"
ARTIFACT_REGISTRY="${ARTIFACT_REGISTRY:-clawhost}"
CLOUDSQL_INSTANCE="${CLOUDSQL_INSTANCE:-clawhost-db}"
API_SERVICE="${API_SERVICE:-clawhost-api}"
WEB_SERVICE="${WEB_SERVICE:-clawhost-web}"

IMAGE_BASE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${ARTIFACT_REGISTRY}"
CLOUDSQL_CONN="${GCP_PROJECT}:${GCP_REGION}:${CLOUDSQL_INSTANCE}"

API_ENV_FILE="${SCRIPT_DIR}/api-env.yaml"
WEB_ENV="${SCRIPT_DIR}/.env.web.build"

if [[ ! -f "$API_ENV_FILE" ]]; then
    echo "Missing ${API_ENV_FILE}. Copy api-env.yaml.example and fill secrets."
    exit 1
fi
if [[ ! -f "$WEB_ENV" ]]; then
    echo "Missing ${WEB_ENV}. Needs VITE_FIREBASE_* vars (VITE_API_URL is auto-set)."
    exit 1
fi

echo "==> Enabling APIs and IAM..."
gcloud config set project "$GCP_PROJECT"
gcloud services enable \
    identitytoolkit.googleapis.com \
    artifactregistry.googleapis.com \
    run.googleapis.com \
    sqladmin.googleapis.com \
    --project="$GCP_PROJECT" --quiet

PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/cloudsql.client" \
    --condition=None --quiet >/dev/null

if ! gcloud artifacts repositories describe "$ARTIFACT_REGISTRY" \
    --location="$GCP_REGION" >/dev/null 2>&1
then
    echo "==> Creating Artifact Registry repo..."
    gcloud artifacts repositories create "$ARTIFACT_REGISTRY" \
        --repository-format=docker \
        --location="$GCP_REGION"
fi

gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" -q

echo "==> Building API image..."
docker build --platform linux/amd64 -f Dockerfile -t "${IMAGE_BASE}/api:latest" .
echo "==> Pushing API image..."
docker push "${IMAGE_BASE}/api:latest"

echo "==> Deploying API to Cloud Run..."
gcloud run deploy "$API_SERVICE" \
    --image="${IMAGE_BASE}/api:latest" \
    --region="$GCP_REGION" \
    --platform=managed \
    --allow-unauthenticated \
    --port=8080 \
    --add-cloudsql-instances="$CLOUDSQL_CONN" \
    --env-vars-file="$API_ENV_FILE" \
    --quiet

API_URL="$(gcloud run services describe "$API_SERVICE" --region="$GCP_REGION" --format='value(status.url)')"
echo "    API URL: ${API_URL}"

set -a
# shellcheck disable=SC1090
source "$WEB_ENV"
set +a

echo "==> Building web image (VITE_API_URL=${API_URL})..."
docker build --platform linux/amd64 -f deploy/cloud-run/Dockerfile.web \
    --build-arg "VITE_API_URL=${API_URL}" \
    --build-arg "VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY}" \
    --build-arg "VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN}" \
    --build-arg "VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID}" \
    --build-arg "VITE_FIREBASE_STORAGE_BUCKET=${VITE_FIREBASE_STORAGE_BUCKET}" \
    --build-arg "VITE_FIREBASE_MESSAGING_SENDER_ID=${VITE_FIREBASE_MESSAGING_SENDER_ID}" \
    --build-arg "VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID}" \
    -t "${IMAGE_BASE}/web:latest" .
echo "==> Pushing web image..."
docker push "${IMAGE_BASE}/web:latest"

echo "==> Deploying web to Cloud Run..."
gcloud run deploy "$WEB_SERVICE" \
    --image="${IMAGE_BASE}/web:latest" \
    --region="$GCP_REGION" \
    --platform=managed \
    --allow-unauthenticated \
    --port=8080 \
    --quiet

WEB_URL="$(gcloud run services describe "$WEB_SERVICE" --region="$GCP_REGION" --format='value(status.url)')"
echo "    Web URL: ${WEB_URL}"

echo "==> Setting CLIENT=${WEB_URL} on API service..."
gcloud run services update "$API_SERVICE" \
    --region="$GCP_REGION" \
    --update-env-vars="CLIENT=${WEB_URL}" \
    --quiet

echo "==> Adding web host to Firebase authorized domains..."
GCP_PROJECT="$GCP_PROJECT" WEB_URL="$WEB_URL" python3 "${SCRIPT_DIR}/append_identity_domain.py" || true

echo ""
echo "============================================"
echo "  DEPLOYED"
echo "  API: ${API_URL}"
echo "  Web: ${WEB_URL}"
echo "============================================"
