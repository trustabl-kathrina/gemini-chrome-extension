.PHONY: verify verify-backend verify-extension verify-harness dev-brain dev-extension deploy-brain deploy-smoke e2e e2e-setup e2e-up e2e-down e2e-run extension-build fake-wsp fake-drive

# Your own GCP project. The author's values are never the default for deploy targets: PROJECT is required there.
PROJECT ?=
REGION  ?= europe-west4
# Vault + generated pages live in this bucket (DAYFLOW_BUCKET); without it Cloud Run keeps them in process
# memory and a cold start / second instance loses every file behind a persisted Firestore index.
BUCKET  ?= $(PROJECT)-dayflow-vault
SERVICE ?= dayflow-brain

# Harness (PLAN v2 §Harness): fake-wsp on E2E_PORT_BASE, local brain on BASE+1 (as http://localhost), fake-drive on BASE+2.
# Brain env: DAYFLOW_TOKEN=dev DAYFLOW_FAKE_CONNECTORS=1 DAYFLOW_FAKE_LOG=harness/out/<scene>-connectors.jsonl,
# DAYFLOW_BUCKET unset, DAYFLOW_PUBLIC_URL=http://localhost:BASE+1. Logs + pids in harness/out/.
E2E_PORT_BASE ?= 8099
SCENES ?= vault-sync lab team-ops courseware scaffold pitch-deck
E2E_SCENES = $(if $(SCENE),$(SCENE),$(SCENES))
E2E_REAL ?= 0

verify: verify-backend verify-extension verify-harness

verify-backend:
	cd backend && PYTHONPATH= uv run ruff check . && PYTHONPATH= uv run pyright && PYTHONPATH= uv run pytest -q

verify-extension:
	cd extension && pnpm verify

# The fake Drive is part of the judge: its upload semantics are self-tested.
verify-harness:
	node --test harness/*.test.mjs

PORT    ?= 8080

dev-brain:
	cd backend && \
	  GOOGLE_GENAI_USE_ENTERPRISE=$${GOOGLE_GENAI_USE_ENTERPRISE:-1} \
	  GOOGLE_CLOUD_PROJECT=$${GOOGLE_CLOUD_PROJECT:-$$(gcloud config get-value project 2>/dev/null || echo dayflow-agentic)} \
	  GOOGLE_CLOUD_LOCATION=$${GOOGLE_CLOUD_LOCATION:-global} \
	  DAYFLOW_TOKEN=$${DAYFLOW_TOKEN:-dev} \
	  PORT=$${PORT:-$(PORT)} \
	  uv run $(if $(wildcard backend/.env),--env-file .env,) python -m dayflow.api

dev-extension:
	cd extension && pnpm dev

# Two steps: deploy (Firestore, bucket, SAs derived from PROJECT), then point DAYFLOW_PUBLIC_URL / OIDC_AUDIENCE at the URL
# Cloud Run assigned (the /pages links and the Pub/Sub + Scheduler token audience must be this service's own URL).
deploy-brain:
	@test -n "$(PROJECT)" || { echo "usage: make deploy-brain PROJECT=<gcp-project> [REGION=$(REGION)]"; exit 2; }
	$(eval PROJECT_NUMBER := $(shell gcloud projects describe $(PROJECT) --format='value(projectNumber)'))
	@test -n "$(PROJECT_NUMBER)" || { echo "cannot read project number for $(PROJECT)"; exit 2; }
	gsutil ls -b gs://$(BUCKET) >/dev/null 2>&1 || gsutil mb -p $(PROJECT) -l $(REGION) gs://$(BUCKET)
	gcloud run deploy $(SERVICE) --source backend --project $(PROJECT) --region $(REGION) \
	  --allow-unauthenticated --min-instances 0 --cpu-throttling --timeout 900 --memory 1Gi \
	  --set-env-vars GOOGLE_GENAI_USE_ENTERPRISE=1,GOOGLE_CLOUD_PROJECT=$(PROJECT),GOOGLE_CLOUD_LOCATION=global,DAYFLOW_FIRESTORE=1,DAYFLOW_BUCKET=$(BUCKET),PUBSUB_PUSH_SA=$(PROJECT_NUMBER)-compute@developer.gserviceaccount.com,CRON_INVOKER_SA=$(PROJECT_NUMBER)-compute@developer.gserviceaccount.com \
	  --set-secrets DAYFLOW_TOKEN=dayflow-token:latest
	URL=$$(gcloud run services describe $(SERVICE) --project $(PROJECT) --region $(REGION) --format='value(status.url)') && \
	  gcloud run services update $(SERVICE) --project $(PROJECT) --region $(REGION) --update-env-vars DAYFLOW_PUBLIC_URL=$$URL,OIDC_AUDIENCE=$$URL
	$(MAKE) deploy-smoke PROJECT=$(PROJECT) REGION=$(REGION)

# What a judge can check: /health names the bucket + Gemini backend, /vault answers the token (v2 routes are live).
deploy-smoke:
	@test -n "$(PROJECT)" || { echo "usage: make deploy-smoke PROJECT=<gcp-project>"; exit 2; }
	URL=$$(gcloud run services describe $(SERVICE) --project $(PROJECT) --region $(REGION) --format='value(status.url)') && \
	  echo "$$URL" && curl -fsS $$URL/health && echo && \
	  TOKEN=$$(gcloud secrets versions access latest --secret dayflow-token --project $(PROJECT)) && \
	  curl -fsS -o /dev/null -w 'GET /vault → %{http_code}\n' -H "authorization: Bearer $$TOKEN" $$URL/vault && \
	  curl -fsS -o /dev/null -w 'GET /config → %{http_code}\n' -H "authorization: Bearer $$TOKEN" $$URL/config

extension-build:
	cd extension && pnpm build

fake-wsp:
	FAKE_WSP_PORT=$(E2E_PORT_BASE) node harness/serve.mjs

fake-drive:
	FAKE_DRIVE_PORT=$$(( $(E2E_PORT_BASE) + 2 )) node harness/fake-drive.mjs

# One-time machine setup for the harness: extension deps + Playwright's Chromium + the brain's venv.
e2e-setup:
	cd extension && pnpm install && pnpm exec playwright install chromium
	cd backend && uv sync

# Full loop: build the extension, start fake-wsp + fake-drive once and the brain per scene, run the scene(s), stop all.
# make e2e            → all six scenes;  make e2e SCENE=vault-sync → one scene;  E2E_REAL=1 → real portal (--real).
# Exit code = runner's (0 only when every scene's spec passes). Results: harness/out/<scene>.json.
e2e: extension-build
	E2E_PORT_BASE=$(E2E_PORT_BASE) E2E_REAL=$(E2E_REAL) bash harness/e2e.sh e2e $(E2E_SCENES)

# Servers only (for iterating on one scene): make e2e-up SCENE=vault-sync; then make e2e-run SCENE=vault-sync; make e2e-down.
e2e-up:
	E2E_PORT_BASE=$(E2E_PORT_BASE) bash harness/e2e.sh up $(if $(SCENE),$(SCENE),dev)

e2e-down:
	E2E_PORT_BASE=$(E2E_PORT_BASE) bash harness/e2e.sh down

# Run scene(s) against servers started with e2e-up (no build, no start/stop).
e2e-run:
	E2E_PORT_BASE=$(E2E_PORT_BASE) E2E_REAL=$(E2E_REAL) bash harness/e2e.sh run $(E2E_SCENES)
