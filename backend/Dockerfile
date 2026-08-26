# One image, three runtimes: `dayflow.api` (brain), `dayflow.workers`, `dayflow.scheduler`.
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-install-project --no-dev
COPY . .
RUN uv sync --locked --no-dev \
    && adduser --disabled-password --gecos "" app && chown -R app:app /app
USER app
ENV PATH="/app/.venv/bin:$PATH" PORT=8080
ENTRYPOINT ["python", "-m"]
CMD ["dayflow.api"]
