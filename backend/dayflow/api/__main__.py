import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("dayflow.api.app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")), log_level="info")
