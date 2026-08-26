.PHONY: verify verify-backend verify-extension dev-brain dev-extension deploy-brain e2e e2e-up e2e-down e2e-run extension-build fake-wsp

PROJECT ?= dayflow-agentic
REGION  ?= europe-west4

# Harness (PLAN.md §Harness): fake-wsp on E2E_PORT_BASE, local brain on E2E_PORT_BASE+1.
E2E_PORT_BASE ?= 8099
SCENES ?= vault-sync courseware scaffold bootstrap team-ops pitch-deck
E2E_SCENES = $(if $(SCENE),$(SCENE),$(SCENES))

verify: verify-backend verify-extension

verify-backend:
	cd backend && PYTHONPATH= uv run ruff check . && PYTHONPATH= uv run pyright && PYTHONPATH= uv run pytest -q

verify-extension:
	cd extension && pnpm verify

dev-brain:
	cd backend && DAYFLOW_TOKEN=$${DAYFLOW_TOKEN:-dev} uv run python -m dayflow.api

dev-extension:
	cd extension && pnpm dev

deploy-brain:
	gcloud run deploy dayflow-brain --source backend --project $(PROJECT) --region $(REGION) \
	  --allow-unauthenticated --min-instances 0 --cpu-throttling --timeout 900 \
	  --set-env-vars GOOGLE_GENAI_USE_ENTERPRISE=1,GOOGLE_CLOUD_PROJECT=$(PROJECT),GOOGLE_CLOUD_LOCATION=global,DAYFLOW_FIRESTORE=1,OIDC_AUDIENCE=https://dayflow-brain-lrqhed2z5a-ez.a.run.app,PUBSUB_PUSH_SA=226180967155-compute@developer.gserviceaccount.com,CRON_INVOKER_SA=226180967155-compute@developer.gserviceaccount.com \
	  --set-secrets DAYFLOW_TOKEN=dayflow-token:latest

extension-build:
	cd extension && pnpm build

fake-wsp:
	FAKE_WSP_PORT=$(E2E_PORT_BASE) node harness/serve.mjs

# Full loop: start fake-wsp + brain (DAYFLOW_TOKEN=dev, DAYFLOW_FAKE_CONNECTORS=1), run the scene(s), stop both.
# make e2e            → all six scenes;  make e2e SCENE=vault-sync → one scene. Exit code = runner's.
e2e: extension-build
	E2E_PORT_BASE=$(E2E_PORT_BASE) bash harness/e2e.sh e2e $(E2E_SCENES)

e2e-up:
	E2E_PORT_BASE=$(E2E_PORT_BASE) bash harness/e2e.sh up

e2e-down:
	E2E_PORT_BASE=$(E2E_PORT_BASE) bash harness/e2e.sh down

# Run scene(s) against servers started with e2e-up (no build, no start/stop).
e2e-run:
	E2E_PORT_BASE=$(E2E_PORT_BASE) bash harness/e2e.sh run $(E2E_SCENES)
