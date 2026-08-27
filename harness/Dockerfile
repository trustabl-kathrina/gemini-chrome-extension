# The WSP replica portal a judge can run without any of our credentials (docs/JUDGES.md).
# Build context is harness/ — only serve.mjs and fake-wsp/ are needed; no npm install, no lock file.
#   docker build -t dayflow-wsp-replica harness
#   docker run --rm -p 8099:8080 dayflow-wsp-replica
# On Cloud Run, PORT is injected by the platform and the login gate is on (see `make replica-deploy`).
FROM node:22-alpine
WORKDIR /srv
COPY serve.mjs ./serve.mjs
COPY fake-wsp ./fake-wsp
ENV FAKE_WSP_HOST=0.0.0.0 FAKE_WSP_LOGIN=1 PORT=8080
EXPOSE 8080
USER node
CMD ["node", "serve.mjs"]
