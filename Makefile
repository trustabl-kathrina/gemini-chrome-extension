.PHONY: verify verify-backend verify-extension dev-brain dev-extension deploy-brain e2e e2e-up e2e-down e2e-run extension-build fake-wsp fake-drive

PROJECT ?= dayflow-agentic
REGION  ?= europe-west4

# Harness (PLAN v2 §Harness): fake-wsp on E2E_PORT_BASE, local brain on BASE+1, fake-drive on BASE+2.
# Brain env: DAYFLOW_TOKEN=dev DAYFLOW_FAKE_CONNECTORS=1 DAYFLOW_FAKE_LOG=harness/out/<scene>-connectors.jsonl,
# DAYFLOW_BUCKET unset, DAYFLOW_PUBLIC_URL=http://127.0.0.1:BASE+1. Logs + pids in harness/out/.
E2E_PORT_BASE ?= 8099
SCENES ?= vault-sync lab team-ops courseware scaffold pitch-deck
E2E_SCENES = $(if $(SCENE),$(SCENE),$(SCENES))
E2E_REAL ?= 0

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
	  --set-env-vars DAYFLOW_PUBLIC_URL=https://dayflow-brain-lrqhed2z5a-ez.a.run.app,GOOGLE_GENAI_USE_ENTERPRISE=1,GOOGLE_CLOUD_PROJECT=$(PROJECT),GOOGLE_CLOUD_LOCATION=global,DAYFLOW_FIRESTORE=1,OIDC_AUDIENCE=https://dayflow-brain-lrqhed2z5a-ez.a.run.app,PUBSUB_PUSH_SA=226180967155-compute@developer.gserviceaccount.com,CRON_INVOKER_SA=226180967155-compute@developer.gserviceaccount.com \
	  --set-secrets DAYFLOW_TOKEN=dayflow-token:latest

extension-build:
	cd extension && pnpm build

fake-wsp:
	FAKE_WSP_PORT=$(E2E_PORT_BASE) node harness/serve.mjs

fake-drive:
	FAKE_DRIVE_PORT=$$(( $(E2E_PORT_BASE) + 2 )) node harness/fake-drive.mjs

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
