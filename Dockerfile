FROM node:22-alpine

# git is used (read-only) to report branch / dirty state / recent commits for each repo
RUN apk add --no-cache git tini

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=7070 \
    DATA_DIR=/data \
    REPOS_DIR=/repos \
    NODE_NO_WARNINGS=1

VOLUME ["/data"]
EXPOSE 7070

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7070/healthz >/dev/null || exit 1

# tini reaps zombie git processes and forwards signals
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
