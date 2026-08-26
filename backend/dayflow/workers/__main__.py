"""Worker runtime: Pub/Sub push target. Same image as the brain, different entrypoint."""

import os

import uvicorn
from fastapi import FastAPI

from dayflow.api.pubsub import router as pubsub_router

app = FastAPI(title="Dayflow worker")
app.include_router(pubsub_router)


@app.get("/health")
async def healthz() -> dict[str, bool]:
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
