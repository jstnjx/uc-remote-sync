FROM node:22-alpine
ENV NODE_ENV=production \
    UC_CONFIG_HOME=/config \
    STATE_DIRECTORY=/data \
    UC_INTEGRATION_HTTP_PORT=11082
WORKDIR /app
COPY driver.json remote-sync.png package.json ./
COPY src ./src
COPY tools/healthcheck.js ./tools/healthcheck.js
RUN mkdir -p /config /data
VOLUME ["/config", "/data"]
EXPOSE 11081 11082
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD ["node", "tools/healthcheck.js"]
ENTRYPOINT ["node", "src/driver.js"]
