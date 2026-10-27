FROM node:24-alpine

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
CMD ["node", "server.js"]
