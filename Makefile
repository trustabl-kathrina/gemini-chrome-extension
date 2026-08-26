.PHONY: verify verify-backend verify-extension dev-brain dev-extension deploy-brain

PROJECT ?= dayflow-agentic
REGION  ?= europe-west4

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
